import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PreservePriceBarSources1788393000000 implements MigrationInterface {
  name = 'PreservePriceBarSources1788393000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 기존 출처와 시각은 변경하지 않습니다. 과거 행에 없는 원본 응답,
    // 관측 시각이나 시장 거래일을 임의로 만들어 넣지 않습니다.
    await queryRunner.query(`
      ALTER TABLE price_bars
        ADD COLUMN session_date DATE NULL,
        ADD COLUMN raw_payload_json JSON NULL,
        ADD COLUMN provenance_json JSON NULL,
        ADD COLUMN observed_at DATETIME(3) NULL,
        ADD UNIQUE KEY ux_price_bar_company_source_interval_time
          (company_id, source, \`interval\`, bar_at),
        DROP INDEX ux_price_bar_company_interval_time
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const conflicts = (await queryRunner.query(`
      SELECT 1 FROM price_bars
      GROUP BY company_id, \`interval\`, bar_at
      HAVING COUNT(*) > 1 LIMIT 1
    `)) as unknown[];
    if (conflicts.length) {
      throw new Error(
        'Cannot revert price source preservation while multiple sources share a bar.',
      );
    }
    await queryRunner.query(`
      ALTER TABLE price_bars
        ADD UNIQUE KEY ux_price_bar_company_interval_time (company_id, \`interval\`, bar_at),
        DROP INDEX ux_price_bar_company_source_interval_time,
        DROP COLUMN session_date,
        DROP COLUMN raw_payload_json,
        DROP COLUMN provenance_json,
        DROP COLUMN observed_at
    `);
  }
}
