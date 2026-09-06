import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewsCompanyRelevance1788407000000 implements MigrationInterface {
  name = 'AddNewsCompanyRelevance1788407000000';
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE news_source_companies (
      id CHAR(36) NOT NULL PRIMARY KEY, source_item_id CHAR(36) NOT NULL, company_id CHAR(36) NOT NULL,
      match_method VARCHAR(40) NOT NULL, input_hash CHAR(64) NOT NULL, matcher_version INT UNSIGNED NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY ux_news_source_company (source_item_id, company_id),
      KEY ix_news_company_source (company_id, source_item_id),
      CONSTRAINT fk_news_company_source FOREIGN KEY (source_item_id) REFERENCES source_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_news_company_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE news_source_companies');
  }
}
