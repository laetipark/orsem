import { createHash, randomUUID } from 'node:crypto';
import { canonicalNewsUrl, sourceKindForSource } from '@orsem/contracts';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNewsArticles1788401000000 implements MigrationInterface {
  name = 'AddNewsArticles1788401000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE news_articles (
      id CHAR(36) NOT NULL PRIMARY KEY,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      canonical_url TEXT NOT NULL, url_hash CHAR(64) NOT NULL,
      sort_at DATETIME(3) NOT NULL, first_observed_at DATETIME(3) NOT NULL,
      UNIQUE KEY ux_news_article_url (url_hash), KEY ix_news_articles_sort (sort_at, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    await queryRunner.query(`ALTER TABLE source_items
      ADD COLUMN news_article_id CHAR(36) NULL,
      ADD COLUMN source_kind VARCHAR(32) NULL,
      ADD COLUMN source_policy_json JSON NULL,
      ADD KEY ix_source_items_article (news_article_id),
      ADD CONSTRAINT fk_source_news_article FOREIGN KEY (news_article_id) REFERENCES news_articles(id)`);
    // Bounded, metadata-only migration; NAVER content stays isolated and is never reprocessed.
    let after = '';
    while (true) {
      const rows: Array<{
        id: string;
        source: string;
        url: string;
        published_at: Date | null;
        first_observed_at: Date;
      }> = await queryRunner.query(
        `SELECT id, source, url, published_at, first_observed_at FROM source_items WHERE source <> 'NAVER' AND id > ? ORDER BY id LIMIT 250`,
        [after],
      );
      if (!rows.length) break;
      for (const row of rows) {
        await queryRunner.query('UPDATE source_items SET source_kind = ? WHERE id = ?', [
          sourceKindForSource(row.source),
          row.id,
        ]);
        let url: string;
        try {
          url = canonicalNewsUrl(row.url);
        } catch {
          continue;
        }
        const hash = createHash('sha256').update(url).digest('hex');
        await queryRunner.query(
          `INSERT IGNORE INTO news_articles (id,canonical_url,url_hash,sort_at,first_observed_at) VALUES (?,?,?,?,?)`,
          [
            randomUUID(),
            url,
            hash,
            row.published_at ?? row.first_observed_at,
            row.first_observed_at,
          ],
        );
        await queryRunner.query(
          `UPDATE source_items SET news_article_id = (SELECT id FROM news_articles WHERE url_hash = ?) WHERE id = ?`,
          [hash, row.id],
        );
        await queryRunner.query(
          `UPDATE news_articles SET first_observed_at = LEAST(first_observed_at, ?), sort_at = LEAST(sort_at, ?) WHERE url_hash = ?`,
          [row.first_observed_at, row.published_at ?? row.first_observed_at, hash],
        );
      }
      after = rows[rows.length - 1]!.id;
    }
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ total: string | number }> = await queryRunner.query(
      'SELECT COUNT(*) AS total FROM news_articles',
    );
    if (Number(rows[0]?.total ?? 0))
      throw new Error('Article provenance exists; refusing destructive rollback.');
    await queryRunner.query(
      `ALTER TABLE source_items DROP FOREIGN KEY fk_source_news_article, DROP KEY ix_source_items_article, DROP COLUMN news_article_id, DROP COLUMN source_kind, DROP COLUMN source_policy_json`,
    );
    await queryRunner.query('DROP TABLE news_articles');
  }
}
