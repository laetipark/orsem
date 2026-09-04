import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowSharedCompanyCik1788398000000 implements MigrationInterface {
  name = 'AllowSharedCompanyCik1788398000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 한 발행인의 여러 상장 주식 종류는 같은 SEC CIK를 사용한다.
    await queryRunner.query(
      'ALTER TABLE companies ADD INDEX ix_companies_cik (cik), DROP INDEX ux_companies_cik',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const duplicates: unknown[] = await queryRunner.query(
      'SELECT cik FROM companies WHERE cik IS NOT NULL GROUP BY cik HAVING COUNT(*) > 1 LIMIT 1',
    );
    if (duplicates.length)
      throw new Error('Cannot restore unique company CIK: shared issuer mappings exist.');
    await queryRunner.query(
      'ALTER TABLE companies ADD UNIQUE INDEX ux_companies_cik (cik), DROP INDEX ix_companies_cik',
    );
  }
}
