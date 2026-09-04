import { readFileSync } from 'node:fs';

// 진단 출력에는 키, 시크릿, 파일 내용, 파싱 예외를 포함하지 않습니다.
export function checkKakaoConfig(environment) {
  const trim = (value) => (typeof value === 'string' ? value.trim() : '');
  if (['1', 'true', 'yes', 'on'].includes(trim(environment.FIXTURE_MODE).toLowerCase())) {
    return { state: 'DISABLED', detail: 'fixture mode disables Kakao login' };
  }

  let file = {};
  let invalidFile = false;
  if (trim(environment.KAKAO_CREDENTIALS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(trim(environment.KAKAO_CREDENTIALS_FILE), 'utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        ['clientId', 'clientSecret', 'redirectUri'].some(
          (key) => parsed[key] !== undefined && typeof parsed[key] !== 'string',
        )
      )
        throw new Error('Invalid credential shape');
      file = parsed;
    } catch {
      invalidFile = true;
    }
  }
  const clientId = trim(environment.KAKAO_CLIENT_ID) || trim(file.clientId);
  const clientSecret = trim(environment.KAKAO_CLIENT_SECRET) || trim(file.clientSecret);
  const redirectUri = trim(environment.KAKAO_REDIRECT_URI) || trim(file.redirectUri);
  const missing = [
    !clientId && 'KAKAO_CLIENT_ID (REST API key)',
    !clientSecret && 'KAKAO_CLIENT_SECRET',
  ].filter(Boolean);
  if (missing.length) {
    return {
      state: invalidFile ? 'FAIL' : 'DISABLED',
      detail: `${invalidFile ? 'credentials file could not be loaded; ' : ''}missing ${missing.join(', ')}; see docs/KAKAO_LOGIN.md`,
    };
  }

  try {
    const origin = new URL(environment.WEB_ORIGIN ?? 'http://localhost:5173');
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      (environment.NODE_ENV === 'production' && origin.protocol !== 'https:')
    )
      throw new Error('Invalid origin');
    const expected = new URL('/api/v1/auth/kakao/callback', origin.origin).href;
    if (redirectUri && redirectUri !== expected) {
      return {
        state: 'FAIL',
        detail: 'redirect URI must equal WEB_ORIGIN + /api/v1/auth/kakao/callback',
      };
    }
  } catch {
    return {
      state: 'FAIL',
      detail: 'WEB_ORIGIN must be a valid HTTP(S) origin (HTTPS in production)',
    };
  }

  return {
    state: 'OK',
    detail:
      'credentials configured; verify Kakao login/OIDC, registered callback and actual sign-in separately',
  };
}
