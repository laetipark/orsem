import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SessionRuntimeService } from './session-runtime.service';
import { AuthService } from '../auth/auth.service';
import { MemberService } from '../auth/member.service';
import { authenticatedSessionIsValid } from '../auth/session-lifetime';

const PUBLIC_ROUTE = 'orsem:public';
const SKIP_CSRF = 'orsem:skip-csrf';
const SERVICE_ROUTE = 'orsem:service-route';
const DEVICE_ROUTE = 'orsem:device-route';
const RATE_LIMIT = 'orsem:rate-limit';
const MEMBER_READ = 'orsem:member-read';
const OWN_NOTIFICATION_ACCESS = 'orsem:own-notification-access';
const OWN_WATCHLIST_GROUP_ACCESS = 'orsem:own-watchlist-group-access';
const COMPANY_LOGO_PERMIT_ACCESS = 'orsem:company-logo-permit-access';

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const SkipCsrf = () => SetMetadata(SKIP_CSRF, true);
export const ServiceRoute = () => SetMetadata(SERVICE_ROUTE, true);
export const DeviceRoute = () => SetMetadata(DEVICE_ROUTE, true);
export const ReadOnlyMemberAccess = () => SetMetadata(MEMBER_READ, true);
// Only notification controllers that derive ownership from the session may use this.
export const OwnNotificationAccess = () => SetMetadata(OWN_NOTIFICATION_ACCESS, true);
// Only group/room controllers may use this; their services check ownership and membership on each call.
export const OwnWatchlistGroupAccess = () => SetMetadata(OWN_WATCHLIST_GROUP_ACCESS, true);
// This permits a request-budget reservation only; it grants no logo metadata edit rights.
export const CompanyLogoPermitAccess = () => SetMetadata(COMPANY_LOGO_PERMIT_ACCESS, true);
export const RateLimit = (limit: number, windowMs = 60_000) =>
  SetMetadata(RATE_LIMIT, { limit, windowMs });

function hasMetadata(reflector: Reflector, key: string, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean>(key, [context.getHandler(), context.getClass()]) === true
  );
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly members: MemberService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      hasMetadata(this.reflector, PUBLIC_ROUTE, context) ||
      hasMetadata(this.reflector, SERVICE_ROUTE, context) ||
      hasMetadata(this.reflector, DEVICE_ROUTE, context)
    ) {
      return true;
    }
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.session?.adminId && !request.session?.memberId)
      throw new UnauthorizedException('로그인이 필요합니다.');
    if (request.session.adminId && request.session.memberId) {
      request.session.destroy(() => undefined);
      throw new UnauthorizedException('계정 세션을 다시 시작해 주세요.');
    }
    if (!authenticatedSessionIsValid(request.session)) {
      request.session.destroy(() => undefined);
      throw new UnauthorizedException('세션의 최대 사용 기간이 지났습니다. 다시 로그인하세요.');
    }
    if (request.session.adminId) {
      if (!(await this.auth.getAdmin(request.session.adminId)))
        throw new UnauthorizedException('관리자 계정을 확인할 수 없습니다.');
      return true;
    }
    const member = await this.members.getMember(request.session.memberId!);
    if (!member || member.role !== 'VIEWER' || member.status !== 'APPROVED') {
      throw new ForbiddenException('관리자의 이용 승인이 필요합니다.');
    }
    const memberRead =
      ['GET', 'HEAD'].includes(request.method) && hasMetadata(this.reflector, MEMBER_READ, context);
    const ownNotifications =
      ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(request.method) &&
      hasMetadata(this.reflector, OWN_NOTIFICATION_ACCESS, context);
    const ownGroups =
      ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      hasMetadata(this.reflector, OWN_WATCHLIST_GROUP_ACCESS, context);
    const logoPermit =
      request.method === 'POST' && hasMetadata(this.reflector, COMPANY_LOGO_PERMIT_ACCESS, context);
    if (!memberRead && !ownNotifications && !ownGroups && !logoPermit) {
      throw new ForbiddenException('이 계정은 승인된 관측 화면만 읽을 수 있습니다.');
    }
    return true;
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (
      hasMetadata(this.reflector, SKIP_CSRF, context) ||
      hasMetadata(this.reflector, SERVICE_ROUTE, context) ||
      hasMetadata(this.reflector, DEVICE_ROUTE, context)
    ) {
      return true;
    }
    const expected = request.session?.csrfToken;
    const supplied = request.header('x-csrf-token');
    if (!expected || !supplied || !safeEqual(expected, supplied)) {
      throw new ForbiddenException('CSRF 토큰이 없거나 일치하지 않습니다.');
    }
    return true;
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (
      hasMetadata(this.reflector, SERVICE_ROUTE, context) ||
      hasMetadata(this.reflector, DEVICE_ROUTE, context)
    ) {
      return true;
    }
    const origin = request.header('origin');
    if (!origin) return true;
    const allowed = this.config.webOrigin;
    try {
      if (new URL(origin).origin !== new URL(allowed).origin) throw new Error('origin mismatch');
    } catch {
      throw new ForbiddenException('허용되지 않은 요청 출처입니다.');
    }
    return true;
  }
}

interface RateBucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class HybridRateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, RateBucket>();
  private calls = 0;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionRuntimeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const policy = this.reflector.getAllAndOverride<{ limit: number; windowMs: number }>(
      RATE_LIMIT,
      [context.getHandler(), context.getClass()],
    ) ?? { limit: 180, windowMs: 60_000 };
    const now = Date.now();
    const rawIdentity = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const identity = createHash('sha256').update(rawIdentity).digest('hex');
    const key = `${identity}:${request.method}:${request.route?.path ?? request.path}`;
    const distributedCount = await this.sessions.consumeRateLimit(key, policy.windowMs);
    if (distributedCount !== null) {
      if (distributedCount > policy.limit) {
        throw new HttpException(
          '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    }
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + policy.windowMs });
    } else {
      current.count += 1;
      if (current.count > policy.limit) {
        throw new HttpException(
          '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    this.calls += 1;
    if (this.calls % 500 === 0) {
      for (const [bucketKey, bucket] of this.buckets)
        if (bucket.resetAt <= now) this.buckets.delete(bucketKey);
    }
    return true;
  }
}

export function ensureCsrfToken(request: Request): string {
  if (!request.session.csrfToken) request.session.csrfToken = randomBytes(32).toString('base64url');
  return request.session.csrfToken;
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
