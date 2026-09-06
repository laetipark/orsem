import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddManualNewsTranslations1788405000000 implements MigrationInterface {
  name = 'AddManualNewsTranslations1788405000000';
  async up(runner: QueryRunner): Promise<void> {
    for (const table of ['source_items', 'news_article_contents']) {
      if (!(await runner.hasColumn(table, 'manual_translation_json'))) {
        await runner.query(`ALTER TABLE ${table} ADD COLUMN manual_translation_json JSON NULL`);
      }
    }
    await runner.query(`CREATE TABLE IF NOT EXISTS news_translation_revisions (
      id CHAR(36) NOT NULL PRIMARY KEY,
      source_item_id CHAR(36) NOT NULL,
      edited_by_admin_id CHAR(36) NULL,
      source_hash CHAR(64) NOT NULL,
      content_hash CHAR(64) NOT NULL,
      previous_manual_json JSON NULL,
      manual_json JSON NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      KEY ix_news_translation_revision_source (source_item_id, created_at),
      CONSTRAINT fk_news_translation_revision_source FOREIGN KEY (source_item_id) REFERENCES source_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_news_translation_revision_admin FOREIGN KEY (edited_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(): Promise<void> {
    throw new Error(
      'Manual translation revisions preserve administrator edits; restore a verified backup instead.',
    );
  }
}
