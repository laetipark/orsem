import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Existing provenance is retained; ingestion fills hashes without a content backfill. */
export class AddNewsTitleHash1788413000000 implements MigrationInterface {
  name = 'AddNewsTitleHash1788413000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE source_items
      ADD COLUMN normalized_title_hash CHAR(64) NULL,
      ADD KEY ix_source_items_title_published (normalized_title_hash, published_at)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE source_items
      DROP KEY ix_source_items_title_published, DROP COLUMN normalized_title_hash`);
  }
}
