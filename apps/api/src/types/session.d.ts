import 'express-session';

declare module 'express-session' {
  interface SessionData {
    adminId?: string;
    memberId?: string;
    kakaoOAuthState?: { stateHash: string; createdAt: number };
    csrfToken?: string;
    sessionStartedAt?: string;
    pendingTotpSecret?: string;
  }
}
