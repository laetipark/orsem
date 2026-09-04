import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OpenDartPayloadError } from '@orsem/opendart-parser';
import { Job, UnrecoverableError } from 'bullmq';
import { ZodError } from 'zod';
import { FilingEnrichmentService } from '../opendart/filing-enrichment.service';
import { reviewParseWithAiJobSchema } from '../queues/job-data';
import { JobName, QueueName } from '../queues/queue.constants';

@Processor(QueueName.AI_REVIEW, { concurrency: 1 })
export class AiReviewProcessor extends WorkerHost {
  public constructor(private readonly enrichment: FilingEnrichmentService) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name !== JobName.REVIEW_PARSE_WITH_AI) {
      throw new UnrecoverableError(`Unsupported AI-review job: ${job.name}`);
    }
    try {
      return await this.enrichment.reviewParseWithAi(reviewParseWithAiJobSchema.parse(job.data));
    } catch (error) {
      if (error instanceof ZodError) {
        throw new UnrecoverableError(`Invalid AI-review job payload: ${error.message}`);
      }
      if (error instanceof OpenDartPayloadError) {
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      throw error;
    }
  }
}
