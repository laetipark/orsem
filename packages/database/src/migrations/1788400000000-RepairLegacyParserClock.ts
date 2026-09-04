import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Audited, opt-in correction of the old CURRENT_TIMESTAMP / UTC Date mismatch. */
export class RepairLegacyParserClock1788400000000 implements MigrationInterface {
  name = 'RepairLegacyParserClock1788400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const [legacy] = (await queryRunner.query(`SELECT COUNT(*) AS count FROM parse_runs
      WHERE normalizer_version IS NULL`)) as Array<{ count: number | string }>;
    const basis = process.env.ORSEM_LEGACY_PARSER_TIME_ZONE;
    if (Number(legacy?.count) > 0 && basis !== 'UTC' && basis !== '+09:00') {
      throw new Error(
        'Audit legacy parser timestamps and set ORSEM_LEGACY_PARSER_TIME_ZONE=UTC or +09:00 before this migration.',
      );
    }
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS parser_clock_corrections (
      table_name VARCHAR(32) NOT NULL, row_id CHAR(36) NOT NULL,
      original_created_at DATETIME(3) NOT NULL, original_updated_at DATETIME(3) NOT NULL,
      corrected_created_at DATETIME(3) NOT NULL, corrected_updated_at DATETIME(3) NOT NULL,
      source_time_zone VARCHAR(16) NOT NULL, reason VARCHAR(255) NOT NULL,
      captured_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      PRIMARY KEY (table_name,row_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    if (basis !== '+09:00' || Number(legacy?.count) === 0) return;
    const [invalid] = (await queryRunner.query(`SELECT COUNT(*) AS count FROM parse_runs
      WHERE normalizer_version IS NULL
        AND NOT EXISTS (SELECT 1 FROM parser_clock_corrections c WHERE c.table_name='parse_runs' AND c.row_id=parse_runs.id)
        AND (started_at IS NULL
        OR created_at < DATE_ADD(started_at, INTERVAL 8 HOUR)
        OR created_at > DATE_ADD(started_at, INTERVAL 9 HOUR) + INTERVAL 5 SECOND
        OR DATE_SUB(created_at, INTERVAL 9 HOUR) > UTC_TIMESTAMP(3))`)) as Array<{
      count: number | string;
    }>;
    if (Number(invalid?.count) > 0) {
      throw new Error('Legacy timestamp evidence is ambiguous; automatic correction was stopped.');
    }
    await queryRunner.query(`INSERT INTO parser_clock_corrections
      (table_name,row_id,original_created_at,original_updated_at,corrected_created_at,
       corrected_updated_at,source_time_zone,reason)
      SELECT 'parse_runs',id,created_at,updated_at,DATE_SUB(created_at,INTERVAL 9 HOUR),
        DATE_SUB(updated_at,INTERVAL 9 HOUR),'+09:00','Audited legacy DB KST defaults; started_at is UTC'
      FROM parse_runs WHERE normalizer_version IS NULL
        AND NOT EXISTS (SELECT 1 FROM parser_clock_corrections c WHERE c.table_name='parse_runs' AND c.row_id=parse_runs.id)`);
    await queryRunner.query(`INSERT INTO parser_clock_corrections
      (table_name,row_id,original_created_at,original_updated_at,corrected_created_at,
       corrected_updated_at,source_time_zone,reason)
      SELECT 'reviews',r.id,r.created_at,r.updated_at,DATE_SUB(r.created_at,INTERVAL 9 HOUR),
        CASE WHEN r.status='SUPERSEDED' AND h.review_id IS NOT NULL
          THEN r.updated_at ELSE DATE_SUB(r.updated_at,INTERVAL 9 HOUR) END,
        '+09:00','Audited legacy DB KST defaults; migration supersession timestamps already UTC'
      FROM reviews r LEFT JOIN parse_integrity_review_history h ON h.review_id=r.id
      WHERE (r.review_group IN ('PARSE','DOCUMENT') OR r.subject_type='FILING_RELATION')
        AND NOT EXISTS (SELECT 1 FROM parser_clock_corrections c WHERE c.table_name='reviews' AND c.row_id=r.id)
        AND (r.parse_run_id IS NULL OR EXISTS (SELECT 1 FROM parser_clock_corrections c
          WHERE c.table_name='parse_runs' AND c.row_id=r.parse_run_id))`);
    const [future] =
      (await queryRunner.query(`SELECT COUNT(*) AS count FROM parser_clock_corrections
      WHERE corrected_created_at > captured_at OR corrected_updated_at > captured_at
        OR corrected_updated_at < DATE_SUB(corrected_created_at, INTERVAL 1 SECOND)`)) as Array<{
        count: number | string;
      }>;
    if (Number(future?.count) > 0)
      throw new Error('Timestamp correction would violate the snapshot contract.');
    for (const table of ['parse_runs', 'reviews']) {
      const [changed] = (await queryRunner.query(`SELECT COUNT(*) AS count FROM ${table} r
        JOIN parser_clock_corrections c ON c.row_id=r.id AND c.table_name='${table}'
        WHERE NOT ((r.created_at=c.original_created_at AND r.updated_at=c.original_updated_at)
          OR (r.created_at=c.corrected_created_at AND r.updated_at=c.corrected_updated_at))`)) as Array<{
        count: number | string;
      }>;
      if (Number(changed?.count) > 0)
        throw new Error('Rows changed after the timestamp audit; correction was stopped.');
      await queryRunner.query(`UPDATE ${table} r JOIN parser_clock_corrections c
        ON c.row_id=r.id AND c.table_name='${table}'
        SET r.created_at=c.corrected_created_at,r.updated_at=c.corrected_updated_at
        WHERE r.created_at=c.original_created_at AND r.updated_at=c.original_updated_at`);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      'Timestamp audit must be retained; restore individual values from parser_clock_corrections after review.',
    );
  }
}
