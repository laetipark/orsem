import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AlertStatus,
  disclosureTypeLabels,
  displayDisclosureText,
  isSupportedFilingType,
  type Event,
  type Region,
} from '@orsem/contracts';
import {
  AlertDeliveryEntity,
  AlertEntity,
  BotCommandEntity,
  BotDeliveryEntity,
  BotRoomBindingEntity,
  DevicePairingEntity,
  EventClusterEntity,
  FILING_ALERT_INELIGIBLE,
  filingAlertIsEligible,
  MessengerDeviceEntity,
  MarketLeaderScopeEntity,
  marketLeaderCompanyIds,
} from '@orsem/database';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { In, type EntityManager } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { OrsemDataService } from '../resources/orsem-data.service';
import { CompanyInformationApiService } from '../resources/company-information.service';
import { NaverFocusNewsService } from '../news-search/naver-focus-news.service';
import { botKst, botNewsItems, messengerNews } from './bot-news';

export interface AuthenticatedDevice {
  id: string;
  externalDeviceId: string;
}

export interface LeasedBotDelivery {
  deliveryId: string;
  alertId: string;
  operation: 'SEND' | 'EDIT' | 'FOLLOW_UP';
  stage: 'DETECTED' | 'ENRICHED' | 'DIGEST';
  content: string;
  externalMessageId?: string | null;
}

