import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotImplementedException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  backfillRequestSchema,
  ConnectorStatus,
  cursorQuerySchema,
  type ConnectorHealth,
} from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { Inject } from '@nestjs/common';
import { Public } from '../security/security';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { OrsemDataService } from '../resources/orsem-data.service';
import { parseWith } from '../common/zod';
import { RateLimit } from '../security/security';
import { WorkerQueueService } from './worker-queue.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly data: OrsemDataService,
    private readonly sessions: SessionRuntimeService,
  ) {}

  @Get('live')
  @Public()
  live() {
    return { status: 'ok', checkedAt: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  ready() {
    const database = this.data.databaseHealth();
    const sessions = this.sessions.health;
    if (!this.data.fixtureMode && (!database.ready || !sessions.ready)) {
      throw new HttpException(
        { status: 'degraded', database, sessions },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: this.data.fixtureMode ? 'fixture' : 'ready',
      database,
      sessions,
      checkedAt: new Date().toISOString(),
    };
  }
}

@Controller('operations')
export class OperationsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly data: OrsemDataService,
    private readonly sessions: SessionRuntimeService,
    private readonly workerQueue: WorkerQueueService,
  ) {}

  @Get('health')
  async health() {
    return {
      mode: this.config.fixtureMode ? 'fixture' : 'database',
      database: this.data.databaseHealth(),
      sessions: this.sessions.health,
      connectors: await this.connectorList(),
      checkedAt: new Date().toISOString(),
    };
  }

  @Get('connectors')
  connectorList(): Promise<ConnectorHealth[]> {
    return this.buildConnectorList();
  }

  @Get('sources')
  async sources() {
    const items = await this.data.connectorSourceViews();
    return { items, nextCursor: null, pageInfo: { nextCursor: null, hasMore: false } };
  }

  @Get('runs')
  runs(@Query() query: unknown) {
    return this.data.listOperationRuns(parseWith(cursorQuerySchema, query));
  }

  @Get('queues')
  queues() {
    return this.data.listQueueMetrics();
  }

  @Post('filings/:id/reprocess')
  reprocess(@Param('id') id: string) {
    return this.data.enqueueReprocess(id);
  }

  @Post('retry/:runId')
  retryRun(): never {
    throw new NotImplementedException(
      '실행 단위 재시도는 아직 안전한 worker 계약이 없습니다. 개별 공시는 /operations/filings/:id/reprocess를 사용하세요.',
    );
  }

  @Post('backfills')
  @RateLimit(5, 60_000)
  backfill(@Body() body: unknown) {
    return this.workerQueue.enqueueBackfill(parseWith(backfillRequestSchema, body));
  }

  @Post('alpaca/assets/sync')
  @RateLimit(2, 60_000)
  syncAlpacaAssets() {
    return this.workerQueue.enqueueAlpacaAssetSync();
  }

  private async buildConnectorList(): Promise<ConnectorHealth[]> {
    const persisted = await this.data.connectors();
    const byName = new Map(persisted.map((item) => [item.connector.toLowerCase(), item]));
    const now = new Date().toISOString();
    const irConfigured = await this.data.hasCompatibleIrSources();
    const configured = (connector: string, yes: boolean, message: string): ConnectorHealth => {
      return (
        (connector === 'toss' && !yes ? undefined : byName.get(connector)) ?? {
          connector,
          status: yes ? ConnectorStatus.DEGRADED : ConnectorStatus.UNCONFIGURED,
          message: yes ? '설정됨; 아직 성공 상태가 기록되지 않았습니다.' : message,
          lastSuccessAt: null,
          lastFailureAt: null,
          checkedAt: now,
        }
      );
    };
    return [
      configured('opendart', Boolean(this.config.opendartApiKey), 'OPENDART_API_KEY가 없습니다.'),
      configured(
        'toss',
        Boolean(this.config.tossClientId && this.config.tossClientSecret),
        '토스증권 API 자격 증명이 설정되지 않았습니다.',
      ),
      configured(
        'naver',
        Boolean(this.config.naverClientId && this.config.naverClientSecret),
        'NAVER 자격 증명이 없습니다.',
      ),
      configured('sec', Boolean(this.config.secUserAgent), 'SEC_USER_AGENT가 없습니다.'),
      configured('gdelt', this.config.gdeltEnabled, 'GDELT_ENABLED가 꺼져 있습니다.'),
      configured('ir', irConfigured, '지원되는 공개 HTTPS RSS/Atom IR 피드가 없습니다.'),
      configured(
        'ai',
        Boolean(this.config.aiEnabled && this.config.aiBaseUrl && this.config.aiModel),
        'AI 분류기가 비활성화되었습니다.',
      ),
    ];
  }
}
