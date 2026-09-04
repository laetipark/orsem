import { Market, RightsMode } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import type { DataSource, EntityManager } from 'typeorm';
import type { WorkerConfig } from '../src/config/worker-config';
import {
  TossStockInfoService,
  tossCompanyNamePatch,
} from '../src/market-data/toss-stock-info.service';
import {
  TossHttpError,
  TossMarketClient,
  type TossStock,
} from '../src/market-data/toss-market.client';
import {
  TossMarketDataService,
  type TossScopeCompany,
} from '../src/market-data/toss-market-data.service';
import { syncTossStocksJobSchema } from '../src/queues/job-data';

const now = new Date('2026-09-04T09:30:00Z');
const stock: TossStock = {
  symbol: 'AAPL',
  name: '애플',
  englishName: 'APPLE INC',
  isinCode: 'US0378331005',
  market: 'NASDAQ',
  currency: 'USD',
  status: 'ACTIVE',
  listDate: '1980-12-12',
  extraSourceField: 'preserved',
};
const company = {
  id: '00000000-0000-4000-8000-000000000001',
  market: Market.NASDAQ,
  ticker: 'AAPL',
  stockCode: null,
  nameKo: 'Apple Inc. Common Stock',
  nameEn: 'Apple Inc. Common Stock',
  isListed: true,
} as CompanyEntity;
const scope: TossScopeCompany = {
  companyId: company.id,
  symbol: 'AAPL',
  region: 'us',
  currency: 'USD',
  priority: 'P1',
};

function harness() {
  let current = { ...company };
  let checkpoint: SourceCheckpointEntity | null = null;
  const companyRepository = {
    find: jest.fn(async () => [current]),
    findOne: jest.fn(async () => ({ ...current })),
    update: jest.fn(async (_where: unknown, patch: Partial<CompanyEntity>) => {
      current = { ...current, ...patch };
    }),
  };
  const checkpointRepository = {
    find: jest.fn(async () => (checkpoint ? [checkpoint] : [])),
    findOne: jest.fn(async () => checkpoint),
    create: jest.fn((row: SourceCheckpointEntity) => row),
    save: jest.fn(async (row: SourceCheckpointEntity) => {
      checkpoint = row;
      return row;
    }),
  };
  const getRepository = (entity: unknown) => {
    if (entity === CompanyEntity) return companyRepository;
    if (entity === SourceCheckpointEntity) return checkpointRepository;
    throw new Error('Unexpected test repository');
  };
  const dataSource = {
    getRepository,
    transaction: jest.fn(async (operation: (manager: EntityManager) => Promise<unknown>) =>
      operation({ getRepository } as unknown as EntityManager),
    ),
  } as unknown as DataSource;
  const stocks = jest.fn().mockResolvedValue([{ ...stock }]);
  const client = { enabled: true, stocks } as unknown as TossMarketClient;
  return {
    dataSource,
    service: new TossStockInfoService(dataSource, client),
    client,
    stocks,
    company: () => current,
    checkpoint: () => checkpoint,
    editCompany: (patch: Partial<CompanyEntity>) => {
      current = { ...current, ...patch };
    },
    checkpointRepository,
    companyRepository,
  };
}

