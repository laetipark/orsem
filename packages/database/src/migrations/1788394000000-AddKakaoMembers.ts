import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddKakaoMembers1788394000000 implements MigrationInterface {
  name = 'AddKakaoMembers1788394000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE members (
        id CHAR(36) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        provider VARCHAR(16) NOT NULL DEFAULT 'KAKAO',
        provider_subject VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        role VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
        status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
        display_name VARCHAR(80) NULL,
        last_login_at DATETIME(3) NULL,
        reviewed_at DATETIME(3) NULL,
        reviewed_by_admin_id CHAR(36) NULL,
        PRIMARY KEY (id),
        UNIQUE KEY ux_members_provider_subject (provider, provider_subject),
        KEY ix_members_status_created (status, created_at),
        CONSTRAINT fk_members_review_admin FOREIGN KEY (reviewed_by_admin_id) REFERENCES admins(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE members');
  }
}