@Injectable()
export class BotService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
    private readonly fixtures: FixtureStoreService,
    private readonly data: OrsemDataService,
    private readonly information: CompanyInformationApiService,
    private readonly naverNews: NaverFocusNewsService,
  ) {}

  private globalFilingTypeAllowed(alert: AlertEntity): boolean {
    return alertAllowedByGlobalTypes(alert.payloadJson, this.config.opendartGlobalAlertTypes);
  }

  async createPairing(adminId: string): Promise<{ code: string; expiresAt: string }> {
    const code = await this.uniquePairingCode();
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + this.config.messengerPairingTtlSeconds * 1000);
    if (this.config.fixtureMode) {
      this.fixtures.pairingCodes.set(codeHash, { adminId, expiresAt });
      return { code, expiresAt: expiresAt.toISOString() };
    }
    const repository = this.database.requireDataSource().getRepository(DevicePairingEntity);
    await repository.save(
      repository.create({
        codeHash,
        createdByAdminId: adminId,
        expiresAt,
        consumedAt: null,
        deviceId: null,
      }),
    );
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async claimPairing(input: {
    code: string;
    deviceId: string;
    room: string;
    authorHash: string;
    packageName: string;
    botVersion: string;
  }): Promise<{ deviceId: string; deviceToken: string; pairedAt: string }> {
    const pairingHash = sha256(input.code);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const now = new Date();
    if (this.config.fixtureMode) {
      const pairing = this.fixtures.pairingCodes.get(pairingHash);
      if (!pairing || pairing.expiresAt <= now)
        throw new UnauthorizedException('페어링 코드가 만료되었거나 올바르지 않습니다.');
      this.fixtures.pairingCodes.delete(pairingHash);
      this.fixtures.devices.set(input.deviceId, {
        id: randomUUID(),
        tokenHash,
        room: input.room,
        authorHash: input.authorHash,
        packageName: input.packageName,
        botVersion: input.botVersion,
        lastSeenAt: now,
      });
      return { deviceId: input.deviceId, deviceToken: token, pairedAt: now.toISOString() };
    }
    const source = this.database.requireDataSource();
    return source.transaction(async (manager) => {
      const pairing = await manager
        .getRepository(DevicePairingEntity)
        .createQueryBuilder('pairing')
        .setLock('pessimistic_write')
        .where('pairing.codeHash = :pairingHash', { pairingHash })
        .getOne();
      if (!pairing || pairing.consumedAt || pairing.expiresAt <= now) {
        throw new UnauthorizedException('페어링 코드가 만료되었거나 올바르지 않습니다.');
      }
      const devices = manager.getRepository(MessengerDeviceEntity);
      const existing = await devices.findOneBy({ externalDeviceId: input.deviceId });
      const device = devices.create({
        ...existing,
        externalDeviceId: input.deviceId,
        tokenHash,
        room: input.room,
        authorHash: input.authorHash,
        packageName: input.packageName,
        botVersion: input.botVersion,
        isActive: true,
        pairedAt: now,
        lastSeenAt: now,
      });
      await devices.save(device);
      pairing.consumedAt = now;
      pairing.deviceId = device.id;
      await manager.getRepository(DevicePairingEntity).save(pairing);
      const bindings = manager.getRepository(BotRoomBindingEntity);
      const roomHash = sha256(`${input.packageName}:${input.room}`);
      const binding = await bindings.findOneBy({ consumer: 'MESSENGERBOTR', roomHash });
      await bindings.save(
        bindings.create({
          ...binding,
          consumer: 'MESSENGERBOTR',
          deviceId: device.id,
          roomLabel: input.room,
          roomHash,
          isActive: true,
        }),
      );
      return { deviceId: input.deviceId, deviceToken: token, pairedAt: now.toISOString() };
    });
  }

  async authenticateDevice(token: string | undefined): Promise<AuthenticatedDevice> {
    if (!token) throw new UnauthorizedException('기기 토큰이 필요합니다.');
    const tokenHash = sha256(token);
    if (this.config.fixtureMode) {
      for (const [externalDeviceId, device] of this.fixtures.devices) {
        if (device.tokenHash === tokenHash) return { id: device.id, externalDeviceId };
      }
      throw new UnauthorizedException('기기 토큰이 올바르지 않습니다.');
    }
    const row = await this.database
      .requireDataSource()
      .getRepository(MessengerDeviceEntity)
      .findOneBy({ tokenHash, isActive: true });
    if (!row) throw new UnauthorizedException('기기 토큰이 올바르지 않습니다.');
    return { id: row.id, externalDeviceId: row.externalDeviceId };
  }

  async heartbeat(
    device: AuthenticatedDevice,
    input: {
      deviceId: string;
      botVersion?: string;
      appVersion?: string;
      room?: string | null;
      observedAt?: string;
      capabilities?: string[];
    },
  ) {
    this.assertDevice(device, input.deviceId);
    const now = new Date();
    if (this.config.fixtureMode) {
      const fixture = this.fixtures.devices.get(device.externalDeviceId);
      if (fixture) fixture.lastSeenAt = now;
    } else {
      const update: Pick<MessengerDeviceEntity, 'lastSeenAt'> &
        Partial<Pick<MessengerDeviceEntity, 'botVersion'>> = {
        lastSeenAt: now,
      };
      const version = input.botVersion ?? input.appVersion;
      if (version) update.botVersion = version;
      await this.database
        .requireDataSource()
        .getRepository(MessengerDeviceEntity)
        .update({ id: device.id }, update);
    }
    return { ok: true, serverTime: now.toISOString() };
  }

  async executeCommand(
    device: AuthenticatedDevice,
    input: { deviceId: string; command: string; query: string },
  ) {
    this.assertDevice(device, input.deviceId);
    const command = input.command.trim().toLowerCase();
    let response: Record<string, unknown>;
    if (command === 'recent' || command === '최근') {
      const events = await this.data.listEvents({ limit: 5 });
      response = {
        command: 'recent',
        events: events.items.map(compactEvent),
        message: formatMessengerEvents('최근 중요 이벤트', events.items),
      };
    } else if (command === 'company' || command === '기업' || command === '종목') {
      const result = await this.data.findCompanyEvents(input.query, 5);
      response = {
        command: 'company',
        company: result.company,
        events: result.events.map(compactEvent),
        message: result.company
          ? formatMessengerEvents(`${result.company.nameKo} 최근 이벤트`, result.events)
          : `\`${input.query}\`에 해당하는 회사를 찾지 못했습니다.`,
      };
    } else if (command === 'market' || command === '시장') {
      const result = await this.market(botRegion(input.query, 'kr') as 'kr' | 'us');
      response = {
        command: 'market',
        ...result,
        message: [
          `${result.label} 시가총액 상위 20`,
          `기준일: ${result.basisDate ?? '확인 대기'} · 월간 갱신`,
          ...(result.selectionMonth ? [`선정 월: ${result.selectionMonth}`] : []),
          ...(result.nextRefreshAt ? [`다음 갱신: ${botKst(result.nextRefreshAt)}`] : []),
          ...(result.sourceName ? [`출처: ${result.sourceName}`] : []),
          ...(result.status !== 'AVAILABLE' && result.reason ? [String(result.reason)] : []),
          ...result.items.map(
            (item) => `${item.rank}. ${item.nameKo} (${item.stockCode ?? item.ticker ?? ''})`,
          ),
          ...(!result.items.length ? ['확정된 시장 목록이 없습니다.'] : []),
        ].join('\n'),
      };
    } else if (command === 'news' || command === '뉴스') {
      const result = await this.news(botRegion(input.query, 'all'), 5);
      response = { command: 'news', ...result, message: messengerNews(result.items) };
    } else if (command === 'status' || command === '상태') {
      const database = this.data.databaseHealth();
      response = {
        command: 'status',
        fixtureMode: this.data.fixtureMode,
        database,
        message: `오르셈 상태: ${this.data.fixtureMode ? 'fixture' : database.ready ? '정상' : '점검 필요'}\n기준: ${botKst(new Date().toISOString())}`,
      };
    } else {
      response = {
        command,
        message: '지원 명령: status, recent, company, market, news',
        query: input.query,
      };
    }
    if (!this.config.fixtureMode) {
      const repository = this.database.requireDataSource().getRepository(BotCommandEntity);
      await repository.save(
        repository.create({
          deviceId: device.id,
          externalCommandId: randomUUID(),
          command: input.command,
          query: input.query,
          receivedAt: new Date(),
          // News can contain expiring Naver metadata. Persist command diagnostics only.
          responseJson:
            response.command === 'news'
              ? {
                  command: 'news',
                  itemCount: Array.isArray(response.items) ? response.items.length : 0,
                }
              : response,
        }),
      );
    }
    return response;
  }

  async market(region: 'kr' | 'us') {
    const selection = await this.information.selection();
    const group = selection.regions.find((item) => item.region === region);
    if (!group) throw new ServiceUnavailableException('시장 목록을 확인할 수 없습니다.');
    const items = (
      group.items as Array<{
        rank: number;
        id: string;
        nameKo: string;
        market: string;
        stockCode: string | null;
        ticker: string | null;
        marketCap: string | number;
      }>
    )
      .filter((item) => Number(item.rank) >= 1 && Number(item.rank) <= 20)
      .sort((a, b) => Number(a.rank) - Number(b.rank))
      .slice(0, 20);
    return { ...group, region, label: region === 'kr' ? '국내' : '미국', items };
  }

  async news(region: Region, limit: number) {
    const companyIds = this.config.fixtureMode
      ? new Set<string>()
      : await marketLeaderCompanyIds(this.database.requireDataSource(), region);
    const [stored, market, naver] = await Promise.all([
      this.data.listNews({ audience: 'BOT', region, scope: 'company', limit: 100 }),
      this.data.listNews({ audience: 'BOT', region, scope: 'market', limit: 20 }),
      // No companyId: read the existing short-lived snapshots without provider requests.
      this.naverNews.feed({ region, scope: 'company' }, 'BOT:PUBLIC'),
    ]);
    return {
      region,
      items: botNewsItems(
        [...stored.items, ...market.items, ...naver.groups.flat()],
        companyIds,
        region,
        limit,
      ),
      status: naver.status,
    };
  }

  async pull(
    consumer: 'DISCORD' | 'MESSENGERBOTR',
    limit: number,
    leaseSeconds: number,
    device?: AuthenticatedDevice,
  ): Promise<{ items: LeasedBotDelivery[]; leaseSeconds: number }> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);
    if (this.config.fixtureMode) {
      const rows = this.fixtures.deliveries
        .filter(
          (item) =>
            item.consumer === consumer &&
            (!device || item.deviceId === device.id || item.deviceId === null) &&
            item.availableAt <= now &&
            (item.status === AlertStatus.PENDING ||
              (item.status === AlertStatus.SENDING && item.leaseUntil && item.leaseUntil <= now)),
        )
        .slice(0, limit);
      for (const row of rows) {
        row.status = AlertStatus.SENDING;
        row.leaseUntil = leaseUntil;
        row.attempts += 1;
      }
      return { items: rows.map((row) => toWireDelivery(row)), leaseSeconds };
    }
    const source = this.database.requireDataSource();
    return source.transaction(async (manager) => {
      const qb = manager
        .getRepository(BotDeliveryEntity)
        .createQueryBuilder('delivery')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('delivery.consumer = :consumer', { consumer })
        .andWhere('delivery.availableAt <= :now', { now })
        .andWhere(
          '(delivery.status = :pending OR (delivery.status = :sending AND delivery.leaseUntil <= :now))',
          {
            pending: AlertStatus.PENDING,
            sending: AlertStatus.SENDING,
            now,
          },
        );
      if (device)
        qb.andWhere('(delivery.deviceId = :deviceId OR delivery.deviceId IS NULL)', {
          deviceId: device.id,
        });
      const rows = await qb.orderBy('delivery.availableAt', 'ASC').take(limit).getMany();
      const eligible: BotDeliveryEntity[] = [];
      for (const row of rows) {
        const alert = row.alertId
          ? await manager.getRepository(AlertEntity).findOneBy({ id: row.alertId })
          : null;
        if (
          row.alertId &&
          (!alert ||
            !(await filingAlertIsEligible(manager, alert)) ||
            !(await botAlertIsCurrentMarketLeader(manager, alert)) ||
            !this.globalFilingTypeAllowed(alert))
        ) {
          row.status = AlertStatus.CANCELLED;
          row.leaseUntil = null;
          row.lastError = FILING_ALERT_INELIGIBLE;
          continue;
        }
        row.status = AlertStatus.SENDING;
        row.leaseUntil = leaseUntil;
        row.attempts += 1;
        eligible.push(row);
      }
      await manager.getRepository(BotDeliveryEntity).save(rows);
      return { items: eligible.map((row) => toWireDelivery(row)), leaseSeconds };
    });
  }

  async acknowledge(
    consumer: 'DISCORD' | 'MESSENGERBOTR',
    deliveryId: string,
    ok: boolean,
    error: string | null,
    device?: AuthenticatedDevice,
    externalMessageId?: string | null,
  ): Promise<{ ok: true }> {
    if (this.config.fixtureMode) {
      const row = this.fixtures.deliveries.find(
        (item) => item.id === deliveryId && item.consumer === consumer,
      );
      if (!row || (device && row.deviceId !== null && row.deviceId !== device.id))
        throw new NotFoundException('전달 항목을 찾을 수 없습니다.');
      row.status = ok
        ? AlertStatus.ACKNOWLEDGED
        : row.attempts >= 5
          ? AlertStatus.FAILED
          : AlertStatus.PENDING;
      row.lastError = error;
      row.leaseUntil = null;
      if (!ok && row.status === AlertStatus.PENDING) {
        row.availableAt = new Date(
          Date.now() + Math.min(15 * 60_000, 2 ** Math.max(row.attempts, 1) * 1_000),
        );
      }
      if (externalMessageId) row.payload.externalMessageId = externalMessageId;
      return { ok: true };
    }
    const source = this.database.requireDataSource();
    // 연결 대상을 찾을 ID는 잠금 없이 읽고, 정정 취소와 알림 전송기가 사용하는
    // 공통 순서인 Alert -> AlertDelivery -> BotDelivery로 잠금을 획득합니다.
    // 최초 조회와 잠금 사이에 전송기가 연결 관계를 추가했다면 작업을 중단합니다.
    // 클라이언트는 잠금 순서를 어기지 않고 최신 상태로 안전하게 재시도할 수 있습니다.
    const snapshot = await source.getRepository(BotDeliveryEntity).findOneBy({
      id: deliveryId,
      consumer,
    });
    if (!snapshot || (device && snapshot.deviceId !== null && snapshot.deviceId !== device.id)) {
      throw new NotFoundException('전달 항목을 찾을 수 없습니다.');
    }
    return source.transaction(async (manager) => {
      const lockedAlert = snapshot.alertId
        ? await manager
            .getRepository(AlertEntity)
            .createQueryBuilder('alert')
            .setLock('pessimistic_write')
            .where('alert.id = :id', { id: snapshot.alertId })
            .getOne()
        : null;
      const linkedDelivery = snapshot.alertDeliveryId
        ? await manager
            .getRepository(AlertDeliveryEntity)
            .createQueryBuilder('delivery')
            .setLock('pessimistic_write')
            .where('delivery.id = :id', { id: snapshot.alertDeliveryId })
            .getOne()
        : null;
      const repository = manager.getRepository(BotDeliveryEntity);
      const row = await repository
        .createQueryBuilder('delivery')
        .setLock('pessimistic_write')
        .where('delivery.id = :deliveryId', { deliveryId })
        .andWhere('delivery.consumer = :consumer', { consumer })
        .getOne();
      if (!row || (device && row.deviceId !== null && row.deviceId !== device.id)) {
        throw new NotFoundException('전달 항목을 찾을 수 없습니다.');
      }
      if (row.alertId !== snapshot.alertId || row.alertDeliveryId !== snapshot.alertDeliveryId) {
        throw new ServiceUnavailableException(
          '전달 항목의 연결 정보가 변경되었습니다. 잠시 후 다시 시도하세요.',
        );
      }
      if (
        row.alertId &&
        (!lockedAlert ||
          !this.globalFilingTypeAllowed(lockedAlert) ||
          !(await botAlertIsCurrentMarketLeader(manager, lockedAlert)) ||
          !(await filingAlertIsEligible(manager, lockedAlert)))
      ) {
        row.status = AlertStatus.CANCELLED;
        row.leaseUntil = null;
        row.lastError = FILING_ALERT_INELIGIBLE;
        await repository.save(row);
        if (linkedDelivery) {
          linkedDelivery.status = AlertStatus.CANCELLED;
          await manager.getRepository(AlertDeliveryEntity).save(linkedDelivery);
        }
      }
      if (row.status === AlertStatus.CANCELLED) {
        if (externalMessageId) {
          row.externalMessageId = externalMessageId;
          await repository.save(row);
        }
        return { ok: true };
      }

      const acknowledgedAt = ok ? new Date() : null;
      row.status = ok
        ? AlertStatus.ACKNOWLEDGED
        : row.attempts >= 5
          ? AlertStatus.FAILED
          : AlertStatus.PENDING;
      row.acknowledgedAt = acknowledgedAt;
      row.leaseUntil = null;
      row.lastError = error;
      if (externalMessageId) row.externalMessageId = externalMessageId;
      if (!ok && row.status === AlertStatus.PENDING) {
        row.availableAt = new Date(
          Date.now() + Math.min(15 * 60_000, 2 ** Math.max(row.attempts, 1) * 1_000),
        );
      }
      await repository.save(row);

      if (linkedDelivery) {
        linkedDelivery.status = row.status;
        linkedDelivery.externalMessageId = row.externalMessageId;
        linkedDelivery.sentAt = ok ? acknowledgedAt : linkedDelivery.sentAt;
        linkedDelivery.acknowledgedAt = acknowledgedAt;
        linkedDelivery.errorMessage = error;
        await manager.getRepository(AlertDeliveryEntity).save(linkedDelivery);
      }

      // AlertEntity는 이벤트 전체의 알림 상태를 담습니다. 다른 채널, 특히 개인용
      // 웹 대시보드가 이미 받았다면 SENT를 유지합니다. 모든 개별 전달이
      // 최종 실패했을 때만 전체 실패 상태를 표시합니다.
      if (row.alertId && row.status === AlertStatus.FAILED) {
        const viableDeliveries = await manager.getRepository(AlertDeliveryEntity).count({
          where: {
            alertId: row.alertId,
            status: In([
              AlertStatus.PENDING,
              AlertStatus.SENDING,
              AlertStatus.SENT,
              AlertStatus.ACKNOWLEDGED,
            ]),
          },
        });
        if (viableDeliveries === 0) {
          await manager
            .getRepository(AlertEntity)
            .update({ id: row.alertId }, { status: AlertStatus.FAILED });
        }
      }
      return { ok: true };
    });
  }

  validateDiscordToken(token: string | undefined): void {
    if (!this.config.discordServiceToken)
      throw new ServiceUnavailableException('DISCORD_SERVICE_TOKEN이 설정되지 않았습니다.');
    if (!token || !hashEqual(sha256(token), sha256(this.config.discordServiceToken))) {
      throw new UnauthorizedException('Discord 서비스 토큰이 올바르지 않습니다.');
    }
  }

  private assertDevice(device: AuthenticatedDevice, claimedId: string): void {
    if (device.externalDeviceId !== claimedId)
      throw new UnauthorizedException('요청 기기 ID가 토큰과 일치하지 않습니다.');
  }

  private async uniquePairingCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const value = randomInt(0, 1_000_000).toString().padStart(6, '0');
      const hash = sha256(value);
      if (this.config.fixtureMode) {
        if (!this.fixtures.pairingCodes.has(hash)) return value;
        continue;
      }
      const existing = await this.database
        .requireDataSource()
        .getRepository(DevicePairingEntity)
        .findOneBy({ codeHash: hash });
      if (!existing) return value;
    }
    throw new ServiceUnavailableException(
      '페어링 코드를 생성할 수 없습니다. 잠시 후 다시 시도하세요.',
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function compactEvent(event: Event): Record<string, unknown> {
  return {
    id: event.id,
    type: event.canonicalEventType,
    company: event.company?.nameKo ?? null,
    summary: event.summary,
    rceptDate: event.filing?.rceptDate ?? null,
    firstObservedAt: event.firstObservedAt,
    officialUrl: event.filing?.officialUrl ?? null,
  };
}

function toWireDelivery(row: {
  id: string;
  alertId?: string | null;
  payload: Record<string, unknown>;
  externalMessageId?: string | null;
}): LeasedBotDelivery {
  const payload = row.payload;
  const phase = stringValue(payload.stage) ?? stringValue(payload.phase);
  const stage: LeasedBotDelivery['stage'] =
    phase === 'DIGEST'
      ? 'DIGEST'
      : phase === 'PARSED' || phase === 'ENRICHED'
        ? 'ENRICHED'
        : 'DETECTED';
  const operationValue = stringValue(payload.operation);
  const operation: LeasedBotDelivery['operation'] =
    operationValue === 'EDIT' || operationValue === 'FOLLOW_UP' ? operationValue : 'SEND';
  const content =
    stringValue(payload.content) ??
    [stringValue(payload.summary), stringValue(payload.message), stringValue(payload.officialUrl)]
      .filter(Boolean)
      .join('\n');
  return {
    deliveryId: row.id,
    alertId: row.alertId ?? stringValue(payload.alertId) ?? row.id,
    operation,
    stage,
    content: (content || '오르셈 새 관찰 이벤트').slice(0, 1_900),
    externalMessageId: row.externalMessageId ?? stringValue(payload.externalMessageId) ?? null,
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function formatMessengerEvents(heading: string, events: Event[]): string {
  if (events.length === 0) return `${heading}\n새 이벤트가 없습니다.`;
  const rows = events.map((event) => {
    const company = event.company?.nameKo ?? '회사 미확인';
    const date = botKst(event.filing?.rceptDate ?? event.firstObservedAt);
    const url = event.filing?.officialUrl ? `\n${event.filing.officialUrl}` : '';
    const type = event.filing?.detailType;
    const label =
      type && isSupportedFilingType(type)
        ? disclosureTypeLabels[type]
        : event.canonicalEventType === 'NEWS'
          ? '뉴스'
          : '공시';
    return `• ${company} · ${label}\n${displayDisclosureText(event.summary)}\n${date}${url}`;
  });
  return [heading, ...rows, '관찰 정보이며 단독 매매 신호가 아닙니다.'].join('\n');
}

function botRegion(value: string, fallback: Region): Region {
  const key = value.trim().toLowerCase();
  if (!key) return fallback;
  if (['kr', '국내', '한국'].includes(key)) return 'kr';
  if (['us', '미국'].includes(key)) return 'us';
  if (fallback === 'all' && ['all', '전체'].includes(key)) return 'all';
  throw new BadRequestException('지역은 국내 또는 미국을 선택해 주세요.');
}

export function alertAllowedByGlobalTypes(
  payload: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const type = payload['detailType'];
  return typeof type !== 'string' || !isSupportedFilingType(type) || allowed.includes(type);
}

/** Recheck the current monthly projection for deliveries queued before a selection change. */
export async function botAlertIsCurrentMarketLeader(
  manager: EntityManager,
  alert: AlertEntity,
): Promise<boolean> {
  if (alert.eventClusterId === null) return true;
  if (!alert.eventClusterId) return false;
  const event = await manager
    .getRepository(EventClusterEntity)
    .findOneBy({ id: alert.eventClusterId });
  if (!event?.companyId) return false;
  const current = await manager
    .getRepository(MarketLeaderScopeEntity)
    .findOneBy({ companyId: event.companyId });
  return Boolean(current?.realtimeAlerts && ['P1', 'P2'].includes(current.priority));
}
