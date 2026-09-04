import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { NewsDiscoveryService } from '../connectors/news-discovery.service';
import { discoverLinksJobSchema } from '../queues/job-data';
import { JobName, QueueName } from '../queues/queue.constants';

@Processor(QueueName.MARKET_NEWS, { concurrency: 1 })
export class MarketNewsProcessor extends WorkerHost {
  public constructor(private readonly discovery: NewsDiscoveryService) {
    super();
  }
  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name !== JobName.DISCOVER_LINKS)
      throw new UnrecoverableError(`Unsupported market-news job: ${job.name}`);
    const parsed = discoverLinksJobSchema.parse(job.data);
    if (parsed.connectors.some((connector) => !['NEWS_RSS', 'IR', 'GDELT'].includes(connector)))
      throw new UnrecoverableError('Unsupported market-news connector.');
    return this.discovery.discover(parsed);
  }
}
