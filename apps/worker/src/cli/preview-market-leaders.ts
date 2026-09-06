import 'reflect-metadata';
import { createTypeOrmOptions } from '@orsem/database';
import { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../config/worker-config';
import { TossMarketClient } from '../market-data/toss-market.client';
import { MarketSelectionService } from '../market-data/market-selection.service';
import type { TossMarketDataService } from '../market-data/toss-market-data.service';

/** Preview only: no WorkerModule boot, scheduler, persistence or notifications. */
export async function previewMarketLeaders() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const config = loadWorkerConfig();
  const source = new DataSource(createTypeOrmOptions(config.databaseUrl));
  const client = new TossMarketClient(config, fetch);
  try {
    await source.initialize();
    const service = new MarketSelectionService(
      config,
      source,
      client,
      {} as TossMarketDataService,
      fetch,
    );
    const results = [];
    for (const region of ['kr', 'us'] as const) {
      const result = await service.collect(region);
      results.push({
        region,
        selectionMonth: result.raw.selectionMonth,
        basisDate: result.basisDate,
        observedAt: result.observedAt,
        sourceCount: result.sourceCount,
        eligibleCount: result.eligibleCount,
        excludedCount: result.excluded.length,
        leaders: result.leaders,
      });
    }
    return results;
  } finally {
    client.onModuleDestroy();
    if (source.isInitialized) await source.destroy();
  }
}
if (require.main === module) {
  if (process.argv.length !== 2) throw new Error('Usage: preview-market-leaders');
  void previewMarketLeaders()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Monthly market-leader preview failed; no records changed.\n');
      process.exitCode = 1;
    });
}
