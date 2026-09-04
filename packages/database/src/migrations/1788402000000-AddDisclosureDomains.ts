import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive schema; IF NOT EXISTS permits recovery after MySQL's implicit DDL commits. */
export class AddDisclosureDomains1788402000000 implements MigrationInterface {
  name = 'AddDisclosureDomains1788402000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const timestamps = `created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      updated_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))`;
    const engine = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS proxy_solicitations (
      id CHAR(36) PRIMARY KEY, filing_id CHAR(36) NOT NULL, parse_run_id CHAR(36) NOT NULL,
      facts_json JSON NOT NULL, provenance_json JSON NULL, ${timestamps},
      UNIQUE KEY ux_proxy_solicitation_filing(filing_id),
      CONSTRAINT fk_proxy_solicitation_filing FOREIGN KEY (filing_id) REFERENCES filings(id) ON DELETE CASCADE,
      CONSTRAINT fk_proxy_solicitation_run FOREIGN KEY (parse_run_id) REFERENCES parse_runs(id) ON DELETE CASCADE
    ) ${engine}`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS proxy_agenda_items (
      id CHAR(36) PRIMARY KEY, proxy_solicitation_id CHAR(36) NOT NULL, ordinal INT UNSIGNED NOT NULL,
      title TEXT NOT NULL, provenance_json JSON NULL, ${timestamps},
      UNIQUE KEY ux_proxy_agenda_ordinal(proxy_solicitation_id, ordinal),
      CONSTRAINT fk_proxy_agenda_solicitation FOREIGN KEY (proxy_solicitation_id) REFERENCES proxy_solicitations(id) ON DELETE CASCADE
    ) ${engine}`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS tender_offers (
      id CHAR(36) PRIMARY KEY, filing_id CHAR(36) NOT NULL, parse_run_id CHAR(36) NOT NULL,
      document_kind VARCHAR(16) NOT NULL, facts_json JSON NOT NULL, provenance_json JSON NULL, ${timestamps},
      UNIQUE KEY ux_tender_offer_filing(filing_id),
      CONSTRAINT fk_tender_offer_filing FOREIGN KEY (filing_id) REFERENCES filings(id) ON DELETE CASCADE,
      CONSTRAINT fk_tender_offer_run FOREIGN KEY (parse_run_id) REFERENCES parse_runs(id) ON DELETE CASCADE
    ) ${engine}`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS tender_offer_securities (
      id CHAR(36) PRIMARY KEY, tender_offer_id CHAR(36) NOT NULL, row_index INT UNSIGNED NOT NULL,
      facts_json JSON NOT NULL, provenance_json JSON NULL, ${timestamps},
      UNIQUE KEY ux_tender_security_row(tender_offer_id, row_index),
      CONSTRAINT fk_tender_security_offer FOREIGN KEY (tender_offer_id) REFERENCES tender_offers(id) ON DELETE CASCADE
    ) ${engine}`);
    if (!(await queryRunner.hasColumn('notification_preferences', 'filing_types_json'))) {
      // NULL means the existing three types; [] explicitly opts out of all filing notifications.
      await queryRunner.query(
        'ALTER TABLE notification_preferences ADD filing_types_json JSON NULL',
      );
    }
  }

  async down(): Promise<void> {
    throw new Error(
      'Preserve disclosure projections and notification choices; restore a verified consistent backup instead.',
    );
  }
}
