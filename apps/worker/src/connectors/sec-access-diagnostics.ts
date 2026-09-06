export type SecAccessCode = 'SEC_UNDECLARED_AUTOMATION' | 'SEC_RATE_LIMIT' | 'SEC_ACCESS_DENIED';

export function safeSecAccessCode(value: unknown): SecAccessCode | null {
  return value === 'SEC_UNDECLARED_AUTOMATION' ||
    value === 'SEC_RATE_LIMIT' ||
    value === 'SEC_ACCESS_DENIED'
    ? value
    : null;
}

const MAX_DIAGNOSTIC_BYTES = 8_192;
const DIAGNOSTIC_TIMEOUT_MS = 1_000;

/** Classifies a bounded error-page prefix in memory; never returns provider text or identifiers. */
export async function readSecAccessCode(response: Response): Promise<SecAccessCode | null> {
  if (response.status === 429) {
    void response.body?.cancel().catch(() => undefined);
    return 'SEC_RATE_LIMIT';
  }
  if (response.status !== 403 || !response.body) return null;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async (): Promise<SecAccessCode | null> => {
        const decoder = new TextDecoder();
        let text = '';
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const prefix = value.subarray(0, MAX_DIAGNOSTIC_BYTES - size);
          size += prefix.byteLength;
          text += decoder.decode(prefix, { stream: true });
          // Only fixed, SEC-published error signatures become persisted diagnostic codes.
          if (/undeclared automated tool/i.test(text)) return 'SEC_UNDECLARED_AUTOMATION';
          if (/request rate threshold exceeded|your request rate has exceeded/i.test(text))
            return 'SEC_RATE_LIMIT';
          if (/access denied/i.test(text)) return 'SEC_ACCESS_DENIED';
          if (size >= MAX_DIAGNOSTIC_BYTES) break;
        }
        return null;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DIAGNOSTIC_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    // Cancellation itself can stall; it must never hold the shared SEC request queue.
    void reader.cancel().catch(() => undefined);
  }
}

export function secAccessGuidance(code: unknown): string {
  switch (safeSecAccessCode(code)) {
    case 'SEC_UNDECLARED_AUTOMATION':
      return 'SEC가 요청을 미신고 자동화 도구로 분류했습니다. 운영자는 실제 전달된 앱·연락처 User-Agent를 확인하고, 정상이면 SEC Webmaster에 접근 검토를 요청해야 합니다.';
    case 'SEC_RATE_LIMIT':
      return 'SEC 요청 빈도 제한 응답입니다. 같은 송신망의 다른 수집 요청도 확인해야 합니다.';
    case 'SEC_ACCESS_DENIED':
      return 'SEC 접근 정책에 따라 거부되었습니다. 반복되면 운영자는 SEC Webmaster에 접근 검토를 요청해야 합니다.';
    default:
      return '403만으로 원인을 확정할 수 없습니다. 운영자는 앱·연락처 User-Agent와 송신망을 확인해야 합니다.';
  }
}
