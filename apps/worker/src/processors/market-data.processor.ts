import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { MarketDataIngestionService } from '../market-data/market-data-ingestion.service';
import {
  syncAlpacaAssetsJobSchema,
  syncTossStocksJobSchema,
  tossCandlesJobSchema,
} from '../queues/job-data';
import { TossMarketDataService } from '../market-data/toss-market-data.service';
import { JobName, QueueName, RETIRED_MARKET_DATA_JOB_NAMES } from '../queues/queue.constants';
import { MARKET_INDICATOR_JOBS } from '../market-indicators/jobs';
import { MarketIndicatorIngestionService } from '../market-indicators/market-indicator-ingestion.service';

@Processor(QueueName.MARKET_DATA, { concurrency: 1 })
export class MarketDataProcessor extends WorkerHost {
  public constructor(
    private readonly ingestion: MarketDataIngestionService,
    private readonly toss: TossMarketDataService,
    private readonly indicators: MarketIndicatorIngestionService,
  ) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name === MARKET_INDICATOR_JOBS.quotes) return this.indicators.refresh('quotes');
    if (job.name === MARKET_INDICATOR_JOBS.history) return this.indicators.refresh('history');
    if (job.name === JobName.INGEST_TOSS_CANDLES)
      return this.toss.ingest(tossCandlesJobSchema.parse(job.data));
    if (job.name === JobName.SYNC_TOSS_STOCKS)
      return this.toss.syncStocks(syncTossStocksJobSchema.parse(job.data).companyIds);
    if (RETIRED_MARKET_DATA_JOB_NAMES.includes(job.name)) {
      throw new UnrecoverableError('Legacy price ingestion has been retired; use Toss candles.');
    }
    if (job.name === JobName.SYNC_ALPACA_ASSETS) {
      syncAlpacaAssetsJobSchema.parse(job.data);
      return this.ingestion.syncAlpacaAssets();
    }
    throw new UnrecoverableError(`Unsupported market-data job: ${job.name}`);
  }
}
