export { WorkerJobName as JobName, WorkerQueueName as QueueName } from '@orsem/contracts';

// 저장된 작업과 반복 일정을 제거하는 데 필요한 이전 이름만 유지합니다.
export const RETIRED_MARKET_DATA_JOB_NAMES: readonly string[] = Object.freeze([
  'ingest-krx-eod',
  'ingest-alpaca-eod',
]);
