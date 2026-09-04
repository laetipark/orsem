import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OpenDartApiError } from '@orsem/opendart-parser';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { nextKstMidnight } from '../common/kst-date';
import { pollOpenDartJobSchema, type PollOpenDartJob } from '../queues/job-data';
import { JobName, QueueName } from '../queues/queue.constants';
import { OpenDartIngestionService } from '../opendart/opendart-ingestion.service';

@Processor(QueueName.POLL, { concurrency: 1 })
export class PollProcessor extends WorkerHost {
  public constructor(private readonly ingestion: OpenDartIngestionService) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    try {
      if (job.name === JobName.POLL_OPENDART || job.name === JobName.BACKFILL_OPENDART) {
        const payload: PollOpenDartJob = pollOpenDartJobSchema.parse(job.data);
        return await this.ingestion.poll(payload);
      }
      if (job.name === JobName.SYNC_CORP_CODES) {
        return { synced: await this.ingestion.syncCorpCodes() };
      }
      throw new UnrecoverableError(`Unsupported poll job: ${job.name}`);
    } catch (error) {
      if (
        error instanceof OpenDartApiError &&
        error.retryPolicy === 'NEXT_KST_DAY' &&
        job.name !== JobName.POLL_OPENDART &&
        job.token
      ) {
        await job.moveToDelayed(nextKstMidnight().getTime(), job.token);
        throw new DelayedError();
      }
      if (
        error instanceof OpenDartApiError &&
        (error.retryPolicy === 'NONE' || error.retryPolicy === 'NEXT_KST_DAY')
      ) {
        throw new UnrecoverableError(`OpenDART ${error.status}: ${error.message}`);
      }
      throw error;
    }
  }
}
