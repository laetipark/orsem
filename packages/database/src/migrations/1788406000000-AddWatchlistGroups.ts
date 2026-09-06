import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchlistGroups1788406000000 implements MigrationInterface {
  name = 'AddWatchlistGroups1788406000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE watchlist_groups (
      id CHAR(36) NOT NULL PRIMARY KEY, owner_key VARCHAR(48) NOT NULL, name VARCHAR(80) NOT NULL,
      is_shared BOOLEAN NOT NULL DEFAULT FALSE, position INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      KEY ix_watchlist_groups_owner (owner_key, position), KEY ix_watchlist_groups_shared (is_shared, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await runner.query(`CREATE TABLE watchlist_group_items (
      id CHAR(36) NOT NULL PRIMARY KEY, group_id CHAR(36) NOT NULL, company_id CHAR(36) NOT NULL,
      position INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_watchlist_group_company (group_id, company_id), KEY ix_watchlist_group_items_position (group_id, position),
      CONSTRAINT fk_watchlist_group_item_group FOREIGN KEY (group_id) REFERENCES watchlist_groups(id) ON DELETE CASCADE,
      CONSTRAINT fk_watchlist_group_item_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await runner.query(`CREATE TABLE watchlist_group_follows (
      id CHAR(36) NOT NULL PRIMARY KEY, group_id CHAR(36) NOT NULL, owner_key VARCHAR(48) NOT NULL,
      position INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_watchlist_group_follow (group_id, owner_key), KEY ix_watchlist_group_follows_owner (owner_key, position),
      CONSTRAINT fk_watchlist_group_follow_group FOREIGN KEY (group_id) REFERENCES watchlist_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE watchlist_group_follows');
    await runner.query('DROP TABLE watchlist_group_items');
    await runner.query('DROP TABLE watchlist_groups');
  }
}
