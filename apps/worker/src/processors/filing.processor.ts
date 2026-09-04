import { Processor, WorkerHost } from '@nestjs/bullmq';
import { OpenDartApiError, OpenDartPayloadError } from '@orsem/opendart-parser';
import { DelayedError, Job, UnrecoverableError } from 'bullmq';
import { nextKstMidnight } from '../common/kst-date';
import { FilingEnrichmentService } from '../opendart/filing-enrichment.service';
import { applyParseProjectionJobSchema, enrichFilingJobSchema } from '../queues/job-data';
import { JobName, QueueName } from '../queues/queue.constants';

@Processor(QueueName.FILING, { concurrency: 2 })
export class FilingProcessor extends WorkerHost {
  public constructor(private readonly enrichment: FilingEnrichmentService) {
    super();
  }

  public override async process(job: Job<unknown>): Promise<unknown> {
    if (job.name !== JobName.ENRICH_FILING && job.name !== JobName.APPLY_PARSE_PROJECTION) {
      throw new UnrecoverableError(`Unsupported filing job: ${job.name}`);
    }
    const applyPayload =
      job.name === JobName.APPLY_PARSE_PROJECTION
        ? applyParseProjectionJobSchema.parse(job.data)
        : null;
    const enrichPayload =
      job.name === JobName.ENRICH_FILING ? enrichFilingJobSchema.parse(job.data) : null;
    try {
      if (applyPayload) return await this.enrichment.applyDeferredProjection(applyPayload);
      return await this.enrichment.enrich(enrichPayload!);
    } catch (error) {
      if (enrichPayload && error instanceof OpenDartApiError && error.status === '014') {
        const delays = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000] as const;
        const retryAttempt = enrichPayload.documentRetryAttempt;
        const delay = delays[retryAttempt];
        if (delay !== undefined && job.token) {
          await job.updateData({
            ...enrichPayload,
            documentRetryAttempt: retryAttempt + 1,
          });
          await job.moveToDelayed(Date.now() + delay, job.token);
          throw new DelayedError();
        }
        await this.enrichment.recordDocumentUnavailableReview(enrichPayload, error.apiMessage);
        throw new UnrecoverableError(
          'OpenDART document remained unavailable after 10m/1h/6h retries.',
        );
      }
      if (error instanceof OpenDartApiError && error.retryPolicy === 'NEXT_KST_DAY' && job.token) {
        await job.moveToDelayed(nextKstMidnight().getTime(), job.token);
        throw new DelayedError();
      }
      if (error instanceof OpenDartPayloadError) {
        // 내려받은 바이트와 파서 버전이 같으면 입력 데이터 오류도 동일하게 발생합니다.
        // 같은 작업의 재시도는 큐의 시도 횟수만 소모하므로, 이후 파서 버전이나
        // 새로 내려받은 공시를 통해 복구합니다.
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
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
