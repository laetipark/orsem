import { TossMarketDataService } from './toss-market-data.service';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { DataSource } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { HTTP_FETCH, type FetchImplementation } from '../opendart/opendart.client';
import { TossMarketClient } from './toss-market.client';
import {
  validateFscRows,
  type FscStock,
  eligibleSelectionListings,
  MONTHLY_SELECTION_METHOD,
  SELECTION_MARKETS,
  selectMonthlyMarketLeaders,
  selectionMonth,
  shouldRefreshMonthlySelection,
  type SelectionRegion,
  type SelectionListing,
  type SelectionStock,
  type SelectionPrice,
  type MonthlySelectionCompany,
} from './market-selection';

const ENDPOINT =
  'https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo';

@Injectable()
export class MarketSelectionService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private flight: Promise<void> | null = null;
  private stopped = false;
  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly source: DataSource,
    private readonly toss: TossMarketClient,
    private readonly marketData: TossMarketDataService,
    @Inject(HTTP_FETCH) private readonly fetchImpl: FetchImplementation,
  ) {}
  onApplicationBootstrap() {
    if (this.config.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.refresh(), 5 * 60_000);
    this.timer.unref();
    void this.refresh();
  }
  async onApplicationShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.flight;
  }
  refresh() {
    if (!this.flight)
      this.flight = this.run()
        .catch(() => undefined)
        .finally(() => {
          this.flight = null;
        });
    return this.flight;
  }
  async fetchDate(basis: string): Promise<FscStock[]> {
    if (!this.config.fscApiKey) return [];
    const parser = new XMLParser({ parseTagValue: false, processEntities: false });
    const rows: FscStock[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 50; page++) {
      const url = new URL(ENDPOINT);
      url.search = new URLSearchParams({
        serviceKey: this.config.fscApiKey,
        basDt: basis,
        numOfRows: '2000',
        pageNo: String(page),
        resultType: 'xml',
      }).toString();
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('공식 시세 연결 실패');
      const body = await response.text();
      if (body.length > 16_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(body))
        throw new Error('시세 응답 검증 실패');
      const parsed = parser.parse(body)?.response;
      if (!['00', '0000', '0'].includes(String(parsed?.header?.resultCode)))
        throw new Error('공식 시세 응답 오류');
      const next = parsed.body;
      const count = Number(next?.totalCount);
      if (
        !Number.isInteger(count) ||
        count < 0 ||
        count > 100_000 ||
        Number(next?.pageNo) !== page ||
        (total !== null && total !== count)
      )
        throw new Error('시세 페이지 검증 실패');
      total = count;
      if (!count && page === 1) return [];
      const values = next?.items?.item;
      const items: FscStock[] = Array.isArray(values) ? values : values ? [values] : [];
      if (!items.length) throw new Error('시세 페이지 누락');
      rows.push(...items);
      if (rows.length >= count) {
        validateFscRows(rows, basis, count);
        return rows;
      }
    }
    throw new Error('시세 페이지 한도 초과');
  }
  /** Read-only: the same complete source acquisition used by the monthly publisher. */
  async collect(region: SelectionRegion, now = new Date()) {
    if (!this.toss.enabled) throw new Error('공식 시세 연결 설정 대기');
    const listings: SelectionListing[] = [];
    for (const market of SELECTION_MARKETS[region]) {
      const rows = await this.toss.stocksAll(market, { status: 'ACTIVE' });
      if (rows.length < 100 && market !== 'KR_ETC') throw new Error('전체 시장 응답 누락');
      listings.push(...rows.map((row) => ({ ...row, requestedMarket: market })));
    }
    const eligible = eligibleSelectionListings(listings);
    const stocks: SelectionStock[] = [],
      prices: SelectionPrice[] = [];
    for (let index = 0; index < eligible.length; index += 200) {
      if (this.stopped) throw new Error('수집 중지');
      const symbols = eligible.slice(index, index + 200).map((row) => row.symbol);
      stocks.push(...((await this.toss.stocks(symbols)) as unknown as SelectionStock[]));
      prices.push(...(await this.toss.prices(symbols)));
    }
    const companies: MonthlySelectionCompany[] = await this.source.query(
      'SELECT id,stock_code stockCode,ticker,corp_code corpCode,cik,market FROM companies WHERE is_listed=1',
    );
    const observedAt = new Date();
    const selected = selectMonthlyMarketLeaders({
      region,
      listings,
      stocks,
      prices,
      companies,
      observedAt,
    });
    if (selectionMonth(now) !== selectionMonth(observedAt)) throw new Error('수집 중 기준 월 변경');
    const priceDates = selected.leaders.flatMap((row) =>
      row.components.map((part) =>
        new Intl.DateTimeFormat('en-CA', {
          timeZone: region === 'kr' ? 'Asia/Seoul' : 'America/New_York',
        }).format(new Date(part.priceAt)),
      ),
    );
    return {
      region,
      observedAt,
      basisDate: priceDates.sort().at(-1)!,
      ...selected,
      sourceCount: listings.length,
      raw: {
        version: 2,
        selectionMonth: selectionMonth(now),
        refreshCadence: 'MONTHLY',
        sourceName: '토스증권 Open API',
        method: MONTHLY_SELECTION_METHOD,
        providerScope:
          region === 'kr'
            ? '토스 제공 국내 상장 보통주 · ETF·우선주 제외'
            : '토스 제공 미국 거래소 상장 보통주 · ETF·우선주·ADR 제외',
        issuerMethod:
          '국내 DART 법인번호 · 미국 CIK 또는 US/CA ISIN의 CUSIP 발행자 코드 · 그 외 ISIN 단위',
        issuerLimitations:
          'CIK 없는 다른 CUSIP 발행자 코드 및 외국 ISIN은 동일 기업 여부를 확정하지 않음',
        issuerMethodSource: 'https://www.cusip.com/pdf/Processes%20-%20CUSIP_Template_2019.pdf',
        currency: selected.currency,
        observedAt: observedAt.toISOString(),
        sourceUrl: 'https://openapi.tossinvest.com/',
        rightsMode: 'PRIVATE_DISPLAY_ONLY',
        documentationUrl: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
        markets: SELECTION_MARKETS[region],
        listings,
        stocks,
        prices,
        eligibleCount: selected.eligibleCount,
        classificationExcluded: selected.classificationExcluded,
        excluded: selected.excluded,
        issuerCount: selected.issuerCount,
        leaders: selected.leaders,
        quality: selected.quality,
        reviewCandidates: selected.reviewCandidates,
      },
    };
  }
  private async run() {
    if (this.stopped || this.config.nodeEnv === 'test') return;
    for (const region of ['kr', 'us'] as const) {
      if (this.stopped) return;
      await this.runRegion(region);
    }
  }
  private async runRegion(region: SelectionRegion) {
    const runner = this.source.createQueryRunner();
    await runner.connect();
    let locked = false;
    const lockName = `orsem-market-selection-${region}`;
    try {
      const [lock] = await runner.query('SELECT GET_LOCK(?, 0) acquired', [lockName]);
      locked = Number(lock?.acquired) === 1;
      if (!locked) return;
      const [state] = await runner.query(
        `SELECT st.*, s.source_count sourceCount, JSON_UNQUOTE(JSON_EXTRACT(s.raw_json,'$.selectionMonth')) selectionMonth
         FROM market_selection_state st LEFT JOIN market_cap_snapshots s ON s.id=st.active_snapshot_id WHERE st.region=?`,
        [region],
      );
      const now = new Date();
      if (!shouldRefreshMonthlySelection(state, now)) return;
      if (!this.toss.enabled) {
        await runner.query(
          `INSERT INTO market_selection_state(region,status,reason) VALUES(?,'UNCONFIGURED',?) ON DUPLICATE KEY UPDATE status=VALUES(status),reason=VALUES(reason)`,
          [region, '월간 시총 목록 · 공식 시세 연결 설정 대기'],
        );
        return;
      }
      await runner.query(
        `INSERT INTO market_selection_state(region,status,last_attempt_at,reason) VALUES(?,'COLLECTING',?,NULL) ON DUPLICATE KEY UPDATE status=VALUES(status),last_attempt_at=VALUES(last_attempt_at),reason=NULL`,
        [region, now],
      );
      const result = await this.collect(region, now);
      if (state?.sourceCount && result.sourceCount < Number(state.sourceCount) * 0.8)
        throw new Error('전체 종목 수 급감 · 이전 목록 유지');
      const previous: Array<{ companyId: string }> = state?.active_snapshot_id
        ? await runner.query(
            'SELECT company_id companyId FROM market_cap_memberships WHERE snapshot_id=?',
            [state.active_snapshot_id],
          )
        : [];
      const added = result.leaders
        .filter((row) => !previous.some((old) => old.companyId === row.companyId))
        .map((row) => row.companyId);
      const id = randomUUID();
      await runner.startTransaction();
      await runner.query(
        'INSERT INTO market_cap_snapshots(id,region,basis_date,observed_at,source_url,rights_mode,source_count,raw_json) VALUES(?,?,?,?,?,?,?,?)',
        [
          id,
          region,
          result.basisDate,
          result.observedAt,
          'https://openapi.tossinvest.com/',
          'PRIVATE_DISPLAY_ONLY',
          result.sourceCount,
          JSON.stringify(result.raw),
        ],
      );
      for (const leader of result.leaders)
        await runner.query(
          'INSERT INTO market_cap_memberships(snapshot_id,company_id,rank_no,stock_code,market_cap) VALUES(?,?,?,?,?)',
          [id, leader.companyId, leader.rank, leader.stockCode, leader.marketCap],
        );
      await runner.query(
        "UPDATE market_selection_state SET status='AVAILABLE',active_snapshot_id=?,last_success_at=?,reason=NULL WHERE region=?",
        [id, result.observedAt, region],
      );
      await runner.commitTransaction();
      if (added.length)
        await this.marketData
          .ingest({
            interval: '1d',
            companyIds: added,
            reason: 'SCHEDULED',
            lookbackDays: 366,
            maxPages: 6,
          })
          .catch(() => undefined);
    } catch {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (locked)
        await runner
          .query(
            "UPDATE market_selection_state SET status='VALIDATION_PENDING', reason='월간 자료 검증 대기 · 마지막 정상 목록 유지' WHERE region=?",
            [region],
          )
          .catch(() => undefined);
    } finally {
      if (locked) await runner.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      await runner.release();
    }
  }
}
