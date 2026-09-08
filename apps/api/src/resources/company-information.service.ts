import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { marketDate } from '../watchlist-groups/watchlist-group-observations';
import { SourceCheckpointEntity } from '@orsem/database';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

const json = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
};
type AddressCompany = {
  id: string;
  market: string;
  stockCode: string | null;
  ticker: string | null;
  isListed?: boolean;
};
export interface Field {
  key: string;
  label: string;
  value: string | null;
  unit: string | null;
  basis: string;
  source: string;
  sourceUrl: string;
  observedAt: string | null;
}

export function nextMonthlySelectionAt(month: unknown): string | null {
  if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) return null;
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year!, value!, 1) - 9 * 60 * 60_000).toISOString();
}

@Injectable()
export class CompanyInformationApiService {
  constructor(
    private readonly database: DatabaseRuntimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly fixtures: FixtureStoreService,
  ) {}
  async resolveId(value: string): Promise<string> {
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) return value;
    const symbol = value.toUpperCase();
    if (
      !/^(?:(?:KRX|KOSPI|KOSDAQ|KONEX|NASDAQ|NYSE|AMEX|OTC):)?[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(
        symbol,
      )
    )
      throw new BadRequestException('종목번호 또는 티커를 확인해 주세요.');
    const [exchange, code] = symbol.includes(':') ? symbol.split(':') : [null, symbol];
    const rows: AddressCompany[] = this.config.fixtureMode
      ? this.fixtures.companies.filter(
          (c) =>
            (c.stockCode === code || c.ticker === code) && (!exchange || c.market === exchange),
        )
      : await this.database
          .requireDataSource()
          .query(
            `SELECT id,market,stock_code stockCode,ticker,is_listed isListed FROM companies WHERE ((stock_code=? AND market IN ('KRX','KOSPI','KOSDAQ','KONEX')) OR (ticker=? AND market IN ('NASDAQ','NYSE','AMEX','OTC'))) ${exchange ? 'AND market=?' : ''} ORDER BY is_listed DESC LIMIT 2`,
            exchange ? [code, code, exchange] : [code, code],
          );
    if (!rows.length) throw new NotFoundException('종목을 찾을 수 없습니다.');
    if (rows.length > 1)
      throw new ConflictException(
        '같은 티커의 종목이 여러 개입니다. 거래소:티커 주소를 사용해 주세요.',
      );
    const paths = await this.canonicalPaths(rows);
    if (paths.get(rows[0]!.id) === `/companies/${rows[0]!.id}`)
      throw new ConflictException(
        '종목 코드의 소유 이력을 확인할 수 없습니다. 종목 목록에서 선택해 주세요.',
      );
    return rows[0]!.id;
  }

