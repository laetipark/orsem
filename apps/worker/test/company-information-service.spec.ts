import 'reflect-metadata';
import type { DataSource } from 'typeorm';
import type { ConnectorHealthService } from '../src/connectors/connector-health.service';
import type { OpenDartClient } from '../src/opendart/opendart.client';
import type { FinancialRaw, InformationField } from '../src/market-data/company-information';
import { CompanyInformationService } from '../src/market-data/company-information.service';

const NOW = new Date('2026-09-07T10:00:00.000Z');
const COMPANY = { id: '11111111-1111-4111-a111-111111111111', corpCode: '00123456' };

function report(year: number, code: string, eps: string[], equity: string): FinancialRaw {
  const annual = code === '11011';
  const end = `${year}-${annual ? '12-31' : '06-30'}`;
  const receipt = annual ? '20260315000001' : '20260814000001';
  const common = {
    corp_code: COMPANY.corpCode,
    bsns_year: String(year),
    reprt_code: code,
    fs_div: 'CFS',
    currency: 'KRW',
    rcept_no: receipt,
  };
  return {
    statement: 'CFS',
    profile: { acc_mt: '12' },
    financials: {
      list: [
        {
          ...common,
          sj_div: 'BS',
          account_id: 'ifrs-full_EquityAttributableToOwnersOfParent',
          account_nm: '지배기업 소유주지분',
          thstrm_amount: equity,
          thstrm_dt: end,
        },
        ...eps.map((amount) => ({
          ...common,
          sj_div: 'IS',
          account_id: 'ifrs-full_BasicEarningsLossPerShare',
          account_nm: '기본주당이익',
          thstrm_amount: amount,
        })),
      ],
    },
    dividends: { list: [] },
    shares: {
      list: [
        {
          corp_code: COMPANY.corpCode,
          rcept_no: receipt,
          se: '보통주',
          stlm_dt: end,
          istc_totqy: '100',
          tesstk_co: '20',
          distb_stock_co: '80',
        },
      ],
    },
  };
}

function setup(annual: FinancialRaw, recent: FinancialRaw) {
  const previousFields = [
    {
      key: 'eps',
      label: 'EPS',
      value: '100',
      unit: 'KRW',
      basis: '2024년 연간 · 공시된 보통주 주당순이익',
      source: 'OpenDART',
      sourceUrl: 'https://opendart.fss.or.kr/',
      observedAt: '2025-04-01T00:00:00.000Z',
    },
    {
      key: 'bps',
      label: 'BPS',
      value: '200',
      unit: 'KRW',
      basis: '2024년 연간',
      source: 'OpenDART',
      sourceUrl: 'https://opendart.fss.or.kr/',
      observedAt: '2025-04-01T00:00:00.000Z',
    },
  ];
  const inserts: unknown[][] = [];
  const repository = { upsert: jest.fn(async () => undefined) };
  const runner = {
    connect: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.startsWith('SELECT GET_LOCK')) return [{ acquired: 1 }];
      if (sql.startsWith('SELECT c.id,c.corp_code')) return [COMPANY];
      if (sql.startsWith('SELECT fields_json fields'))
        return [{ fields: JSON.stringify(previousFields) }];
      if (sql.startsWith('INSERT INTO company_information_snapshots')) inserts.push(parameters);
      return [];
    }),
  };
  const source = { createQueryRunner: () => runner, getRepository: () => repository };
  const dart = {
    enabled: true,
    companyInformation: jest.fn(async (_corp: string, _year: number, code: string) =>
      code === '11011' ? annual : recent,
    ),
  };
  const health = { openDartPausedUntil: jest.fn(async () => null) };
  const service = new CompanyInformationService(
    source as unknown as DataSource,
    dart as unknown as OpenDartClient,
    health as unknown as ConnectorHealthService,
  );
  return {
    service,
    dart,
    runner,
    repository,
    inserts,
    fields: () => JSON.parse(String(inserts[0]?.[9])) as InformationField[],
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

it.each([
  { reason: 'conflicting current annual EPS', eps: ['10', '20'] },
  { reason: 'missing current annual EPS', eps: [] },
])('does not resurrect legacy EPS or BPS after revalidation: $reason', async ({ eps }) => {
  const annual = report(2025, '11011', eps, '800');
  const recent = report(2026, '11012', ['999'], '1720');
  // The latest quarter has no verifiable same-period common share count.
  recent.shares = null;
  const { service, fields, inserts, repository } = setup(annual, recent);
  await service.refresh();
  expect(inserts).toHaveLength(1);
  expect(repository.upsert).not.toHaveBeenCalled();
  expect(fields().find((field) => field.key === 'eps')).toMatchObject({
    value: null,
    basis: expect.stringContaining('2025년 연간'),
    observedAt: NOW.toISOString(),
  });
  expect(fields().find((field) => field.key === 'bps')).toMatchObject({
    value: null,
    basis: expect.stringContaining('2026년 반기'),
    observedAt: NOW.toISOString(),
  });
  expect(JSON.parse(String(inserts[0]?.[10]))).toMatchObject({
    normalizationVersion: 2,
    annual,
    recent,
  });
  await service.onApplicationShutdown();
});

it('combines only the validated annual EPS and latest quarter BPS with their separate report provenance', async () => {
  const annual = report(2025, '11011', ['3.5'], '800');
  const recent = report(2026, '11012', ['999'], '1720');
  const { service, dart, fields, inserts, runner } = setup(annual, recent);
  await service.refresh();
  expect(dart.companyInformation).toHaveBeenNthCalledWith(1, COMPANY.corpCode, 2025, '11011');
  expect(dart.companyInformation).toHaveBeenNthCalledWith(2, COMPANY.corpCode, 2026, '11012');
  expect(inserts).toHaveLength(1);
  expect(inserts[0]?.slice(1, 6)).toEqual([COMPANY.id, 'OPENDART', 2026, '11012', null]);
  const eps = fields().filter((field) => field.key === 'eps');
  const bps = fields().filter((field) => field.key === 'bps');
  expect(eps).toHaveLength(1);
  expect(bps).toHaveLength(1);
  expect(eps[0]).toMatchObject({
    value: '3.5',
    unit: 'KRW',
    basis: expect.stringContaining('2025년 연간'),
    sourceUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260315000001',
  });
  expect(bps[0]).toMatchObject({
    value: '21.5',
    unit: 'KRW',
    basis: expect.stringContaining('2026년 반기'),
    sourceUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260814000001',
  });
  expect(bps[0]?.basis).toContain('2026-06-30');
  expect(runner.release).toHaveBeenCalledTimes(1);
  await service.onApplicationShutdown();
});
