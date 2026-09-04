import { createHash } from 'node:crypto';
import type { RepeatableJob } from 'bullmq';

/** Match both legacy IDs and BullMQ's current default MD5 repeat keys. */
export function matchesRepeatSchedule(
  job: RepeatableJob,
  name: string,
  schedule: { readonly id: string; readonly pattern: string; readonly timezone: string },
): boolean {
  if (job.name !== name || job.pattern !== schedule.pattern || job.tz !== schedule.timezone) {
    return false;
  }
  // BullMQ Repeat.getRepeatConcatOptions: name:jobId:endDate:tz:pattern.
  // WorkerModule leaves repeatKeyHashAlgorithm at its documented implementation default (md5).
  const key = createHash('md5')
    .update(`${name}:${schedule.id}::${schedule.timezone}:${schedule.pattern}`)
    .digest('hex');
  return job.id === schedule.id || job.key === key;
}
