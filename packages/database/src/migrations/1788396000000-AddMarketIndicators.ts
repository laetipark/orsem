import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMarketIndicators1788396000000 implements MigrationInterface {
  name = 'AddMarketIndicators1788396000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE market_instruments (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      definition_json JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await queryRunner.query(`CREATE TABLE market_observations (
      id CHAR(36) NOT NULL PRIMARY KEY,
      instrument_id VARCHAR(32) NOT NULL,
      kind VARCHAR(8) NOT NULL,
      period VARCHAR(40) NOT NULL,
      value DECIMAL(30,10) NOT NULL,
      source_date DATE NULL,
      provider_at DATETIME(3) NULL,
      first_observed_at DATETIME(3) NOT NULL,
      last_observed_at DATETIME(3) NOT NULL,
      source VARCHAR(32) NOT NULL,
      source_url TEXT NOT NULL,
      rights_mode VARCHAR(32) NOT NULL,
      reference_value DECIMAL(30,10) NULL,
      reference_date DATE NULL,
      reference_label VARCHAR(128) NULL,
      raw_metadata_json JSON NULL,
      UNIQUE KEY ux_market_observation_period (instrument_id, kind, period),
      KEY ix_market_observation_date (instrument_id, kind, source_date),
      CONSTRAINT fk_market_observation_instrument FOREIGN KEY (instrument_id) REFERENCES market_instruments(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE market_observations');
    await queryRunner.query('DROP TABLE market_instruments');
  }
}