describe('Toss official stock names', () => {
  beforeEach(() => jest.useFakeTimers({ now }));
  afterEach(() => jest.useRealTimers());

  it('stores the official Korean name and raw provenance while keeping the original English name', async () => {
    const h = harness();
    expect((await h.service.lookup([scope])).get('AAPL')).toEqual(stock);
    expect(h.company()).toMatchObject({ nameKo: '애플', nameEn: company.nameEn });
    expect(h.company().ticker).toBe(company.ticker);
    expect(h.checkpoint()).toMatchObject({
      connector: 'TOSS',
      stream: `STOCK_INFO:${company.id}`,
      lastSuccessAt: now,
      metadataJson: {
        source: 'TOSS',
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        rawPayload: stock,
        firstObservedAt: now.toISOString(),
        observedAt: now.toISOString(),
        originalCompanyNames: { nameKo: company.nameKo, nameEn: company.nameEn },
        appliedNameKo: '애플',
        provenanceUrl: 'https://openapi.tossinvest.com/api/v1/stocks?symbols=AAPL',
      },
    });
  });

  it('reuses stock metadata across two-second refreshes and updates only same-provider names after the TTL', async () => {
    const h = harness();
    await h.service.lookup([scope]);
    jest.setSystemTime(new Date(now.getTime() + 2000));
    await h.service.lookup([scope]);
    expect(h.stocks).toHaveBeenCalledTimes(1);
    expect(h.checkpointRepository.save).toHaveBeenCalledTimes(1);
    const later = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    jest.setSystemTime(later);
    h.stocks.mockResolvedValue([{ ...stock, name: '애플 보통주' }]);
    await h.service.lookup([scope]);
    expect(h.stocks).toHaveBeenCalledTimes(2);
    expect(h.company().nameKo).toBe('애플 보통주');
    expect(h.checkpoint()?.metadataJson).toMatchObject({
      firstObservedAt: now.toISOString(),
      observedAt: later.toISOString(),
    });
  });

  it('repairs an English display name from cached official metadata without refetching or extending source freshness', async () => {
    const h = harness();
    await h.service.lookup([scope]);
    const sourceMetadata = { ...h.checkpoint()?.metadataJson };
    h.editCompany({ nameKo: company.nameKo });
    jest.setSystemTime(new Date(now.getTime() + 2000));

    expect((await h.service.lookup([scope])).get('AAPL')).toEqual(stock);
    expect(h.company()).toMatchObject({
      nameKo: '애플',
      nameEn: company.nameEn,
      ticker: company.ticker,
    });
    expect(h.stocks).toHaveBeenCalledTimes(1);
    expect(h.checkpoint()?.lastSuccessAt).toEqual(now);
    expect(h.checkpoint()?.metadataJson).toEqual(sourceMetadata);
    expect(h.checkpointRepository.save).toHaveBeenCalledTimes(2);

    await h.service.lookup([scope]);
    expect(h.checkpointRepository.save).toHaveBeenCalledTimes(2);
  });

  it('preserves a separately registered Korean name and the provider alternative in raw metadata', async () => {
    const h = harness();
    h.editCompany({ nameKo: '애플 주식회사' });
    await h.service.lookup([scope]);
    expect(h.company().nameKo).toBe('애플 주식회사');
    expect(h.companyRepository.update).not.toHaveBeenCalled();
    expect(h.checkpoint()?.metadataJson?.rawPayload).toEqual(stock);
    expect(tossCompanyNamePatch({ ...company, nameEn: null }, stock, null)).toEqual({
      nameKo: '애플',
      nameEn: 'APPLE INC',
    });
  });

  it.each([{ market: 'NYSE' }, { currency: 'KRW' }, { status: 'DELISTED' }])(
    'rejects stock mapping mismatch %j without changing company data',
    async (patch) => {
      const h = harness();
      h.stocks.mockResolvedValue([{ ...stock, ...patch }]);
      expect((await h.service.lookup([scope])).size).toBe(0);
      expect(h.companyRepository.update).not.toHaveBeenCalled();
      expect(h.checkpointRepository.save).not.toHaveBeenCalled();
    },
  );

  it('does not reassign a reused ticker when the provider ISIN changes', async () => {
    const h = harness();
    await h.service.lookup([scope]);
    jest.setSystemTime(new Date(now.getTime() + 86_400_000));
    h.stocks.mockResolvedValue([{ ...stock, name: '다른 기업', isinCode: 'US0000000001' }]);
    expect((await h.service.lookup([scope])).size).toBe(0);
    expect(h.company().nameKo).toBe('애플');
    expect(h.checkpoint()?.metadataJson?.rawPayload).toEqual(stock);
  });

  it.each([{ response: [{ ...stock, symbol: 'MSFT' }] }, { response: [stock, stock] }])(
    'rejects an unexpected or duplicate symbol before persistence',
    async ({ response }) => {
      const h = harness();
      h.stocks.mockResolvedValue(response);
      await expect(h.service.lookup([scope])).rejects.toThrow(/unrequested or duplicate/u);
      expect(h.companyRepository.update).not.toHaveBeenCalled();
    },
  );

  it('isolates an unavailable symbol from a metadata batch and leaves its company unchanged', async () => {
    const h = harness();
    const second = { ...company, id: '00000000-0000-4000-8000-000000000002', ticker: 'MSFT' };
    h.companyRepository.find.mockResolvedValue([company, second]);
    h.stocks.mockImplementation(async (symbols: string[]) => {
      if (symbols.includes('MSFT')) throw new TossHttpError(404);
      return [stock];
    });
    const result = await h.service.lookup([
      scope,
      { ...scope, companyId: second.id, symbol: 'MSFT' },
    ]);
    expect([...result.keys()]).toEqual(['AAPL']);
    expect(h.stocks).toHaveBeenCalledTimes(3);
    expect(h.companyRepository.update).toHaveBeenCalledTimes(1);
    expect(h.companyRepository.update).toHaveBeenCalledWith({ id: company.id }, { nameKo: '애플' });
  });

  it('does not fan out a temporary provider outage into per-symbol requests', async () => {
    const h = harness();
    h.stocks.mockRejectedValue(new TossHttpError(503));
    await expect(h.service.lookup([scope])).rejects.toMatchObject({ status: 503 });
    expect(h.stocks).toHaveBeenCalledTimes(1);
    expect(h.companyRepository.update).not.toHaveBeenCalled();
  });

  it('does not replace domestic names or fabricate Korean translations', () => {
    expect(
      tossCompanyNamePatch(
        { ...company, market: Market.KRX, stockCode: '005930', ticker: null },
        { ...stock, symbol: '005930', market: 'KOSPI', currency: 'KRW', name: '삼성전자' },
        null,
      ),
    ).toEqual({});
    expect(tossCompanyNamePatch(company, { ...stock, name: 'Apple Inc' }, null)).toEqual({});
  });

  it('bounds manual sync to explicit companies and fails closed when credentials are absent', async () => {
    expect(syncTossStocksJobSchema.parse({ companyIds: [company.id] }).reason).toBe('MANUAL');
    expect(
      syncTossStocksJobSchema.safeParse({ companyIds: Array(101).fill(company.id) }).success,
    ).toBe(false);
    const h = harness();
    Object.assign(h.client, { enabled: false });
    expect((await h.service.lookup([scope])).size).toBe(0);
    expect(h.stocks).not.toHaveBeenCalled();
  });

  it('syncs registered stock names without selecting a watchlist or activating live quotes', async () => {
    const h = harness();
    const storage = jest.fn();
    const candlePage = jest.fn();
    const prices = jest.fn();
    Object.assign(h.client, { storage, candlePage, prices });
    const service = new TossMarketDataService(
      h.dataSource,
      { tossMaxSubscriptions: 1 } as WorkerConfig,
      h.client,
      h.service,
    );
    expect(await service.syncStocks([company.id])).toMatchObject({
      companiesRequested: 1,
      companiesAvailable: 1,
    });
    expect(h.company().nameKo).toBe('애플');
    expect(h.stocks).toHaveBeenCalledTimes(1);
    expect(h.stocks).toHaveBeenCalledWith(['AAPL']);
    expect(storage).not.toHaveBeenCalled();
    expect(candlePage).not.toHaveBeenCalled();
    expect(prices).not.toHaveBeenCalled();

    await expect(service.syncStocks(Array(101).fill(company.id))).rejects.toThrow(/100/u);
    expect(h.stocks).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit metadata batch independent of the live subscription cap and excludes ambiguous tickers', async () => {
    const h = harness();
    const second = { ...company, id: '00000000-0000-4000-8000-000000000002', ticker: 'MSFT' };
    const duplicate = {
      ...company,
      id: '00000000-0000-4000-8000-000000000003',
      market: Market.NYSE,
    };
    h.companyRepository.find.mockResolvedValue([company, second, duplicate]);
    const lookup = jest.fn().mockResolvedValue(new Map());
    const service = new TossMarketDataService(
      h.dataSource,
      { tossMaxSubscriptions: 1 } as WorkerConfig,
      h.client,
      { lookup } as unknown as TossStockInfoService,
    );
    await service.syncStocks([company.id, second.id, duplicate.id]);
    expect(lookup).toHaveBeenCalledWith([
      { companyId: second.id, symbol: 'MSFT', region: 'us', currency: 'USD', priority: null },
    ]);
  });

  it('reports unsupported and non-Korean provider names for bounded backfill accounting', async () => {
    const h = harness();
    const service = new TossMarketDataService(
      h.dataSource,
      {} as WorkerConfig,
      h.client,
      h.service,
    );
    h.stocks.mockRejectedValueOnce(new TossHttpError(404));
    expect(await service.syncStocks([company.id])).toMatchObject({
      companiesAvailable: 0,
      unavailableSymbols: ['AAPL'],
      withoutKoreanNames: [],
    });
    h.stocks.mockResolvedValue([{ ...stock, name: 'Apple Inc.' }]);
    expect(await service.syncStocks([company.id])).toMatchObject({
      companiesAvailable: 1,
      unavailableSymbols: [],
      withoutKoreanNames: ['AAPL'],
    });
    expect(h.company().nameKo).toBe(company.nameKo);
  });

  it('reads the official active stock universe through the shared client and retains raw fields', async () => {
    const client = new TossMarketClient(
      { redisUrl: 'redis://127.0.0.1:6379', redisPrefix: 'test:' } as WorkerConfig,
      jest.fn(),
    );
    const listed = {
      symbol: 'AAPL',
      name: '애플',
      securityType: 'FOREIGN_STOCK',
      isCommonShare: true,
      isinCode: stock.isinCode,
      extraField: 'preserved',
    };
    const get = jest.spyOn(client, 'get').mockResolvedValue({ result: [listed] });
    try {
      expect(await client.stocksAll('NASDAQ')).toEqual([listed]);
      expect(get).toHaveBeenCalledWith('/api/v1/stocks/all', {
        market: 'NASDAQ',
        status: 'ACTIVE',
      });
    } finally {
      client.onModuleDestroy();
    }
  });
});
