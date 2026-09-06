import { CompanyEntity, WatchlistItemEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import { TossMarketDataService } from '../src/market-data/toss-market-data.service';
import type { TossMarketClient } from '../src/market-data/toss-market.client';
import type { TossStockInfoService } from '../src/market-data/toss-stock-info.service';

describe('personal groups in shared price collection', () => {
  function setup() {
    const rows = [
      { id: 'a', stockCode: '005930', ticker: null, market: 'KRX', isListed: true },
      { id: 'b', stockCode: null, ticker: 'NVDA', market: 'NASDAQ', isListed: true },
      { id: 'c', stockCode: null, ticker: 'MSFT', market: 'NASDAQ', isListed: true },
    ];
    const find = jest.fn(async (options) =>
      rows.filter((row) => options.where.id.value.includes(row.id)),
    );
    const query = jest
      .fn()
      .mockResolvedValue([
        { companyId: 'a' },
        { companyId: 'b' },
        { companyId: 'b' },
        { companyId: 'c' },
      ]);
    const ds = {
      query,
      getRepository: (entity: unknown) => {
        if (entity === CompanyEntity) return { find };
        if (entity === WatchlistItemEntity)
          return { find: async () => [{ companyId: 'a', priority: 'P1' }] };
        throw new Error('Unexpected repository');
      },
    } as unknown as DataSource;
    const service = new TossMarketDataService(
      ds,
      loadWorkerConfig({ TOSS_MAX_SUBSCRIPTIONS: '2' }),
      { enabled: false } as TossMarketClient,
      {} as TossStockInfoService,
    );
    return { service, query };
  }
  it('includes personal stocks once, preserves operational priority and caps shared scope', async () => {
    const { service } = setup();
    expect(await service.scope()).toMatchObject([
      { companyId: 'a', priority: 'P1' },
      { companyId: 'b', priority: null },
    ]);
  });
  it('limits an explicit visible-page refresh to the requested stock', async () => {
    const { service, query } = setup();
    expect(await service.scope(['c', 'c'])).toMatchObject([{ companyId: 'c', priority: null }]);
    expect(query).not.toHaveBeenCalled();
  });
});
