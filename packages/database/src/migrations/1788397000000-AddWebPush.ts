import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWebPush1788397000000 implements MigrationInterface {
  name = 'AddWebPush1788397000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE notification_preferences (
      owner_key VARCHAR(48) NOT NULL PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      topics_json JSON NOT NULL,
      watchlist_only BOOLEAN NOT NULL DEFAULT TRUE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await queryRunner.query(`CREATE TABLE push_subscriptions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      owner_key VARCHAR(48) NOT NULL,
      endpoint TEXT NOT NULL,
      endpoint_hash CHAR(64) NOT NULL,
      p256dh VARCHAR(100) NOT NULL,
      auth VARCHAR(32) NOT NULL,
      device_name VARCHAR(80) NOT NULL,
      expiration_time DATETIME(3) NULL,
      last_seen_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_push_subscription_endpoint (endpoint_hash),
      KEY ix_push_subscription_owner (owner_key),
      CONSTRAINT fk_push_subscription_owner FOREIGN KEY (owner_key) REFERENCES notification_preferences(owner_key) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await queryRunner.query(`CREATE TABLE push_deliveries (
      id CHAR(36) NOT NULL PRIMARY KEY,
      subscription_id CHAR(36) NOT NULL,
      owner_key VARCHAR(48) NOT NULL,
      dedupe_key VARCHAR(255) NOT NULL,
      alert_id CHAR(36) NULL,
      event_cluster_id CHAR(36) NULL,
      topic VARCHAR(20) NOT NULL,
      status VARCHAR(16) NOT NULL,
      payload_json JSON NOT NULL,
      available_at DATETIME(3) NOT NULL,
      lease_until DATETIME(3) NULL,
      attempts INT UNSIGNED NOT NULL DEFAULT 0,
      last_error TEXT NULL,
      sent_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_push_delivery_dedupe (dedupe_key),
      KEY ix_push_delivery_available (status, available_at),
      KEY ix_push_delivery_subscription (subscription_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE push_deliveries');
    await queryRunner.query('DROP TABLE push_subscriptions');
    await queryRunner.query('DROP TABLE notification_preferences');
  }
}
