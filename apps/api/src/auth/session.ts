import type { Request } from 'express';
import { applySessionCookieLifetime } from './session-lifetime';

export function regenerateSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    request.session.regenerate((error) => (error ? reject(error) : resolve())),
  );
}

export function saveSession(request: Request): Promise<void> {
  applySessionCookieLifetime(request.session);
  return new Promise((resolve, reject) =>
    request.session.save((error) => (error ? reject(error) : resolve())),
  );
}
