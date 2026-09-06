import { DataSource, InsertQueryBuilder } from 'typeorm';
import { CompanyEntity, createTypeOrmOptions } from '@orsem/database';
import { loadWorkerConfig } from '../src/config/worker-config';
import { OpenDartIngestionService } from '../src/opendart/opendart-ingestion.service';

describe('OpenDART corporation master', () => {
  it('generates MySQL upsert columns from physical schema names and preserves row identity', async () => {
    const source = new DataSource(createTypeOrmOptions('mysql://localhost/isolated_test'));
    await (source as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
    const statements: string[] = [];
    const execute = jest
      .spyOn(InsertQueryBuilder.prototype, 'execute')
      .mockImplementation(async function (this: InsertQueryBuilder<CompanyEntity>) {
        statements.push(this.getSql());
        return { identifiers: [], generatedMaps: [], raw: [] };
      });
    try {
      const service = new OpenDartIngestionService(
        source,
        {
          fetchCorpCodes: async () => [
            {
              corp_code: '99900001',
              corp_name: '검증 기업',
              corp_eng_name: 'Test company',
              stock_code: '900002',
              modify_date: '20260906',
            },
          ],
        } as never,
        loadWorkerConfig({}),
        {} as never,
        {
          openDartPausedUntil: async () => null,
          recordOpenDart: async () => undefined,
        } as never,
      );
      expect(await service.syncCorpCodes()).toBe(1);
      const update = statements[0]!.split('ON DUPLICATE KEY UPDATE')[1]!;
      expect(update).toContain('`corp_code` = VALUES(`corp_code`)');
      expect(update).toContain('`source_updated_date` = VALUES(`source_updated_date`)');
      expect(update).not.toMatch(
        /`(?:corpCode|stockCode|nameKo|nameEn|isListed|sourceUpdatedDate|id)`/,
      );
    } finally {
      execute.mockRestore();
    }
  });
});
