import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import {
  loginRequestSchema,
  memberReviewSchema,
  memberStatusSchema,
  passwordChangeSchema,
  totpConfirmSchema,
} from '@orsem/contracts';
import { z } from 'zod';
import { parseWith } from '../common/zod';
import { ensureCsrfToken, Public, RateLimit } from '../security/security';
import { AuthService } from './auth.service';
import { MemberService } from './member.service';
import { regenerateSession } from './session';
import { authenticatedSessionIsValid } from './session-lifetime';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly members: MemberService,
  ) {}

  @Get('session')
  @Public()
  async session(@Req() request: Request) {
    if (
      (request.session.adminId || request.session.memberId) &&
      !authenticatedSessionIsValid(request.session)
    )
      await regenerateSession(request);
    const admin = request.session.adminId
      ? await this.auth.getAdmin(request.session.adminId)
      : null;
    const member =
      !admin && request.session.memberId
        ? await this.members.getMember(request.session.memberId)
        : null;
    const user = admin
      ? {
          ...admin,
          displayName: null,
          role: 'ADMIN' as const,
          provider: 'LOCAL' as const,
          status: 'APPROVED' as const,
        }
      : member
        ? {
            id: member.id,
            email: null,
            totpEnabled: false,
            displayName: member.displayName,
            role: member.role,
            provider: member.provider,
            status: member.status,
          }
        : null;
    return {
      authenticated: user !== null,
      canAccess: Boolean(admin || member?.status === 'APPROVED'),
      csrfToken: ensureCsrfToken(request),
      user,
      setupRequired: await this.auth.setupRequired(),
    };
  }

  @Post('login')
  @Public()
  @RateLimit(5, 60_000)
  async login(@Body() body: unknown, @Req() request: Request) {
    const input = parseWith(loginRequestSchema, body);
    const admin = await this.auth.authenticate(
      input.email,
      input.password,
      input.totpCode,
      input.recoveryCode,
      {
        ipHash: request.ip ? createHash('sha256').update(request.ip).digest('hex') : null,
        userAgent: request.header('user-agent')?.slice(0, 500) ?? null,
      },
    );
    await regenerateSession(request);
    request.session.adminId = admin.id;
    request.session.sessionStartedAt = new Date().toISOString();
    return {
      authenticated: true,
      canAccess: true,
      csrfToken: ensureCsrfToken(request),
      user: { ...admin, displayName: null, role: 'ADMIN', provider: 'LOCAL', status: 'APPROVED' },
      setupRequired: false,
    };
  }

  @Post('logout')
  @Public()
  @HttpCode(200)
  async logout(@Req() request: Request) {
    // 세션 재생성으로 인증 세션을 무효화하고 로그인 화면에 필요한
    // 새 익명 세션과 CSRF 토큰을 즉시 발급합니다.
    await regenerateSession(request);
    return {
      authenticated: false,
      canAccess: false,
      csrfToken: ensureCsrfToken(request),
      user: null,
      setupRequired: await this.auth.setupRequired(),
    };
  }

  @Get('members')
  listMembers(@Query() query: unknown) {
    const input = parseWith(z.object({ status: memberStatusSchema.optional() }), query);
    return this.members.list(input.status);
  }

  @Patch('members/:id')
  @RateLimit(30, 60_000)
  reviewMember(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    return this.members.review(
      id,
      parseWith(memberReviewSchema, body).status,
      request.session.adminId!,
    );
  }

  @Post('totp/enroll')
  @RateLimit(5, 60_000)
  enroll(@Req() request: Request) {
    return this.auth.beginTotp(request.session.adminId!);
  }

  @Post('totp/confirm')
  @RateLimit(10, 60_000)
  confirm(@Body() body: unknown, @Req() request: Request) {
    return this.auth.confirmTotp(request.session.adminId!, parseWith(totpConfirmSchema, body).code);
  }

  @Post('recovery-codes/regenerate')
  @RateLimit(3, 60_000)
  regenerateRecovery(@Req() request: Request) {
    return this.auth
      .replaceRecoveryCodes(request.session.adminId!)
      .then((recoveryCodes) => ({ recoveryCodes }));
  }

  @Patch('password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Req() request: Request): Promise<void> {
    const input = parseWith(passwordChangeSchema, body);
    await this.auth.changePassword(
      request.session.adminId!,
      input.currentPassword,
      input.newPassword,
    );
  }
}
