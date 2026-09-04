import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { NewsDiscoveryService } from '../connectors/news-discovery.service';
import { discoverLinksJobSchema, syncSecCikJobSchema } from '../queues/job-data';
import { SecCikSyncService } from '../market-data/sec-cik-sync.service';
import { JobName, QueueName } from '../queues/queue.constants';

@Processor(QueueName.CONNECTOR_HEALTH, { concurrency: 1 })
export class ConnectorHealthProcessor extends WorkerHost {
  public constructor(
    private readonly health: ConnectorHealthService,
    private readonly discovery: NewsDiscoveryService,
    private readonly secCikSync: SecCikSyncService,
  ) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name === JobName.CHECK_CONNECTORS) return this.health.checkAll();
    if (job.name === JobName.DISCOVER_LINKS) {
      return this.discovery.discover(discoverLinksJobSchema.parse(job.data));
    }
    if (job.name === JobName.SYNC_SEC_CIK) {
      return this.secCikSync.sync(syncSecCikJobSchema.parse(job.data));
    }
    throw new UnrecoverableError(`Unsupported connector-health job: ${job.name}`);
  }
}
