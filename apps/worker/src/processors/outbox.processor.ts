import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { JobName, QueueName } from '../queues/queue.constants';
import { OutboxDispatcherService } from '../queues/outbox-dispatcher.service';

@Processor(QueueName.OUTBOX, { concurrency: 1 })
export class OutboxProcessor extends WorkerHost {
  public constructor(private readonly dispatcher: OutboxDispatcherService) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name !== JobName.DISPATCH_OUTBOX) {
      throw new UnrecoverableError(`Unsupported outbox job: ${job.name}`);
    }
    return this.dispatcher.dispatch();
  }
}
