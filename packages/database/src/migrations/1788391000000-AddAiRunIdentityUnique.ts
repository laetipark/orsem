import type { MigrationInterface, QueryRunner } from 'typeorm';

interface DuplicateAiRunIdentity {
  readonly subject_type: string;
  readonly subject_id: string;
  readonly provider: string;
  readonly model: string;
  readonly prompt_hash: string;
  readonly duplicate_count: string | number;
}

export class AddAiRunIdentityUnique1788391000000 implements MigrationInterface {
  name = 'AddAiRunIdentityUnique1788391000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates = (await queryRunner.query(
      `SELECT subject_type, subject_id, provider, model, prompt_hash, COUNT(*) AS duplicate_count
       FROM ai_runs
       GROUP BY subject_type, subject_id, provider, model, prompt_hash
       HAVING COUNT(*) > 1
       LIMIT 1`,
    )) as DuplicateAiRunIdentity[];
    if (duplicates.length > 0) {
      const duplicate = duplicates[0]!;
      throw new Error(
        `Cannot add ux_ai_runs_identity while duplicate AI audit identities exist (subject_type=${duplicate.subject_type}, subject_id=${duplicate.subject_id}, provider=${duplicate.provider}, model=${duplicate.model}, prompt_hash=${duplicate.prompt_hash}, count=${duplicate.duplicate_count}). Resolve the duplicate audit rows without discarding provenance, then rerun the migration.`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE ai_runs
       ADD CONSTRAINT ux_ai_runs_identity
       UNIQUE (subject_type, subject_id, provider, model, prompt_hash)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE ai_runs DROP INDEX ux_ai_runs_identity');
  }
}
