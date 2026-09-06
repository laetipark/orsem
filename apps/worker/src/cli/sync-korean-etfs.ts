import 'reflect-metadata';
import { createTypeOrmOptions } from '@orsem/database';
import { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../config/worker-config';
import { TossMarketClient } from '../market-data/toss-market.client';
import { TossKoreanEtfMasterService } from '../market-data/toss-korean-etf-master.service';

/** Explicit apply only; dry-run reads the same six official universe responses without saving rows. */
export async function syncKoreanEtfs(apply = false) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const config = loadWorkerConfig();
  const source = new DataSource(createTypeOrmOptions(config.databaseUrl));
  const client = new TossMarketClient(config, fetch);
  try {
    await source.initialize();
    return await new TossKoreanEtfMasterService(config, source, client).sync({
      force: true,
      dryRun: !apply,
    });
  } finally {
    client.onModuleDestroy();
    if (source.isInitialized) await source.destroy();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (
    args.some((arg) => !['--apply', '--dry-run'].includes(arg)) ||
    (args.includes('--apply') && args.includes('--dry-run'))
  )
    throw new Error('Usage: sync-korean-etfs [--dry-run | --apply]');
  void syncKoreanEtfs(args.includes('--apply'))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(() => {
      process.stderr.write('Korean ETF synchronization failed; existing records were preserved.\n');
      process.exitCode = 1;
    });
}
