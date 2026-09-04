import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import { NewsTranslationService } from '../ai/news-translation.service';
import { JobName, QueueName } from '../queues/queue.constants';

@Processor(QueueName.NEWS_TRANSLATION, { concurrency: 1 })
export class NewsTranslationProcessor extends WorkerHost {
  public constructor(private readonly translations: NewsTranslationService) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (
      job.name !== JobName.TRANSLATE_NEWS_BATCH ||
      !z.object({}).strict().safeParse(job.data).success
    ) {
      throw new UnrecoverableError('Invalid news translation job.');
    }
    return this.translations.translateBatch();
  }
}
