import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  botCompanyQuerySchema,
  botRecentQuerySchema,
  deliveryAckSchema,
  deliveryPullSchema,
  deviceCommandSchema,
  deviceHeartbeatSchema,
  pairingClaimSchema,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import { DeviceRoute, Public, RateLimit, ServiceRoute, SkipCsrf } from '../security/security';
import { BotService, type AuthenticatedDevice } from './bot.service';
import { OrsemDataService } from '../resources/orsem-data.service';

type DeviceRequest = Request & { orsemDevice?: AuthenticatedDevice };

function bearer(request: Request): string | undefined {
  const header = request.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(private readonly bots: BotService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DeviceRequest>();
    request.orsemDevice = await this.bots.authenticateDevice(bearer(request));
    return true;
  }
}

@Injectable()
export class DiscordServiceGuard implements CanActivate {
  constructor(private readonly bots: BotService) {}
  canActivate(context: ExecutionContext): boolean {
    this.bots.validateDiscordToken(bearer(context.switchToHttp().getRequest<Request>()));
    return true;
  }
}

@Controller('bots/messenger')
export class MessengerController {
  constructor(private readonly bots: BotService) {}

  @Post('pairings')
  @RateLimit(5, 60_000)
  createPairing(@Req() request: Request) {
    return this.bots.createPairing(request.session.adminId!);
  }

  @Post('pair')
  @Public()
  @SkipCsrf()
  @RateLimit(10, 60_000)
  pair(@Body() body: unknown) {
    return this.bots.claimPairing(parseWith(pairingClaimSchema, body));
  }

  @Post('heartbeat')
  @DeviceRoute()
  @SkipCsrf()
  @UseGuards(DeviceTokenGuard)
  heartbeat(@Body() body: unknown, @Req() request: DeviceRequest) {
    return this.bots.heartbeat(request.orsemDevice!, parseWith(deviceHeartbeatSchema, body));
  }

  @Post('command')
  @DeviceRoute()
  @SkipCsrf()
  @UseGuards(DeviceTokenGuard)
  @RateLimit(60, 60_000)
  command(@Body() body: unknown, @Req() request: DeviceRequest) {
    return this.bots.executeCommand(request.orsemDevice!, parseWith(deviceCommandSchema, body));
  }

  @Post('outbox/pull')
  @DeviceRoute()
  @SkipCsrf()
  @UseGuards(DeviceTokenGuard)
  pull(@Body() body: unknown, @Req() request: DeviceRequest) {
    const input = parseWith(deliveryPullSchema, body);
    if (request.orsemDevice!.externalDeviceId !== input.deviceId) {
      throw new UnauthorizedException('요청 기기 ID가 토큰과 일치하지 않습니다.');
    }
    return this.bots.pull('MESSENGERBOTR', input.limit, input.leaseSeconds, request.orsemDevice!);
  }

  @Post('outbox/:deliveryId/ack')
  @DeviceRoute()
  @SkipCsrf()
  @UseGuards(DeviceTokenGuard)
  ack(
    @Param('deliveryId') deliveryId: string,
    @Body() body: unknown,
    @Req() request: DeviceRequest,
  ) {
    const input = parseWith(deliveryAckSchema, body);
    return this.bots.acknowledge(
      'MESSENGERBOTR',
      deliveryId,
      input.ok,
      input.error ?? null,
      request.orsemDevice!,
      input.externalMessageId,
    );
  }
}

@Controller('bots/discord')
@ServiceRoute()
@SkipCsrf()
@UseGuards(DiscordServiceGuard)
export class DiscordBotController {
  constructor(
    private readonly bots: BotService,
    private readonly data: OrsemDataService,
  ) {}

  @Get('status')
  async status() {
    const database = this.data.databaseHealth();
    const connectors = await this.data.connectors();
    const unhealthy = connectors.filter(
      (item) => !['HEALTHY', 'DISABLED', 'UNCONFIGURED'].includes(item.status),
    );
    return {
      summary: `${this.data.fixtureMode ? 'fixture 모드' : database.ready ? '데이터베이스 정상' : '데이터베이스 점검 필요'} · 검토 대상 커넥터 ${unhealthy.length}개`,
      asOf: new Date().toISOString(),
    };
  }

  @Get('recent')
  async recent(@Query() query: unknown) {
    const result = await this.data.listEvents(parseWith(botRecentQuerySchema, query));
    return { items: result.items.map(discordEvent) };
  }

  @Get('company')
  async company(@Query() query: unknown) {
    const input = parseWith(botCompanyQuerySchema, query);
    const result = await this.data.findCompanyEvents(input.q, 10);
    return { items: result.events.map(discordEvent) };
  }

  @Post('outbox/pull')
  pull(@Body() body: unknown) {
    const input = parseWith(
      z.object({
        limit: z.coerce.number().int().min(1).max(50).default(10),
        leaseSeconds: z.coerce.number().int().min(10).max(300).default(60),
      }),
      body,
    );
    return this.bots.pull('DISCORD', input.limit, input.leaseSeconds);
  }

  @Post('outbox/:deliveryId/ack')
  ack(@Param('deliveryId') deliveryId: string, @Body() body: unknown) {
    const input = parseWith(deliveryAckSchema, body);
    return this.bots.acknowledge(
      'DISCORD',
      deliveryId,
      input.ok,
      input.error ?? null,
      undefined,
      input.externalMessageId,
    );
  }
}

function discordEvent(event: Awaited<ReturnType<OrsemDataService['getEvent']>>) {
  return {
    company: event.company?.nameKo ?? '회사 미확인',
    type: event.filing?.detailType ?? event.canonicalEventType,
    summary: event.summary,
    observedAt: event.filing?.rceptDate ?? event.firstObservedAt,
    url: event.filing?.officialUrl,
  };
}
