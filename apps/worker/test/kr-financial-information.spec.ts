import { OpenDartApiError } from '@orsem/opendart-parser';
import { loadWorkerConfig } from '../src/config/worker-config';
import { financialFields, type FinancialRaw } from '../src/market-data/company-information';
import { OpenDartClient } from '../src/opendart/opendart.client';

type Row = Record<string, unknown>;
const observedAt = '2026-09-07T12:00:00Z';
const receipt = '20260316000001';
const metadata = {
  rcept_no: receipt,
  corp_code: '00000001',
  bsns_year: '2025',
  reprt_code: '11011',
};
const epsRow = (overrides: Row = {}): Row => ({
  ...metadata,
  sj_div: 'IS',
  account_id: 'ifrs-full_BasicEarningsLossPerShare',
  account_nm: '기본주당이익',
  currency: 'KRW',
  thstrm_amount: '6,605',
  ...overrides,
});
const equityRow = (overrides: Row = {}): Row => ({
  ...metadata,
  sj_div: 'BS',
  account_id: 'ifrs-full_EquityAttributableToOwnersOfParent',
  account_nm: '지배기업 소유주지분',
  currency: 'KRW',
  thstrm_amount: '9,000',
  ...overrides,
});
const shareRow = (overrides: Row = {}): Row => ({
  rcept_no: receipt,
  corp_code: '00000001',
  se: '보통주',
  istc_totqy: '100',
  tesstk_co: '10',
  distb_stock_co: '90',
  stlm_dt: '2025-12-31',
  ...overrides,
});
const raw = (overrides: Partial<FinancialRaw> = {}): FinancialRaw => ({
  profile: { acc_mt: '12' },
  financials: { list: [epsRow(), equityRow()] },
  dividends: null,
  shares: { list: [shareRow(), shareRow({ se: '합계' })] },
  statement: 'CFS',
  ...overrides,
});
const field = (input: FinancialRaw, key: string, year = 2025, report = '11011') =>
  financialFields(input, year, report, observedAt).find((value) => value.key === key)!;

