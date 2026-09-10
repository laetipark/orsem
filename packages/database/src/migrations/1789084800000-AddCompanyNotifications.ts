import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCompanyNotifications1789084800000 implements MigrationInterface {
  name = 'AddCompanyNotifications1789084800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Existing installations may use different collations for the two parent tables.
    // Each FK column must retain its own parent's character set and collation.
    const columnEncoding = async (table: string, column: string) => {
      const rows = (await queryRunner.query(
        `SELECT CHARACTER_SET_NAME charsetName, COLLATION_NAME collationName
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column],
      )) as Array<{ charsetName: string; collationName: string }>;
      const encoding = rows[0];
      if (
        !encoding ||
        !/^[a-z0-9_]+$/u.test(encoding.charsetName) ||
        !/^[a-z0-9_]+$/u.test(encoding.collationName)
      )
        throw new Error('Cannot verify notification foreign-key column encoding.');
      return `CHARACTER SET ${encoding.charsetName} COLLATE ${encoding.collationName}`;
    };
    const ownerEncoding = await columnEncoding('notification_preferences', 'owner_key');
    const companyEncoding = await columnEncoding('companies', 'id');
    await queryRunner.query(`CREATE TABLE notification_company_preferences (
      owner_key VARCHAR(48) ${ownerEncoding} NOT NULL,
      company_id CHAR(36) ${companyEncoding} NOT NULL,
      enabled BOOLEAN NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (owner_key, company_id),
      KEY ix_notification_company (company_id),
      CONSTRAINT fk_notification_company_owner FOREIGN KEY (owner_key)
        REFERENCES notification_preferences(owner_key) ON DELETE CASCADE,
      CONSTRAINT fk_notification_company_company FOREIGN KEY (company_id)
        REFERENCES companies(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE notification_company_preferences');
  }
}
