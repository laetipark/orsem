import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Independent, immutable analysis ledger. No backfill from mixed-period company summaries. */
export class AddDisclosureAnalysis1791590400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    const suffix = ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    const tables = [
      `CREATE TABLE analysis_reports (
        id char(36) NOT NULL PRIMARY KEY, company_id char(36) NOT NULL,
        source varchar(32) NOT NULL, filing_id varchar(128) NOT NULL,
        report_year int NOT NULL, report_code varchar(8) NOT NULL, scope varchar(16) NOT NULL,
        period_start date NULL, period_end date NULL, publication_date date NULL,
        first_observed_at datetime(3) NOT NULL, source_url varchar(2048) NOT NULL,
        rights_mode varchar(40) NOT NULL, raw_uri varchar(2048) NOT NULL,
        raw_sha256 char(64) NOT NULL, normalizer_version varchar(64) NOT NULL,
        metadata_json json NOT NULL,
        UNIQUE KEY ux_analysis_report_version(company_id,source,filing_id,report_year,report_code,scope,raw_sha256,normalizer_version),
        INDEX ix_analysis_report_period(company_id,report_year,report_code,scope,first_observed_at),
        FOREIGN KEY(company_id) REFERENCES companies(id)
      )`,
      `CREATE TABLE analysis_facts (
        id char(36) NOT NULL PRIMARY KEY, report_id char(36) NOT NULL,
        metric varchar(40) NOT NULL, account_id varchar(255) NULL,
        period_start date NULL, period_end date NULL, basis varchar(24) NOT NULL,
        currency varchar(32) NULL, unit varchar(80) NOT NULL, value_text varchar(255) NULL,
        status varchar(24) NOT NULL, fact_json json NOT NULL,
        INDEX ix_analysis_fact_report(report_id,metric,basis),
        FOREIGN KEY(report_id) REFERENCES analysis_reports(id)
      )`,
      `CREATE TABLE analysis_saved_queries (
        id char(36) NOT NULL PRIMARY KEY, owner_key varchar(64) NOT NULL,
        name varchar(80) NOT NULL, selection_json json NOT NULL,
        auto_refresh tinyint(1) NOT NULL DEFAULT 0, last_trigger_key varchar(255) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX ix_analysis_saved_owner(owner_key,updated_at), INDEX ix_analysis_saved_auto(auto_refresh)
      )`,
      `CREATE TABLE analysis_runs (
        id char(36) NOT NULL PRIMARY KEY, owner_key varchar(64) NOT NULL,
        saved_query_id char(36) NULL, parent_run_id char(36) NULL,
        status varchar(24) NOT NULL, selection_json json NOT NULL, company_ids_json json NOT NULL,
        result_json json NULL, progress_json json NOT NULL, error_message varchar(1000) NULL,
        next_attempt_at datetime(3) NULL, completed_at datetime(3) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX ix_analysis_run_owner(owner_key,created_at), INDEX ix_analysis_run_saved(saved_query_id,created_at),
        FOREIGN KEY(saved_query_id) REFERENCES analysis_saved_queries(id) ON DELETE SET NULL,
        FOREIGN KEY(parent_run_id) REFERENCES analysis_runs(id)
      )`,
      `CREATE TABLE analysis_exports (
        id char(36) NOT NULL PRIMARY KEY, run_id char(36) NOT NULL, owner_key varchar(64) NOT NULL,
        status varchar(24) NOT NULL, selection_json json NOT NULL, object_uri varchar(2048) NULL,
        sha256 char(64) NULL, error_message varchar(1000) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX ix_analysis_export_owner(owner_key,run_id), FOREIGN KEY(run_id) REFERENCES analysis_runs(id)
      )`,
      `CREATE TABLE analysis_documents (
        id char(36) NOT NULL PRIMARY KEY, report_id char(36) NULL, source_item_id char(36) NULL,
        filing_id char(36) NULL,
        source_url varchar(2048) NOT NULL, rights_mode varchar(40) NOT NULL,
        raw_uri varchar(2048) NULL, raw_sha256 char(64) NULL, media_type varchar(100) NULL,
        parser_version varchar(64) NOT NULL, status varchar(24) NOT NULL,
        tables_json json NULL, ownership_json json NULL, error_message varchar(1000) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX ix_analysis_document_report(report_id), INDEX ix_analysis_document_source(source_item_id),
        INDEX ix_analysis_document_filing(filing_id),
        INDEX ix_analysis_document_hash(raw_sha256,parser_version),
        FOREIGN KEY(report_id) REFERENCES analysis_reports(id),
        FOREIGN KEY(source_item_id) REFERENCES source_items(id),
        FOREIGN KEY(filing_id) REFERENCES filings(id)
      )`,
      `CREATE TABLE analysis_notes (
        id char(36) NOT NULL PRIMARY KEY, document_id char(36) NOT NULL,
        note_key varchar(160) NOT NULL, title varchar(500) NOT NULL, body mediumtext NOT NULL,
        table_ids_json json NOT NULL, source_url varchar(2048) NOT NULL,
        UNIQUE KEY ux_analysis_note(document_id,note_key),
        FULLTEXT KEY ix_analysis_note_text(title,body),
        FOREIGN KEY(document_id) REFERENCES analysis_documents(id)
      )`,
      `CREATE TABLE analysis_diffs (
        id char(36) NOT NULL PRIMARY KEY, before_document_id char(36) NOT NULL,
        after_document_id char(36) NOT NULL, status varchar(24) NOT NULL,
        confirmed tinyint(1) NOT NULL DEFAULT 0, result_json json NULL, review_json json NULL,
        error_message varchar(1000) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY ux_analysis_diff(before_document_id,after_document_id),
        FOREIGN KEY(before_document_id) REFERENCES analysis_documents(id),
        FOREIGN KEY(after_document_id) REFERENCES analysis_documents(id)
      )`,
      `CREATE TABLE analysis_bookmarks (
        id char(36) NOT NULL PRIMARY KEY, owner_key varchar(64) NOT NULL,
        document_id char(36) NOT NULL, note_id char(36) NULL, label varchar(160) NOT NULL,
        anchor_json json NOT NULL, needs_relink tinyint(1) NOT NULL DEFAULT 0,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        INDEX ix_analysis_bookmark_owner(owner_key,created_at),
        FOREIGN KEY(document_id) REFERENCES analysis_documents(id),
        FOREIGN KEY(note_id) REFERENCES analysis_notes(id)
      )`,
      `CREATE TABLE analysis_mappings (
        id char(36) NOT NULL PRIMARY KEY, source varchar(32) NOT NULL, taxonomy varchar(80) NOT NULL,
        account_id varchar(255) NOT NULL, metric varchar(40) NOT NULL, scope varchar(16) NOT NULL,
        status varchar(24) NOT NULL, version int NOT NULL, source_url varchar(2048) NOT NULL,
        details_json json NOT NULL, created_by varchar(64) NOT NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY ux_analysis_mapping_version(source,taxonomy,account_id,metric,scope,version),
        INDEX ix_analysis_mapping_metric(metric,status)
      )`,
      `CREATE TABLE analysis_validations (
        id char(36) NOT NULL PRIMARY KEY, run_id char(36) NOT NULL,
        rule_version varchar(64) NOT NULL, results_json json NOT NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY ux_analysis_validation(run_id,rule_version),
        FOREIGN KEY(run_id) REFERENCES analysis_runs(id)
      )`,
      `CREATE TABLE analysis_jobs (
        id char(36) NOT NULL PRIMARY KEY, kind varchar(24) NOT NULL, entity_id char(36) NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'PENDING', payload_json json NULL,
        attempts int NOT NULL DEFAULT 0, available_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        lease_until datetime(3) NULL, last_error varchar(1000) NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY ux_analysis_job_entity(kind,entity_id),
        INDEX ix_analysis_job_dispatch(status,available_at,lease_until)
      )`,
    ];
    for (const statement of tables) await runner.query(statement + suffix);
  }

  async down(runner: QueryRunner): Promise<void> {
    for (const name of [
      'analysis_jobs',
      'analysis_validations',
      'analysis_mappings',
      'analysis_bookmarks',
      'analysis_diffs',
      'analysis_notes',
      'analysis_documents',
      'analysis_exports',
      'analysis_runs',
      'analysis_saved_queries',
      'analysis_facts',
      'analysis_reports',
    ]) {
      await runner.query(`DROP TABLE ${name}`);
    }
  }
}
