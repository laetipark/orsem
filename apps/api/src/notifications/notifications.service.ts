import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  companyNotificationSettingsSchema,
  notificationPreferencesSchema,
  DEFAULT_NOTIFICATION_FILING_TYPES,
  notificationSettingsSchema,
  pushSubscriptionInputSchema,
} from '@orsem/contracts';
import {
  CompanyEntity,
  MarketLeaderScopeEntity,
  NotificationCompanyPreferenceEntity,
  NotificationPreferenceEntity,
  PushDeliveryEntity,
  PushSubscriptionEntity,
} from '@orsem/database';
import { createHash, ECDH, randomUUID } from 'node:crypto';
import { In, type EntityManager } from 'typeorm';
import type { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';

export interface NotificationOwner {
  key: string;
  isAdmin: boolean;
}
type Preferences = z.input<typeof notificationPreferencesSchema>;
type SubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;
const defaultTopics = ['FILINGS', 'ANALYSIS', 'CORRECTIONS', 'NEWS'] as const;

@Injectable()
export class NotificationsService {
  private readonly fixturePreferences = new Map<string, NotificationPreferenceEntity>();
  private readonly fixtureSubscriptions = new Map<string, PushSubscriptionEntity>();
  private readonly fixtureCompanyPreferences = new Map<
    string,
    NotificationCompanyPreferenceEntity
  >();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly database: DatabaseRuntimeService,
    @Optional() private readonly fixtures?: FixtureStoreService,
  ) {}

  private async assertCompany(companyId: string): Promise<void> {
    const exists = this.config.fixtureMode
      ? this.fixtures?.companies.some((company) => company.id === companyId)
      : await this.database
          .requireDataSource()
          .getRepository(CompanyEntity)
          .existsBy({ id: companyId });
    if (!exists) throw new NotFoundException('종목을 찾을 수 없습니다.');
  }

  async companySettings(owner: NotificationOwner, companyId: string) {
    await this.assertCompany(companyId);
    const preference = await this.preference(owner);
    const repository = this.config.fixtureMode ? null : this.database.requireDataSource();
    const override = repository
      ? await repository
          .getRepository(NotificationCompanyPreferenceEntity)
          .findOneBy({ ownerKey: owner.key, companyId })
      : this.fixtureCompanyPreferences.get(`${owner.key}:${companyId}`);
    const marketLeader = repository
      ? await repository.getRepository(MarketLeaderScopeEntity).existsBy({ companyId })
      : false; // Fixture market selection is unconfigured, as on the dashboard.
    const subscriptions = repository
      ? await repository.getRepository(PushSubscriptionEntity).findBy({ ownerKey: owner.key })
      : [...this.fixtureSubscriptions.values()].filter((item) => item.ownerKey === owner.key);
    const now = new Date();
    return companyNotificationSettingsSchema.parse({
      companyId,
      enabled: override?.enabled ?? (!preference.watchlistOnly || marketLeader),
      inherited: !override,
      globalEnabled: preference.enabled,
      pushConfigured: this.pushConfigured && !this.config.fixtureMode,
      hasActiveSubscription: subscriptions.some(
        (item) => !item.expirationTime || item.expirationTime > now,
      ),
    });
  }

  async updateCompanySettings(
    owner: NotificationOwner,
    companyId: string,
    input: { enabled: boolean },
  ) {
    await this.assertCompany(companyId);
    if (this.config.fixtureMode) {
      const key = `${owner.key}:${companyId}`;
      const existing = this.fixtureCompanyPreferences.get(key);
      if (!existing || existing.enabled !== input.enabled) {
        const now = new Date();
        this.fixtureCompanyPreferences.set(
          key,
          Object.assign(new NotificationCompanyPreferenceEntity(), {
            ownerKey: owner.key,
            companyId,
            enabled: input.enabled,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          }),
        );
      }
    } else {
      await this.ownerTransaction(owner, async (manager) => {
        const repository = manager.getRepository(NotificationCompanyPreferenceEntity);
        const existing = await repository.findOneBy({ ownerKey: owner.key, companyId });
        if (existing?.enabled === input.enabled) return;
        await repository.save(
          repository.create({
            ...existing,
            ownerKey: owner.key,
            companyId,
            enabled: input.enabled,
            updatedAt: new Date(),
          }),
        );
        // The delivery worker rechecks this row before sending. Do not touch the global
        // preference timestamp or cancel unrelated companies' deliveries.
      });
    }
    return this.companySettings(owner, companyId);
  }

  private get pushConfigured(): boolean {
    return this.config.webPush.enabled && Boolean(this.config.webPush.publicKey);
  }

  private defaultPreference(owner: NotificationOwner): NotificationPreferenceEntity {
    const now = new Date();
    return Object.assign(new NotificationPreferenceEntity(), {
      ownerKey: owner.key,
      enabled: false,
      topicsJson: [...defaultTopics],
      filingTypesJson: [...DEFAULT_NOTIFICATION_FILING_TYPES],
      watchlistOnly: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async preference(owner: NotificationOwner): Promise<NotificationPreferenceEntity> {
    const row = this.config.fixtureMode
      ? this.fixturePreferences.get(owner.key)
      : await this.database
          .requireDataSource()
          .getRepository(NotificationPreferenceEntity)
          .findOneBy({ ownerKey: owner.key });
    return row ?? this.defaultPreference(owner);
  }

  async settings(owner: NotificationOwner) {
    const preference = await this.preference(owner);
    const subscriptions = this.config.fixtureMode
      ? [...this.fixtureSubscriptions.values()].filter((item) => item.ownerKey === owner.key)
      : await this.database
          .requireDataSource()
          .getRepository(PushSubscriptionEntity)
          .find({ where: { ownerKey: owner.key }, order: { createdAt: 'DESC' } });
    return notificationSettingsSchema.parse({
      enabled: preference.enabled,
      topics: preference.topicsJson.filter((topic) => owner.isAdmin || topic !== 'OPERATIONS'),
      watchlistOnly: preference.watchlistOnly,
      filingTypes: preference.filingTypesJson ?? DEFAULT_NOTIFICATION_FILING_TYPES,
      pushConfigured: this.pushConfigured && !this.config.fixtureMode,
      publicKey:
        this.pushConfigured && !this.config.fixtureMode ? this.config.webPush.publicKey : null,
      subscriptions: subscriptions.map((item) => ({
        id: item.id,
        deviceName: item.deviceName,
        createdAt: item.createdAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
      })),
    });
  }

  private async ownerTransaction<T>(
    owner: NotificationOwner,
    work: (manager: EntityManager, preference: NotificationPreferenceEntity) => Promise<T>,
  ): Promise<T> {
    return this.database.requireDataSource().transaction(async (manager) => {
      const repository = manager.getRepository(NotificationPreferenceEntity);
      await repository
        .createQueryBuilder()
        .insert()
        .values(this.defaultPreference(owner))
        .orIgnore()
        .execute();
      const preference = await repository
        .createQueryBuilder('preference')
        .setLock('pessimistic_write')
        .where('preference.ownerKey = :ownerKey', { ownerKey: owner.key })
        .getOneOrFail();
      return work(manager, preference);
    });
  }

  async updateSettings(owner: NotificationOwner, input: Preferences) {
    if (!owner.isAdmin && input.topics.includes('OPERATIONS')) {
      throw new ForbiddenException('운영 알림은 관리자만 설정할 수 있습니다.');
    }
    const apply = (preference: NotificationPreferenceEntity) => {
      preference.enabled = input.enabled;
      preference.topicsJson = [...new Set(input.topics)];
      preference.watchlistOnly = input.watchlistOnly;
      if (input.filingTypes !== undefined) preference.filingTypesJson = [...input.filingTypes];
      preference.updatedAt = new Date();
    };
    if (this.config.fixtureMode) {
      const preference = await this.preference(owner);
      apply(preference);
      this.fixturePreferences.set(owner.key, preference);
    } else {
      await this.ownerTransaction(owner, async (manager, preference) => {
        apply(preference);
        await manager.getRepository(NotificationPreferenceEntity).save(preference);
        // Pending deliveries use the newly selected policy; cancel older queued decisions.
        await manager
          .getRepository(PushDeliveryEntity)
          .update(
            { ownerKey: owner.key, status: In(['PENDING', 'SENDING']) },
            { status: 'CANCELLED', leaseUntil: null, lastError: null },
          );
      });
    }
    return this.settings(owner);
  }

  private validateSubscription(input: SubscriptionInput): void {
    const publicKey = Buffer.from(input.keys.p256dh, 'base64url');
    const auth = Buffer.from(input.keys.auth, 'base64url');
    if (
      publicKey.length !== 65 ||
      publicKey[0] !== 4 ||
      auth.length !== 16 ||
      publicKey.toString('base64url') !== input.keys.p256dh ||
      auth.toString('base64url') !== input.keys.auth
    ) {
      throw new BadRequestException('브라우저 푸시 구독 키가 올바르지 않습니다.');
    }
    try {
      ECDH.convertKey(publicKey, 'prime256v1');
    } catch {
      throw new BadRequestException('브라우저 푸시 공개키가 올바르지 않습니다.');
    }
    if (
      input.expirationTime !== null &&
      (input.expirationTime <= Date.now() || input.expirationTime > 253402300799999)
    ) {
      throw new BadRequestException('만료된 구독입니다. 브라우저에서 다시 연결해 주세요.');
    }
  }

  async subscribe(owner: NotificationOwner, input: SubscriptionInput): Promise<{ id: string }> {
    this.validateSubscription(input);
    if (!this.config.fixtureMode && !this.pushConfigured)
      throw new ServiceUnavailableException('브라우저 알림 연결 설정이 필요합니다.');
    const endpoint = new URL(input.endpoint).href;
    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    const populate = (existing?: PushSubscriptionEntity | null): PushSubscriptionEntity => {
      if (existing && existing.ownerKey !== owner.key) {
        throw new ConflictException(
          '다른 계정에 연결된 브라우저 구독입니다. 기존 계정에서 연결을 해제해 주세요.',
        );
      }
      const now = new Date();
      return Object.assign(existing ?? new PushSubscriptionEntity(), {
        id: existing?.id ?? randomUUID(),
        ownerKey: owner.key,
        endpoint,
        endpointHash,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        deviceName: input.deviceName,
        expirationTime: input.expirationTime === null ? null : new Date(input.expirationTime),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
      });
    };
    if (this.config.fixtureMode) {
      const existing = [...this.fixtureSubscriptions.values()].find(
        (item) => item.endpointHash === endpointHash,
      );
      const row = populate(existing);
      if (
        !existing &&
        [...this.fixtureSubscriptions.values()].filter((item) => item.ownerKey === owner.key)
          .length >= 10
      ) {
        throw new ConflictException(
          '브라우저 구독은 계정당 최대 10개입니다. 이전 기기를 해제해 주세요.',
        );
      }
      this.fixtureSubscriptions.set(row.id, row);
      return { id: row.id };
    }
    try {
      return await this.ownerTransaction(owner, async (manager) => {
        const repository = manager.getRepository(PushSubscriptionEntity);
        const existing = await repository.findOneBy({ endpointHash });
        const row = populate(existing);
        if (!existing && (await repository.countBy({ ownerKey: owner.key })) >= 10) {
          throw new ConflictException(
            '브라우저 구독은 계정당 최대 10개입니다. 이전 기기를 해제해 주세요.',
          );
        }
        await repository.save(row);
        return { id: row.id };
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ER_DUP_ENTRY') {
        throw new ConflictException('이미 연결된 브라우저 구독입니다. 기존 연결을 확인해 주세요.');
      }
      if (error instanceof HttpException) throw error;
      // TypeORM write errors can include endpoint and encryption keys in their parameters.
      throw new ServiceUnavailableException(
        '브라우저 알림 구독을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
  }

  async unsubscribe(owner: NotificationOwner, id: string): Promise<void> {
    if (this.config.fixtureMode) {
      const row = this.fixtureSubscriptions.get(id);
      if (!row || row.ownerKey !== owner.key)
        throw new NotFoundException('브라우저 구독을 찾을 수 없습니다.');
      this.fixtureSubscriptions.delete(id);
      return;
    }
    await this.ownerTransaction(owner, async (manager) => {
      const repository = manager.getRepository(PushSubscriptionEntity);
      if (!(await repository.findOneBy({ id, ownerKey: owner.key })))
        throw new NotFoundException('브라우저 구독을 찾을 수 없습니다.');
      await manager
        .getRepository(PushDeliveryEntity)
        .update(
          { ownerKey: owner.key, subscriptionId: id, status: In(['PENDING', 'SENDING']) },
          { status: 'CANCELLED', leaseUntil: null, lastError: null },
        );
      await repository.delete({ id, ownerKey: owner.key });
    });
  }

  async test(
    owner: NotificationOwner,
    subscriptionId: string,
  ): Promise<{ queued: true; simulated?: true }> {
    const validate = (
      preference: NotificationPreferenceEntity,
      subscription: PushSubscriptionEntity | null | undefined,
    ) => {
      if (!subscription || subscription.ownerKey !== owner.key)
        throw new NotFoundException('브라우저 구독을 찾을 수 없습니다.');
      if (!preference.enabled) throw new BadRequestException('알림을 먼저 켜 주세요.');
      if (subscription.expirationTime && subscription.expirationTime.getTime() <= Date.now())
        throw new BadRequestException('만료된 구독입니다. 브라우저에서 다시 연결해 주세요.');
    };
    if (this.config.fixtureMode) {
      validate(await this.preference(owner), this.fixtureSubscriptions.get(subscriptionId));
      return { queued: true, simulated: true };
    }
    if (!this.pushConfigured)
      throw new ServiceUnavailableException('브라우저 알림 연결 설정이 필요합니다.');
    return this.ownerTransaction(owner, async (manager, preference) => {
      const subscription = await manager
        .getRepository(PushSubscriptionEntity)
        .findOneBy({ id: subscriptionId, ownerKey: owner.key });
      validate(preference, subscription);
      const id = randomUUID();
      await manager.getRepository(PushDeliveryEntity).save({
        id,
        subscriptionId,
        ownerKey: owner.key,
        dedupeKey: `test:${id}`,
        alertId: null,
        eventClusterId: null,
        topic: 'TEST',
        status: 'PENDING',
        payloadJson: {
          title: 'ORSEM 알림 테스트',
          body: '이 브라우저의 알림 연결을 확인했습니다.',
          url: '/settings/notifications',
          tag: `test:${id}`,
        },
        availableAt: new Date(),
        leaseUntil: null,
        attempts: 0,
        lastError: null,
        sentAt: null,
      });
      return { queued: true };
    });
  }
}