  async canonicalPaths(companies: AddressCompany[]) {
    const symbolFor = (company: AddressCompany) =>
      (['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market)
        ? company.stockCode
        : ['NASDAQ', 'NYSE', 'AMEX', 'OTC'].includes(company.market)
          ? company.ticker
          : null
      )?.toUpperCase();
    const symbols = [
      ...new Set(companies.map(symbolFor).filter((value): value is string => Boolean(value))),
    ];
    const slots = symbols.map(() => '?').join(',');
    const matches: AddressCompany[] = this.config.fixtureMode
      ? this.fixtures.companies
      : !symbols.length
        ? []
        : await this.database
            .requireDataSource()
            .query(
              `SELECT id,market,stock_code stockCode,ticker FROM companies WHERE stock_code IN (${slots}) OR ticker IN (${slots})`,
              [...symbols, ...symbols],
            );
    const reused: Array<{ exchange: string; symbol: string }> =
      this.config.fixtureMode || !symbols.length
        ? []
        : await this.database
            .requireDataSource()
            .query(
              `SELECT exchange,symbol FROM alpaca_assets WHERE symbol IN (${slots}) GROUP BY exchange,symbol HAVING COUNT(DISTINCT provider_asset_id)>1 OR COUNT(DISTINCT company_id)>1`,
              symbols,
            );
    return new Map(
      companies.map((company) => {
        const symbol = symbolFor(company);
        const same = matches.filter((row) => symbolFor(row) === symbol);
        const sameMarket = same.filter((row) => row.market === company.market);
        const safe =
          Boolean(company.isListed) &&
          !reused.some((row) => row.exchange === company.market && row.symbol === symbol) &&
          symbol &&
          /^[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(symbol);
        const address =
          safe && same.length === 1 && same[0]?.id === company.id
            ? symbol
            : safe && sameMarket.length === 1 && sameMarket[0]?.id === company.id
              ? `${company.market}:${symbol}`
              : company.id;
        return [company.id, `/companies/${address}`];
      }),
    );
  }
  async quotes(ids: string[]) {
    if (!ids.length || this.config.fixtureMode) return new Map();
    const db = this.database.requireDataSource();
    const slots = ids.map(() => '?').join(',');
    const [bars, caps] = await Promise.all([
      this.storedBars(ids, 2),
      db.query(
        `SELECT m.company_id companyId,m.market_cap marketCap,s.basis_date capBasisDate FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id JOIN market_cap_snapshots s ON s.id=m.snapshot_id WHERE m.company_id IN (${slots})`,
        ids,
      ),
    ]);
    return new Map(
      ids.map((id) => {
        const rows = bars.filter((row: { companyId: string }) => row.companyId === id);
        const latest = rows[0],
          previous = rows[1];
        const cap = caps.find((row: { companyId: string }) => row.companyId === id);
        return [
          id,
          {
            price: latest ? String(latest.close) : null,
            currency: latest?.currency ?? null,
            changePercent:
              latest && previous && Number(previous.close) > 0
                ? (Number(latest.close) / Number(previous.close) - 1) * 100
                : null,
            volume: latest ? String(latest.volume) : null,
            basisDate: latest?.sessionDate ?? null,
            referenceDate: previous?.sessionDate ?? null,
            observedAt: latest?.observedAt ?? null,
            source: latest?.source ?? null,
            marketCap: cap ? String(cap.marketCap) : null,
            capBasisDate: cap?.capBasisDate ?? null,
          },
        ];
      }),
    );
  }
  private async storedBars(ids: string[], limit: number) {
    return this.database.requireDataSource().query(
      `WITH sessions AS (
      SELECT b.*,ROW_NUMBER() OVER(PARTITION BY b.company_id,b.session_date ORDER BY b.bar_at DESC,b.id DESC) sessionRow
      FROM price_bars b JOIN companies c ON c.id=b.company_id
      WHERE b.company_id IN (${ids.map(() => '?').join(',')}) AND b.interval='1d' AND b.rights_mode='PRIVATE_DISPLAY_ONLY' AND b.close>0
      AND b.bar_at >= UTC_TIMESTAMP() - INTERVAL 366 DAY
      AND ((c.market IN ('KRX','KOSPI','KOSDAQ','KONEX') AND b.source='TOSS_KR' AND b.currency='KRW' AND b.session_date<?)
        OR (c.market IN ('NASDAQ','NYSE','AMEX','OTC') AND b.source='TOSS_US' AND b.currency='USD' AND b.session_date<?))
      ), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY session_date DESC) rn FROM sessions WHERE sessionRow=1)
      SELECT company_id companyId,open,high,low,close,volume,currency,source,session_date sessionDate,bar_at barAt,observed_at observedAt FROM ranked WHERE rn<=? ORDER BY company_id,session_date DESC`,
      [...ids, marketDate(new Date()), marketDate(new Date(), 'us'), limit],
    );
  }
  async selection() {
    const states = this.config.fixtureMode
      ? []
      : await this.database
          .requireDataSource()
          .query(
            `SELECT st.region,st.status,st.reason,st.last_attempt_at lastAttemptAt,st.last_success_at lastSuccessAt,s.basis_date basisDate,s.source_url sourceUrl,s.id snapshotId,s.raw_json metadata FROM market_selection_state st LEFT JOIN market_cap_snapshots s ON s.id=st.active_snapshot_id AND s.region=st.region`,
          );
    const regions = [];
    for (const region of ['kr', 'us'] as const) {
      const state = states.find((r: { region: string }) => r.region === region);
      const metadata = json(state?.metadata);
      const selectionMonth =
        nextMonthlySelectionAt(metadata.selectionMonth) !== null
          ? (metadata.selectionMonth as string)
          : null;
      const items: Array<
        AddressCompany & { rank: number; marketCap: string; nameKo: string; nameEn: string | null }
      > = state?.snapshotId
        ? await this.database
            .requireDataSource()
            .query(
              'SELECT m.rank_no AS `rank`,m.market_cap marketCap,c.id,c.name_ko nameKo,c.name_en nameEn,c.stock_code stockCode,c.ticker,c.market,c.is_listed isListed FROM market_cap_memberships m JOIN companies c ON c.id=m.company_id WHERE m.snapshot_id=? AND m.rank_no BETWEEN 1 AND 20 ORDER BY m.rank_no',
              [state.snapshotId],
            )
        : [];
      const paths = await this.canonicalPaths(items);
      regions.push({
        region,
        status: state?.status ?? 'UNCONFIGURED',
        reason: state ? state.reason : '월간 시가총액 상위 종목 자료 연결 대기',
        basisDate: state?.basisDate ?? null,
        observedAt: state?.lastSuccessAt ?? null,
        sourceUrl: state?.sourceUrl ?? null,
        sourceName:
          typeof metadata.sourceName === 'string'
            ? metadata.sourceName
            : state?.sourceUrl?.includes('data.go.kr')
              ? '금융위원회'
              : null,
        currency: region === 'kr' ? 'KRW' : 'USD',
        providerScope: typeof metadata.providerScope === 'string' ? metadata.providerScope : null,
        selectionMonth,
        refreshCadence: 'MONTHLY' as const,
        nextRefreshAt: nextMonthlySelectionAt(selectionMonth),
        updateNote: '매월 1일 새 목록 확인 · 자료 검증 실패 시 마지막 정상 목록 유지',
        items: items.map((item) => ({ ...item, canonicalPath: paths.get(item.id) })),
      });
    }
    return { asOf: new Date().toISOString(), regions };
  }
  async company(id: string) {
    if (this.config.fixtureMode)
      return { asOf: new Date().toISOString(), fields: [], status: 'PENDING' };
    const db = this.database.requireDataSource();
    const [company] = await db.query(
      'SELECT id,corp_code corpCode,cik,market FROM companies WHERE id=?',
      [id],
    );
    if (!company) throw new NotFoundException('기업을 찾을 수 없습니다.');
    const [snapshots, bars, stockRows, capRows] = await Promise.all([
      db.query(
        'SELECT fields_json fields,observed_at observedAt FROM company_information_snapshots WHERE company_id=? ORDER BY observed_at DESC LIMIT 1',
        [id],
      ),
      this.storedBars([id], 366),
      db.query(
        "SELECT metadata_json metadata,last_success_at observedAt FROM source_checkpoints WHERE connector='TOSS' AND stream=? LIMIT 1",
        [`STOCK_INFO:${id}`],
      ),
      db.query(
        'SELECT m.market_cap marketCap,s.basis_date basisDate,s.observed_at observedAt,s.source_url sourceUrl,s.raw_json metadata FROM market_cap_memberships m JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id JOIN market_cap_snapshots s ON s.id=m.snapshot_id WHERE m.company_id=? LIMIT 1',
        [id],
      ),
    ]);
    if (company.corpCode || ['NASDAQ', 'NYSE', 'AMEX', 'OTC'].includes(company.market))
      await db
        .getRepository(SourceCheckpointEntity)
        .createQueryBuilder()
        .insert()
        .values({
          connector: 'COMPANY_INFORMATION',
          stream: id,
          lastSuccessDate: null,
          cursor: null,
          lastSuccessAt: null,
          metadataJson: { requestedAt: new Date().toISOString() },
        })
        .orIgnore()
        .execute();
    const snapshot = snapshots[0];
    const stock = json(json(stockRows[0]?.metadata).rawPayload);
    const latest = bars[0];
    const fields: Field[] = (
      Array.isArray(snapshot?.fields)
        ? snapshot.fields
        : typeof snapshot?.fields === 'string'
          ? JSON.parse(snapshot.fields)
          : []
    ) as Field[];
    const observed = latest?.observedAt ? new Date(latest.observedAt).toISOString() : null;
    const priceBasis = latest
      ? `${latest.sessionDate ?? new Date(latest.barAt).toISOString()} 일별 종가`
      : '저장된 일별 시세 확인 대기';
    const push = (
      key: string,
      label: string,
      value: string | null,
      unit: string | null,
      basis: string,
      source = 'Toss',
      sourceUrl = 'https://openapi.tossinvest.com/',
      observedAt = observed,
    ) => fields.push({ key, label, value, unit, basis, source, sourceUrl, observedAt });
    push(
      'close',
      '최근 종가',
      latest ? String(latest.close) : null,
      latest?.currency ?? null,
      priceBasis,
    );
    for (const [key, label] of [
      ['open', '시가'],
      ['high', '고가'],
      ['low', '저가'],
    ] as const)
      push(
        key,
        label,
        latest?.[key] != null ? String(latest[key]) : null,
        latest?.currency ?? null,
        priceBasis.replace('일별 종가', '일별 시세'),
      );
    push(
      'previousClose',
      '전 거래일 종가',
      bars[1] ? String(bars[1].close) : null,
      latest?.currency ?? null,
      bars[1] ? `${bars[1].sessionDate} 일별 종가` : '전 거래일 자료 확인 대기',
    );
    push('volume', '거래량', latest ? String(latest.volume) : null, '주', priceBasis);
    // A partial collected window must never be labelled a full 52-week range.
    const oldest = bars.at(-1);
    const coverage = oldest ? (Date.now() - new Date(oldest.barAt).getTime()) / 86_400_000 : 0;
    const enough = coverage >= 350 && bars.length >= 200;
    const highs = bars
      .map((bar: { high: string }) => Number(bar.high))
      .filter((value: number) => Number.isFinite(value) && value > 0);
    const lows = bars
      .map((bar: { low: string }) => Number(bar.low))
      .filter((value: number) => Number.isFinite(value) && value > 0);
    push(
      'range52w',
      '52주 내 수집 범위',
      enough && highs.length && lows.length ? `${Math.min(...lows)}–${Math.max(...highs)}` : null,
      latest?.currency ?? null,
      enough
        ? `수집된 일별 저가–고가 · ${priceBasis}`
        : `52주 이력 부족 · 수집 ${bars.length}거래일`,
    );
    const cap = capRows[0];
    const capMetadata = json(cap?.metadata);
    push(
      'marketCap',
      '시가총액',
      cap ? String(cap.marketCap) : null,
      ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market) ? 'KRW' : 'USD',
      cap?.basisDate
        ? `${cap.basisDate} · ${typeof capMetadata.method === 'string' ? capMetadata.method : '종가 × 상장주식수'}`
        : '공식 기준일 자료 확인 대기',
      typeof capMetadata.sourceName === 'string'
        ? capMetadata.sourceName
        : cap?.sourceUrl?.includes('data.go.kr')
          ? '금융위원회'
          : '시총 자료 연결 대기',
      cap?.sourceUrl ??
        (company.corpCode
          ? 'https://www.data.go.kr/data/15094808/openapi.do'
          : 'https://www.sec.gov/edgar/search/'),
      cap?.observedAt ? new Date(cap.observedAt).toISOString() : null,
    );
    for (const [key, label, property] of [
      ['isin', 'ISIN', 'isinCode'],
      ['listed', '상장일', 'listDate'],
      ['shares', '발행주식수', 'sharesOutstanding'],
      ['security', '주식 종류', 'securityType'],
    ] as const)
      push(
        key,
        label,
        typeof stock[property] === 'string' ? (stock[property] as string) : null,
        key === 'shares' ? '주' : null,
        '기업정보 조회 시점',
        'Toss',
        'https://openapi.tossinvest.com/',
        stockRows[0]?.observedAt ? new Date(stockRows[0].observedAt).toISOString() : null,
      );
    const annualEps = fields.find((field) => field.key === 'eps' && field.basis.includes('연간'));
    const close = Number(latest?.close);
    const ratio = (field: Field | undefined) => {
      const value = Number(field?.value);
      return field?.value &&
        ['KRW', 'USD'].includes(field.unit ?? '') &&
        field.unit === latest?.currency &&
        Number.isFinite(value) &&
        value > 0 &&
        Number.isFinite(close) &&
        close > 0 &&
        Number.isFinite(close / value) &&
        stock.isCommonShare === true &&
        stock.securityType === 'STOCK'
        ? (close / value).toFixed(2)
        : null;
    };
    push(
      'per',
      'PER',
      ratio(annualEps),
      '배',
      annualEps?.value ? `${priceBasis} ÷ ${annualEps.basis}` : '검증된 연간 보통주 EPS 확인 대기',
      '공시·시세 계산',
    );
    const bps = fields.find((field) => field.key === 'bps');
    push(
      'pbr',
      'PBR',
      ratio(bps),
      '배',
      bps?.value ? `${priceBasis} ÷ ${bps.basis}` : '보통주 귀속자본·BPS 기준 확인 대기',
      '공시·시세 계산',
    );
    for (const [key, label] of [
      ['ceo', '대표자'],
      ['industry', '업종'],
      ['revenue', '매출액'],
      ['operatingProfit', '영업이익'],
      ['netIncome', '당기순이익'],
      ['eps', 'EPS'],
      ['dividend', '주당 현금배당'],
    ] as const)
      if (!fields.some((field) => field.key === key))
        push(
          key,
          label,
          null,
          null,
          '확인된 보고서 자료 없음',
          company.corpCode ? 'OpenDART' : 'SEC',
          company.corpCode ? 'https://opendart.fss.or.kr/' : 'https://www.sec.gov/edgar/search/',
          null,
        );
    return { asOf: new Date().toISOString(), fields, status: snapshot ? 'AVAILABLE' : 'PENDING' };
  }
}
