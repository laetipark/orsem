const MAX_ERROR_BYTES = 4_096;
const ERROR_READ_TIMEOUT_MS = 1_000;

export type NaverApiProvider = 'developers' | 'ncloud';

// 공급자 오류 본문은 저장하지 않고 진단에 필요한 짧은 코드만 반환합니다.
// 클라이언트 키, 요청 URL, 외부 errorMessage는 메시지나 로그에 포함하지 않습니다.
export async function readNaverErrorCode(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_ERROR_BYTES) return null;
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const payload: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        );
        if (!payload || typeof payload !== 'object') return null;
        const error = 'error' in payload ? payload.error : null;
        const code =
          'errorCode' in payload
            ? payload.errorCode
            : error && typeof error === 'object' && 'errorCode' in error
              ? error.errorCode
              : null;
        // 공통 숫자 코드와 검색 API의 SE## 코드만 허용합니다.
        return typeof code === 'string' && /^(?:\d{3}|SE\d{2})$/u.test(code) ? code : null;
      })(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ERROR_READ_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

export function naverFailureMessage(
  httpStatus: number,
  providerCode: string | null,
  apiProvider: NaverApiProvider = 'developers',
): string | null {
  if (httpStatus !== 401 && httpStatus !== 403) return null;
  const code =
    providerCode && /^(?:\d{3}|SE\d{2})$/u.test(providerCode) ? `, 코드 ${providerCode}` : '';
  const setup =
    apiProvider === 'ncloud'
      ? 'NAVER Cloud 콘솔의 NAVER API HUB → Application → 인증 정보에서 같은 애플리케이션의 Client ID·Client Secret과 Search API 사용 설정을 확인해 주세요.'
      : '네이버 개발자센터의 같은 애플리케이션에서 발급한 Client ID·Client Secret과 API 설정의 ‘검색’ 권한을 확인해 주세요.';
  return `네이버 ${httpStatus === 401 ? '인증에 실패했습니다' : '검색 API 호출이 거절되었습니다'} (HTTP ${httpStatus}${code}). ${setup}`;
}
