import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { AlertStatus, NotificationTopic, DisclosureDetailType } from '@orsem/contracts';

const instant = { type: 'datetime' as const, precision: 3 };
@Entity({ name: 'notification_preferences' })
export class NotificationPreferenceEntity {
  @PrimaryColumn({ name: 'owner_key', type: 'varchar', length: 48 }) ownerKey!: string;
  @Column({ type: 'boolean', default: false }) enabled!: boolean;
  @Column({ name: 'topics_json', type: 'json' }) topicsJson!: NotificationTopic[];
  @Column({ name: 'watchlist_only', type: 'boolean', default: true }) watchlistOnly!: boolean;
  @Column({ name: 'filing_types_json', type: 'json', nullable: true }) filingTypesJson!:
    DisclosureDetailType[] | null;
  @CreateDateColumn({ name: 'created_at', ...instant }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', ...instant }) updatedAt!: Date;
}

@Entity({ name: 'push_subscriptions' })
@Index('ux_push_subscription_endpoint', ['endpointHash'], { unique: true })
@Index('ix_push_subscription_owner', ['ownerKey'])
export class PushSubscriptionEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @Column({ name: 'owner_key', type: 'varchar', length: 48 }) ownerKey!: string;
  @Column({ type: 'text' }) endpoint!: string;
  @Column({ name: 'endpoint_hash', type: 'char', length: 64 }) endpointHash!: string;
  @Column({ type: 'varchar', length: 100 }) p256dh!: string;
  @Column({ type: 'varchar', length: 32 }) auth!: string;
  @Column({ name: 'device_name', type: 'varchar', length: 80 }) deviceName!: string;
  @Column({ name: 'expiration_time', ...instant, nullable: true }) expirationTime!: Date | null;
  @Column({ name: 'last_seen_at', ...instant }) lastSeenAt!: Date;
  @CreateDateColumn({ name: 'created_at', ...instant }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', ...instant }) updatedAt!: Date;
}

@Entity({ name: 'push_deliveries' })
@Index('ux_push_delivery_dedupe', ['dedupeKey'], { unique: true })
@Index('ix_push_delivery_available', ['status', 'availableAt'])
@Index('ix_push_delivery_subscription', ['subscriptionId'])
export class PushDeliveryEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @Column({ name: 'subscription_id', type: 'char', length: 36 }) subscriptionId!: string;
  @Column({ name: 'owner_key', type: 'varchar', length: 48 }) ownerKey!: string;
  @Column({ name: 'dedupe_key', type: 'varchar', length: 255 }) dedupeKey!: string;
  @Column({ name: 'alert_id', type: 'char', length: 36, nullable: true }) alertId!: string | null;
  @Column({ name: 'event_cluster_id', type: 'char', length: 36, nullable: true }) eventClusterId!:
    string | null;
  @Column({ type: 'varchar', length: 20 }) topic!: NotificationTopic | 'TEST';
  @Column({ type: 'varchar', length: 16 }) status!: AlertStatus;
  @Column({ name: 'payload_json', type: 'json' }) payloadJson!: Record<string, unknown>;
  @Column({ name: 'available_at', ...instant }) availableAt!: Date;
  @Column({ name: 'lease_until', ...instant, nullable: true }) leaseUntil!: Date | null;
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
  @Column({ name: 'sent_at', ...instant, nullable: true }) sentAt!: Date | null;
  @CreateDateColumn({ name: 'created_at', ...instant }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', ...instant }) updatedAt!: Date;
}
