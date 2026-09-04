import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  notificationPreferencesSchema,
  notificationTestSchema,
  pushSubscriptionInputSchema,
} from '@orsem/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { parseWith } from '../common/zod';
import { OwnNotificationAccess, RateLimit } from '../security/security';
import { NotificationsService, type NotificationOwner } from './notifications.service';

export function notificationOwner(request: Request): NotificationOwner {
  const { adminId, memberId } = request.session ?? {};
  if (Boolean(adminId) === Boolean(memberId))
    throw new UnauthorizedException('로그인이 필요합니다.');
  return adminId
    ? { key: `ADMIN:${adminId}`, isAdmin: true }
    : { key: `MEMBER:${memberId!}`, isAdmin: false };
}

@Controller('notifications')
@OwnNotificationAccess()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('settings')
  settings(@Req() request: Request) {
    return this.notifications.settings(notificationOwner(request));
  }

  @Patch('settings')
  @RateLimit(30)
  updateSettings(@Body() body: unknown, @Req() request: Request) {
    return this.notifications.updateSettings(
      notificationOwner(request),
      parseWith(notificationPreferencesSchema, body),
    );
  }

  @Post('subscriptions')
  @RateLimit(20)
  subscribe(@Body() body: unknown, @Req() request: Request) {
    return this.notifications.subscribe(
      notificationOwner(request),
      parseWith(pushSubscriptionInputSchema, body),
    );
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  @RateLimit(30)
  async unsubscribe(@Param('id') id: string, @Req() request: Request) {
    await this.notifications.unsubscribe(notificationOwner(request), parseWith(z.uuid(), id));
  }

  @Post('test')
  @RateLimit(5)
  test(@Body() body: unknown, @Req() request: Request) {
    return this.notifications.test(
      notificationOwner(request),
      parseWith(notificationTestSchema, body).subscriptionId,
    );
  }
}