describe('Korean disclosed per-share financial fields', () => {
  it.each(['6,605', '62,044', '13,009'])(
    'uses annual basic EPS %s even when the dividend row has an unspecified share class',
    (amount) => {
      const result = field(
        raw({
          financials: { list: [epsRow({ thstrm_amount: amount })] },
          dividends: { list: [{ se: '(연결)주당순이익(원)', stock_knd: '-', thstrm: '999' }] },
        }),
        'eps',
      );
      expect(result).toMatchObject({
        value: amount.replaceAll(',', ''),
        unit: 'KRW',
        source: 'OpenDART',
        sourceUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`,
        observedAt,
      });
      expect(result.basis).toContain('2025년 연간 · 연결');
      expect(result.basis).toContain('IFRS 기본 EPS');
    },
  );
  it('accepts matching IS/CIS duplicate values and preserves negative basic EPS', () => {
    expect(
      field(
        raw({
          financials: { list: [epsRow(), epsRow({ sj_div: 'CIS', thstrm_amount: '6605.00' })] },
        }),
        'eps',
      ).value,
    ).toBe('6605');
    expect(
      field(
        raw({
          statement: 'OFS',
          financials: { list: [epsRow({ fs_div: 'OFS', sj_div: 'CIS', thstrm_amount: '-2,300' })] },
        }),
        'eps',
      ).value,
    ).toBe('-2300');
  });
  it('rejects conflicting standard EPS without hiding the conflict behind a dividend fallback', () => {
    const result = field(
      raw({
        financials: { list: [epsRow(), epsRow({ sj_div: 'CIS', thstrm_amount: '7000' })] },
        dividends: { list: [{ se: '(연결)주당순이익(원)', stock_knd: '보통주', thstrm: '8000' }] },
      }),
      'eps',
    );
    expect(result.value).toBeNull();
    expect(result.basis).toContain('중복값');
  });
  it.each([
    { sj_div: 'SCE' },
    { currency: 'USD' },
    { account_id: 'ifrs-full_DilutedEarningsLossPerShare' },
    { account_nm: '우선주 기본주당이익' },
    { account_detail: 'Preferred shares [member]' },
    { fs_div: 'OFS' },
    { bsns_year: '2024' },
    { reprt_code: '11012' },
    { thstrm_amount: '6,60' },
  ])('does not use an ineligible EPS row %j', (overrides) => {
    expect(field(raw({ financials: { list: [epsRow(overrides)] } }), 'eps').value).toBeNull();
  });
  it('uses only an explicit common-share dividend EPS fallback for the selected statement', () => {
    const dividends = {
      list: [
        { se: '(별도)주당순이익(원)', stock_knd: '보통주', thstrm: '100' },
        { se: '(연결)주당순이익(원)', stock_knd: '-', thstrm: '200' },
        { se: '(연결)주당순이익(원)', stock_knd: '우선주', thstrm: '300' },
        { ...metadata, se: '(연결)주당순이익(원)', stock_knd: '보통주', thstrm: '400' },
      ],
    };
    expect(field(raw({ financials: null, dividends }), 'eps')).toMatchObject({
      value: '400',
      sourceUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`,
    });
  });
  it('never replaces an annual EPS with an interim or cumulative EPS', () => {
    expect(
      field(
        raw({
          financials: {
            list: [
              epsRow({
                bsns_year: '2026',
                reprt_code: '11012',
                thstrm_amount: '2000',
                thstrm_add_amount: '4500',
              }),
            ],
          },
          dividends: { list: [{ se: '주당순이익(원)', stock_knd: '보통주', thstrm: '4500' }] },
        }),
        'eps',
        2026,
        '11012',
      ).value,
    ).toBeNull();
  });
  it('calculates BPS from parent equity and same-report shares excluding treasury stock', () => {
    const input = raw({
      financials: {
        list: [equityRow(), equityRow({ account_id: 'ifrs-full_Equity', thstrm_amount: '12000' })],
      },
    });
    const before = structuredClone(input);
    const bps = field(input, 'bps');
    expect(bps).toMatchObject({
      value: '100',
      unit: 'KRW',
      sourceUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`,
      observedAt,
    });
    expect(bps.basis).toContain('2025-12-31 기말');
    expect(bps.basis).toContain('지배기업 소유주지분 / 보통주 유통주식수 90주(자기주식 제외)');
    expect(input).toEqual(before);
  });
  it('uses total equity only for separate statements and never includes minority equity in consolidated BPS', () => {
    const financials = { list: [equityRow({ account_id: 'ifrs-full_Equity' })] };
    expect(field(raw({ statement: 'OFS', financials }), 'bps').value).toBe('100');
    expect(field(raw({ financials }), 'bps').value).toBeNull();
  });
  it('keeps integer precision above the JavaScript safe-integer range and rounds only the final BPS', () => {
    expect(
      field(
        raw({
          financials: { list: [equityRow({ thstrm_amount: '9,007,199,254,740,993' })] },
          shares: { list: [shareRow({ istc_totqy: '3', tesstk_co: '0', distb_stock_co: '3' })] },
        }),
        'bps',
      ).value,
    ).toBe('3002399751580331');
    expect(
      field(
        raw({
          financials: { list: [equityRow({ thstrm_amount: '-100' })] },
          shares: { list: [shareRow({ istc_totqy: '3', tesstk_co: '0', distb_stock_co: '3' })] },
        }),
        'bps',
      ).value,
    ).toBe('-33.333333');
  });
  it.each([
    { se: '우선주', istc_totqy: '5', tesstk_co: '0', distb_stock_co: '5' },
    { se: '제2종보통주', istc_totqy: '5', tesstk_co: '0', distb_stock_co: '5' },
    { se: '우선주', istc_totqy: '-', tesstk_co: '-', distb_stock_co: '-' },
  ])('withholds BPS when another issued class has unallocated rights %j', (other) => {
    const bps = field(raw({ shares: { list: [shareRow(), shareRow(other)] } }), 'bps');
    expect(bps.value).toBeNull();
    expect(bps.basis).toContain('자본 배분');
  });
  it('allows explicitly zero issued shares in an unused preferred class', () => {
    expect(
      field(
        raw({
          shares: {
            list: [
              shareRow(),
              shareRow({ se: '우선주', istc_totqy: '0', tesstk_co: '0', distb_stock_co: '0' }),
              shareRow({ se: '합계' }),
            ],
          },
        }),
        'bps',
      ).value,
    ).toBe('100');
  });
  it('treats a dash-only unused class as unissued only when the aggregate proves no additional shares', () => {
    const preferred = shareRow({
      se: '우선주',
      istc_totqy: '-',
      tesstk_co: '-',
      distb_stock_co: '-',
    });
    expect(
      field(raw({ shares: { list: [shareRow(), preferred, shareRow({ se: '합계' })] } }), 'bps')
        .value,
    ).toBe('100');
    expect(
      field(
        raw({
          shares: {
            list: [
              shareRow(),
              preferred,
              shareRow({ se: '합계', istc_totqy: '105', distb_stock_co: '95' }),
            ],
          },
        }),
        'bps',
      ).value,
    ).toBeNull();
    expect(field(raw({ shares: { list: [shareRow(), preferred] } }), 'bps').value).toBeNull();
  });
  it('rejects unnamed stock classes and totals with mismatched provenance', () => {
    expect(
      field(raw({ shares: { list: [shareRow(), shareRow({ se: null })] } }), 'bps').value,
    ).toBeNull();
    expect(
      field(
        raw({ shares: { list: [shareRow(), shareRow({ se: '합계', stlm_dt: '2024-12-31' })] } }),
        'bps',
      ).value,
    ).toBeNull();
  });
  it.each([
    { distb_stock_co: '91' },
    { tesstk_co: '-1' },
    { distb_stock_co: '0', tesstk_co: '100' },
    { distb_stock_co: '9,0' },
    { distb_stock_co: 'NaN' },
    { istc_totqy: '100.5' },
    { stlm_dt: '2024-12-31' },
    { stlm_dt: '2025-02-30' },
    { rcept_no: '20260317000001' },
    { corp_code: '00000002' },
  ])('withholds BPS for invalid counts or mismatched provenance %j', (overrides) => {
    expect(field(raw({ shares: { list: [shareRow(overrides)] } }), 'bps').value).toBeNull();
  });
  it('rejects a mismatched share total and conflicting or non-KRW equity', () => {
    expect(
      field(
        raw({ shares: { list: [shareRow(), shareRow({ se: '합계', distb_stock_co: '95' })] } }),
        'bps',
      ).value,
    ).toBeNull();
    expect(
      field(
        raw({ financials: { list: [equityRow(), equityRow({ thstrm_amount: '9100' })] } }),
        'bps',
      ).value,
    ).toBeNull();
    expect(
      field(raw({ financials: { list: [equityRow({ currency: 'USD' })] } }), 'bps').value,
    ).toBeNull();
  });
  it('requires an explicit balance-sheet date for a non-December fiscal year', () => {
    expect(field(raw({ profile: { acc_mt: '03' } }), 'bps').value).toBeNull();
    expect(
      field(
        raw({
          profile: { acc_mt: '03' },
          financials: { list: [equityRow({ thstrm_dt: '2025.03.31 현재' })] },
          shares: { list: [shareRow({ stlm_dt: '2025-03-31' })] },
        }),
        'bps',
      ).value,
    ).toBe('100');
  });
  it('accepts an explicit disclosed common-share BPS without allocating preferred-share capital', () => {
    const result = field(
      raw({
        financials: {
          list: [
            equityRow({
              account_id: '-표준계정코드 미사용-',
              account_nm: '(보통주) 주당순자산(원)',
              thstrm_amount: '7654.32',
            }),
          ],
        },
        shares: {
          list: [
            shareRow(),
            shareRow({ se: '우선주', istc_totqy: '5', tesstk_co: '0', distb_stock_co: '5' }),
          ],
        },
      }),
      'bps',
    );
    expect(result.value).toBe('7654.32');
    expect(result.basis).toContain('공시된 보통주');
  });
  it('keeps old callers compatible while emitting an explicit unavailable BPS field', () => {
    const input = raw();
    delete input.shares;
    expect(field(input, 'bps')).toMatchObject({ key: 'bps', value: null, unit: 'KRW' });
    expect(field(input, 'eps').value).toBe('6605');
  });
  it('pairs interim BPS only with the same quarter-end shares while keeping EPS annual', () => {
    const input = raw({
      financials: {
        list: [equityRow({ bsns_year: '2026', reprt_code: '11012', thstrm_amount: '18000' })],
      },
      shares: { list: [shareRow({ stlm_dt: '2026-06-30' })] },
    });
    expect(field(input, 'bps', 2026, '11012').value).toBe('200');
    expect(field(input, 'eps', 2026, '11012').value).toBeNull();
    expect(
      field({ ...input, shares: { list: [shareRow()] } }, 'bps', 2026, '11012').value,
    ).toBeNull();
  });
  it('rejects unknown statements and dividend EPS with unverified or foreign units', () => {
    expect(field(raw({ statement: 'UNKNOWN' }), 'bps').value).toBeNull();
    for (const se of ['주당순이익', '주당순이익(USD)', '주당순이익(천원)'])
      expect(
        field(
          raw({
            financials: null,
            dividends: { list: [{ se, stock_knd: '보통주', thstrm: '100' }] },
          }),
          'eps',
        ).value,
      ).toBeNull();
  });
});

describe('companyInformation share-source request', () => {
  const config = loadWorkerConfig({ OPENDART_API_KEY: 'x'.repeat(40), HTTP_TIMEOUT_MS: '5000' });
  it('requests stock totals with the same company, business year, and report code', async () => {
    const urls: URL[] = [];
    const client = new OpenDartClient(config, async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      urls.push(url);
      return new Response(
        JSON.stringify({
          status: '000',
          message: '정상',
          list: url.pathname.endsWith('/stockTotqySttus.json') ? [shareRow()] : [],
        }),
      );
    });
    const result = await client.companyInformation('00000001', 2025, '11011');
    expect(result.shares?.list).toEqual([shareRow()]);
    const url = urls.find((item) => item.pathname.endsWith('/stockTotqySttus.json'))!;
    expect(url.searchParams.get('corp_code')).toBe('00000001');
    expect(url.searchParams.get('bsns_year')).toBe('2025');
    expect(url.searchParams.get('reprt_code')).toBe('11011');
    expect(url.searchParams.has('fs_div')).toBe(false);
    expect(urls).toHaveLength(4);
  });
  it('returns null shares on no-data while retaining company financial results', async () => {
    const client = new OpenDartClient(config, async (input) => {
      const endpoint = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return new Response(
        JSON.stringify(
          endpoint.endsWith('/stockTotqySttus.json')
            ? { status: '013', message: '자료 없음' }
            : { status: '000', message: '정상', list: [epsRow()] },
        ),
      );
    });
    const result = await client.companyInformation('00000001', 2025, '11011');
    expect(result.shares).toBeNull();
    expect(result.financials?.list).toEqual([epsRow()]);
  });
  it('propagates share-source rate limiting through the existing connector policy', async () => {
    const client = new OpenDartClient(config, async (input) => {
      const endpoint = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      return new Response(
        JSON.stringify(
          endpoint.endsWith('/stockTotqySttus.json')
            ? { status: '020', message: '요청 제한' }
            : { status: '000', message: '정상', list: [] },
        ),
      );
    });
    await expect(client.companyInformation('00000001', 2025, '11011')).rejects.toBeInstanceOf(
      OpenDartApiError,
    );
  });
});
