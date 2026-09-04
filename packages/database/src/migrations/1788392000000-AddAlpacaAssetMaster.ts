import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAlpacaAssetMaster1788392000000 implements MigrationInterface {
  name = 'AddAlpacaAssetMaster1788392000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE alpaca_assets (
        id CHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        provider_asset_id CHAR(36) NOT NULL,
        company_id CHAR(36) NULL,
        asset_class VARCHAR(32) NOT NULL,
        exchange VARCHAR(32) NOT NULL,
        symbol VARCHAR(32) NOT NULL,
        name TEXT NOT NULL,
        status VARCHAR(32) NOT NULL,
        tradable TINYINT(1) NOT NULL,
        marginable TINYINT(1) NOT NULL,
        shortable TINYINT(1) NOT NULL,
        easy_to_borrow TINYINT(1) NOT NULL,
        fractionable TINYINT(1) NOT NULL,
        maintenance_margin_requirement VARCHAR(64) NULL,
        attributes_json JSON NULL,
        raw_json JSON NOT NULL,
        rights_mode VARCHAR(32) NOT NULL,
        provenance_url TEXT NOT NULL,
        first_observed_at DATETIME(3) NOT NULL,
        last_observed_at DATETIME(3) NOT NULL,
        is_current TINYINT(1) NOT NULL DEFAULT 1,
        PRIMARY KEY (id),
        UNIQUE KEY ux_alpaca_assets_provider_id (provider_asset_id),
        KEY ix_alpaca_assets_current_exchange_symbol (is_current, exchange, symbol),
        KEY ix_alpaca_assets_company (company_id),
        CONSTRAINT fk_alpaca_asset_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE alpaca_assets');
  }
}
