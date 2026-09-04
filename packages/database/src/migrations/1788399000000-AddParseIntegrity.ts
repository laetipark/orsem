import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddParseIntegrity1788399000000 implements MigrationInterface {
  name = 'AddParseIntegrity1788399000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE filings
      ADD source_detail_type VARCHAR(32) NULL,
      ADD title_detected_type VARCHAR(32) NULL,
      ADD canonical_type VARCHAR(32) NULL,
      ADD classification_status VARCHAR(32) NOT NULL DEFAULT 'UNKNOWN',
      ADD classifier_version VARCHAR(64) NULL,
      ADD classification_provenance_json JSON NULL`);
    await queryRunner.query(`ALTER TABLE parse_runs
      ADD input_type VARCHAR(32) NULL,
      ADD extractor_type VARCHAR(32) NULL,
      ADD result_type VARCHAR(32) NULL,
      ADD normalizer_version VARCHAR(64) NULL,
      ADD classifier_version VARCHAR(64) NULL,
      ADD reuse_fingerprint CHAR(64) NULL,
      ADD candidate_errors_json JSON NULL,
      ADD normalization_audits_json JSON NULL,
      ADD supersedes_run_id CHAR(36) NULL,
      ADD validation_status VARCHAR(32) NOT NULL DEFAULT 'LEGACY',
      ADD UNIQUE KEY ux_parse_run_fingerprint (filing_id, reuse_fingerprint),
      DROP INDEX ux_parse_run_input`);
    // Only the result's own declaration is evidence for a historical run's type.
    // A mutable filing.detail_type must never be used to fabricate its input type.
    await queryRunner.query(`UPDATE parse_runs SET result_type =
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.parsed.detailType')), 'null'),
      updated_at = updated_at WHERE result_json IS NOT NULL`);
    await queryRunner.query(`ALTER TABLE reviews
      ADD review_group VARCHAR(32) NULL,
      ADD parse_run_id CHAR(36) NULL,
      ADD superseded_by_review_id CHAR(36) NULL,
      ADD reopened_from_review_id CHAR(36) NULL,
      ADD INDEX ix_reviews_parse_run (parse_run_id)`);
    await queryRunner.query(`UPDATE reviews r JOIN parse_runs p
      ON p.id = SUBSTRING(r.dedupe_key, 7, 36) AND p.filing_id = r.subject_id
      SET r.review_group = 'PARSE', r.parse_run_id = p.id, r.updated_at = r.updated_at
      WHERE r.subject_type = 'FILING'
        AND r.dedupe_key REGEXP '^parse:[a-f0-9-]{36}(:failed)?$'`);
    await queryRunner.query(`UPDATE reviews SET review_group = 'DOCUMENT', updated_at = updated_at
      WHERE subject_type = 'FILING' AND dedupe_key LIKE 'document:%'`);
    // Preserve the pre-migration review state for audit; never delete historical reviews.
    await queryRunner.query(`CREATE TABLE parse_integrity_review_history (
      review_id CHAR(36) NOT NULL PRIMARY KEY,
      status VARCHAR(16) NOT NULL,
      resolution TEXT NULL,
      created_at_original DATETIME(3) NOT NULL,
      updated_at_original DATETIME(3) NOT NULL,
      captured_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await queryRunner.query(`INSERT INTO parse_integrity_review_history
      (review_id,status,resolution,created_at_original,updated_at_original)
      SELECT id,status,resolution,created_at,updated_at FROM reviews
      WHERE review_group = 'PARSE' AND status = 'OPEN'`);
    await queryRunner.query(`UPDATE reviews r JOIN (
      SELECT id, FIRST_VALUE(id) OVER (
        PARTITION BY subject_id ORDER BY run_created DESC, run_id DESC, created_at DESC, id DESC
      ) AS current_id FROM (
        SELECT r.id,r.subject_id,r.created_at,p.created_at AS run_created,p.id AS run_id
        FROM reviews r JOIN parse_runs p ON p.id = r.parse_run_id
        WHERE r.review_group = 'PARSE' AND r.status = 'OPEN'
      ) eligible
    ) ranked ON ranked.id = r.id
    SET r.status = 'SUPERSEDED', r.superseded_by_review_id = ranked.current_id,
      r.resolution = JSON_OBJECT('resolution','SUPERSEDED_BY_CURRENT_PARSE_REVIEW',
        'supersededByReviewId',ranked.current_id), r.updated_at = UTC_TIMESTAMP(3)
    WHERE r.id <> ranked.current_id`);
    // MySQL's nullable generated key provides a partial unique constraint.
    await queryRunner.query(`ALTER TABLE reviews ADD active_parse_subject CHAR(36)
      GENERATED ALWAYS AS (CASE WHEN status = 'OPEN' AND subject_type = 'FILING'
        AND review_group = 'PARSE' THEN subject_id ELSE NULL END) STORED,
      ADD UNIQUE KEY ux_reviews_active_parse_subject (active_parse_subject)`);
  }

  async down(): Promise<void> {
    throw new Error(
      'Parse integrity history must be preserved; roll back application activation pointers, not audit schema.',
    );
  }
}
