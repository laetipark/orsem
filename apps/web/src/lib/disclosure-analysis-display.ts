/** Keep the source decimal precise, including values beyond Number.MAX_SAFE_INTEGER. */
export function analysisNumber(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(value)) return value;
  const [whole, fraction] = value.split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

/** Only web links from a server-provided evidence reference can be opened. */
export function analysisSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function analysisError(error: unknown): string {
  return error instanceof Error ? error.message : '요청을 처리하지 못했습니다. 다시 시도해 주세요.';
}

export const analysisStatusLabels: Record<string, string> = {
  QUEUED: '수집 대기',
  RUNNING: '자료 확인 중',
  PENDING: '자료 확인 대기',
  WAITING: '다음 수집 대기',
  COMPLETED: '완료',
  SUCCEEDED: '완료',
  COMPLETE: '완료',
  READY: '준비됨',
  PARTIAL: '일부 자료 확인됨',
  FAILED: '확인 실패',
  CANCELLED: '중지됨',
  AVAILABLE: '확인됨',
  UNAVAILABLE: '미확보',
  MISSING: '미확보',
  NO_DATA: '자료 없음',
  AMBIGUOUS: '기준 확인 필요',
  UNSUPPORTED: '지원하지 않는 기준',
  PASS: '일치',
  FAIL: '불일치',
  WARN: '확인 필요',
  WARNING: '확인 필요',
  NOT_APPLICABLE: '적용 대상 아님',
  INDETERMINATE: '판정 보류',
};

export function analysisStatus(value: string): string {
  return analysisStatusLabels[value] ?? value;
}
