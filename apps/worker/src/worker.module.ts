import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule, type TypeOrmModuleOptions } from '@nestjs/typeorm';
import { createTypeOrmOptions } from '@orsem/database';
import { DataSource } from 'typeorm';
import { createSecFetch } from './connectors/sec-access-policy';
import { CompatibleClassifierClient } from './ai/compatible-classifier.client';
import { LocalNewsTranslationClient } from './ai/local-news-translation.client';
import { NewsTranslationService } from './ai/news-translation.service';
import { NewsTranslationProcessor } from './processors/news-translation.processor';
import { ConnectorHealthService } from './connectors/connector-health.service';
import { NewsDiscoveryService } from './connectors/news-discovery.service';
import { WORKER_CONFIG, loadWorkerConfig } from './config/worker-config';
import { FilingEnrichmentService } from './opendart/filing-enrichment.service';
import { MarketDataIngestionService } from './market-data/market-data-ingestion.service';
import { TossMarketClient } from './market-data/toss-market.client';
import { TossMarketDataService } from './market-data/toss-market-data.service';
import { TossLiveQuoteService } from './market-data/toss-live-quote.service';
import { TossStockInfoService } from './market-data/toss-stock-info.service';
import { SecCikSyncService } from './market-data/sec-cik-sync.service';
import { MarketIndicatorClient } from './market-indicators/market-indicator.client';
import { MarketIndicatorIngestionService } from './market-indicators/market-indicator-ingestion.service';
import { HTTP_FETCH, OpenDartClient, type FetchImplementation } from './opendart/opendart.client';
import { OpenDartIngestionService } from './opendart/opendart-ingestion.service';
import { ConnectorHealthProcessor } from './processors/connector-health.processor';
import { AiReviewProcessor } from './processors/ai-review.processor';
import { FilingProcessor } from './processors/filing.processor';
import { OutboxProcessor } from './processors/outbox.processor';
import { MarketNewsProcessor } from './processors/market-news.processor';
import { MarketDataProcessor } from './processors/market-data.processor';
import { PollProcessor } from './processors/poll.processor';
import { OutboxDispatcherService } from './queues/outbox-dispatcher.service';
import { AlertOutboxDispatcherService } from './queues/alert-outbox-dispatcher.service';
import { QueueName } from './queues/queue.constants';
import { WorkerSchedulerService } from './scheduling/worker-scheduler.service';
import { RawDocumentStore } from './raw-documents/raw-document.store';
import { PushFanoutService } from './push/push-fanout.service';
import { PushDeliveryService } from './push/push-delivery.service';
import { WebPushClient, WEB_PUSH_SEND, defaultWebPushSend } from './push/web-push.client';

const config = loadWorkerConfig();

function redisConnection(redisUrl: string): Record<string, unknown> {
  const url = new URL(redisUrl);
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://.');
  }
  const dbPart = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: dbPart ? Number(dbPart) : 0,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

const fetchImplementation: FetchImplementation = (input, init) => globalThis.fetch(input, init);

@Module({
  imports: [
    TypeOrmModule.forRoot(createTypeOrmOptions(config.databaseUrl) as TypeOrmModuleOptions),
    BullModule.forRoot({
      connection: redisConnection(config.redisUrl),
      prefix: config.redisPrefix,
    }),
    BullModule.registerQueue(
      { name: QueueName.POLL },
      { name: QueueName.FILING },
      { name: QueueName.AI_REVIEW },
      { name: QueueName.NEWS_TRANSLATION },
      { name: QueueName.OUTBOX },
      { name: QueueName.CONNECTOR_HEALTH },
      { name: QueueName.MARKET_DATA },
      { name: QueueName.MARKET_NEWS },
    ),
  ],
  providers: [
    { provide: WORKER_CONFIG, useValue: config },
    {
      provide: HTTP_FETCH,
      useFactory: (dataSource: DataSource) => createSecFetch(dataSource, fetchImplementation),
      inject: [DataSource],
    },
    { provide: WEB_PUSH_SEND, useValue: defaultWebPushSend },
    PushFanoutService,
    PushDeliveryService,
    WebPushClient,
    OpenDartClient,
    OpenDartIngestionService,
    FilingEnrichmentService,
    RawDocumentStore,
    OutboxDispatcherService,
    AlertOutboxDispatcherService,
    ConnectorHealthService,
    NewsDiscoveryService,
    MarketDataIngestionService,
    TossMarketClient,
    TossMarketDataService,
    TossStockInfoService,
    SecCikSyncService,
    TossLiveQuoteService,
    MarketIndicatorClient,
    MarketIndicatorIngestionService,
    CompatibleClassifierClient,
    LocalNewsTranslationClient,
    NewsTranslationService,
    NewsTranslationProcessor,
    WorkerSchedulerService,
    PollProcessor,
    FilingProcessor,
    AiReviewProcessor,
    OutboxProcessor,
    ConnectorHealthProcessor,
    MarketDataProcessor,
    MarketNewsProcessor,
  ],
})
export class WorkerModule {}
