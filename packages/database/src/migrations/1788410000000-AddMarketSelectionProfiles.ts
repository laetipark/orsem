import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMarketSelectionProfiles1788410000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE TABLE market_cap_snapshots (
      id char(36) NOT NULL PRIMARY KEY, region varchar(2) NOT NULL, basis_date date NOT NULL,
      observed_at datetime(3) NOT NULL, source_url varchar(1024) NOT NULL, rights_mode varchar(40) NOT NULL,
      source_count int NOT NULL, raw_json json NOT NULL,
      INDEX ix_market_cap_date(region,basis_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await runner.query(`CREATE TABLE market_cap_memberships (
      snapshot_id char(36) NOT NULL, company_id char(36) NOT NULL, rank_no int NOT NULL,
      stock_code varchar(32) NOT NULL, market_cap decimal(30,0) NOT NULL,
      PRIMARY KEY(snapshot_id, company_id), UNIQUE KEY ux_market_rank(snapshot_id,rank_no),
      FOREIGN KEY(snapshot_id) REFERENCES market_cap_snapshots(id), FOREIGN KEY(company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await runner.query(`CREATE TABLE market_selection_state (
      region varchar(2) NOT NULL PRIMARY KEY, status varchar(32) NOT NULL,
      active_snapshot_id char(36) NULL, last_attempt_at datetime(3) NULL, last_success_at datetime(3) NULL,
      reason varchar(500) NULL, FOREIGN KEY(active_snapshot_id) REFERENCES market_cap_snapshots(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await runner.query(`CREATE TABLE company_information_snapshots (
      id char(36) NOT NULL PRIMARY KEY, company_id char(36) NOT NULL, source varchar(32) NOT NULL,
      report_year int NULL, report_code varchar(8) NULL, basis_date date NULL,
      observed_at datetime(3) NOT NULL, source_url varchar(1024) NOT NULL, rights_mode varchar(40) NOT NULL,
      fields_json json NOT NULL, raw_json json NOT NULL,
      INDEX ix_company_information(company_id,observed_at), FOREIGN KEY(company_id) REFERENCES companies(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE company_information_snapshots');
    await runner.query('DROP TABLE market_selection_state');
    await runner.query('DROP TABLE market_cap_memberships');
    await runner.query('DROP TABLE market_cap_snapshots');
  }
}
