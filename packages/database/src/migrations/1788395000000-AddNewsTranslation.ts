import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewsTranslation1788395000000 implements MigrationInterface {
  name = 'AddNewsTranslation1788395000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE source_items ADD COLUMN translation_json JSON NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 운영 번역 이력이 있으면 명시적으로 정리하기 전까지 삭제하지 않습니다.
    const rows: Array<{ count: string | number }> = await queryRunner.query(
      'SELECT COUNT(*) AS count FROM source_items WHERE translation_json IS NOT NULL',
    );
    if (Number(rows[0]?.count ?? 0) > 0) {
      throw new Error('번역 이력이 남아 있어 마이그레이션을 되돌릴 수 없습니다.');
    }
    await queryRunner.query('ALTER TABLE source_items DROP COLUMN translation_json');
  }
}
