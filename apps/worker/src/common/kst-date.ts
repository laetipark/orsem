const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function dateOnlyParts(dateOnly: string): readonly [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) throw new Error(`Invalid date-only value: ${dateOnly}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${dateOnly}`);
  }
  return [year, month, day];
}

export function toKstDateOnly(date = new Date()): string {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function compactDate(dateOnly: string): string {
  dateOnlyParts(dateOnly);
  return dateOnly.replace(/-/g, '');
}

export function addDateOnlyDays(dateOnly: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new Error('Days must be an integer.');
  const [year, month, day] = dateOnlyParts(dateOnly);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function earlierDateOnly(left: string, right: string): string {
  dateOnlyParts(left);
  dateOnlyParts(right);
  return left <= right ? left : right;
}

export function nextKstMidnight(now = new Date()): Date {
  const today = toKstDateOnly(now);
  const tomorrow = addDateOnlyDays(today, 1);
  const [year, month, day] = tomorrow.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 0, 0, 0) - KST_OFFSET_MS);
}

export interface DateWindow {
  readonly start: string;
  readonly end: string;
}

export function splitDateWindows(start: string, end: string, maxDays = 90): readonly DateWindow[] {
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 90) {
    throw new Error('Date window size must be an integer from 1 through 90.');
  }
  dateOnlyParts(start);
  dateOnlyParts(end);
  if (start > end) throw new Error('Date window start is after end.');
  const windows: DateWindow[] = [];
  let cursor = start;
  while (cursor <= end) {
    const candidateEnd = addDateOnlyDays(cursor, maxDays - 1);
    const windowEnd = candidateEnd < end ? candidateEnd : end;
    windows.push({ start: cursor, end: windowEnd });
    cursor = addDateOnlyDays(windowEnd, 1);
  }
  return windows;
}
