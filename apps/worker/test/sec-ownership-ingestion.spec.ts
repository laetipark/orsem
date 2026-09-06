import { createHash } from 'node:crypto';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';
import { ingestPendingSecOwnership } from '../src/sec/ownership-ingestion';

const accession = '0000000123-26-000001';
const xml =
  '<ownershipDocument><documentType>4</documentType><issuer><issuerCik>123</issuerCik><issuerName>Synthetic</issuerName></issuer><nonDerivativeTable><nonDerivativeTransaction><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>12.0001</value></transactionShares></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>';
type Row = Record<string, unknown>;
function database(failEvent = false) {
  const tables = new Map<unknown, Row[]>();
  tables.set(SourceItemEntity, [
    Object.assign(new SourceItemEntity(), {
      id: 'receipt-source',
      source: 'SEC',
      externalId: accession,
      title: 'SEC Form 4',
      url: `https://www.sec.gov/Archives/edgar/data/123/${accession.replaceAll('-', '')}/ownership.xml`,
      publishedAt: new Date('2026-09-05T12:00:00Z'),
      firstObservedAt: new Date(),
      rawMetadataJson: { cik: '0000000123', form: '4', filingDate: '2026-09-05' },
    }) as unknown as Row,
  ]);
  tables.set(CompanyEntity, [
    { id: 'classA', cik: '0000000123' },
    { id: 'classB', cik: '123' },
  ]);
  tables.set(EventClusterEntity, [
    { id: 'existing-receipt', dedupeKey: 'SEC:receipt-source:classA' },
  ]);
  const rows = (type: unknown) => {
    if (!tables.has(type)) tables.set(type, []);
    return tables.get(type)!;
  };
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const getRepository = (type: unknown) => ({
    findOne: async ({ where }: { where: Row }) =>
      rows(type).find((row) => matches(row, where)) ?? null,
    findOneBy: async (where: Row) => rows(type).find((row) => matches(row, where)) ?? null,
    find: async ({ where }: { where: Row | Row[] }) =>
      rows(type).filter((row) =>
        (Array.isArray(where) ? where : [where]).some((condition) => matches(row, condition)),
      ),
    save: async (value: Row) => {
      const index = rows(type).findIndex((row) => row.id === value.id);
      if (index < 0) rows(type).push(value);
      else rows(type)[index] = value;
      return value;
    },
    createQueryBuilder: () => {
      let input: Row;
      const query = {
        where: () => query,
        andWhere: () => query,
        orderBy: () => query,
        take: () => query,
        getMany: async () =>
          rows(type).filter((row) => (row.rawMetadataJson as Row)?.ownershipStatus !== 'COMPLETED'),
        insert: () => query,
        values: (value: Row) => {
          input = value;
          return query;
        },
        orIgnore: () => query,
        execute: async () => {
          if (type === EventClusterEntity && failEvent)
            throw new Error('synthetic event persistence failure');
          if (
            !rows(type).some((row) =>
              type === EventClusterItemEntity
                ? row.eventClusterId === input.eventClusterId && row.itemId === input.itemId
                : row.dedupeKey === input.dedupeKey,
            )
          )
            rows(type).push(input);
        },
      };
      return query;
    },
  });
  const dataSource = {
    getRepository,
    transaction: async (
      run: (manager: { getRepository: typeof getRepository }) => Promise<unknown>,
    ) => {
      // Constructor keys cannot be structured-cloned; snapshot row contents only.
      const backup = [...tables].map(([key, value]) => [key, structuredClone(value)] as const);
      try {
        return await run({ getRepository });
      } catch (error) {
        tables.clear();
        for (const [key, value] of backup) tables.set(key, value);
        throw error;
      }
    },
  } as unknown as DataSource;
  return { dataSource, rows };
}
it('creates one accession ownership event for multiple share classes, preserves the receipt, and is idempotent', async () => {
  const db = database();
  const document = `\uFEFF${xml}`;
  const fetcher = jest.fn(async () => new Response(document));
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({ ownershipCompleted: 1 });
  expect(db.rows(EventClusterEntity)).toHaveLength(2);
  expect(db.rows(EventClusterEntity)[1]).toMatchObject({
    companyId: null,
    metadataJson: {
      observationKind: 'SEC_INSIDER_TRANSACTION',
      relatedCompanyIds: ['classA', 'classB'],
      ownership: { rawSha256: createHash('sha256').update(document).digest('hex') },
    },
  });
  await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(db.rows(EventClusterItemEntity)).toHaveLength(1);
});
it.each([true, false])(
  'retains the receipt and retries instead of committing ownership after XML/event failure: %s',
  async (eventFailure) => {
    const db = database(eventFailure);
    const result = await ingestPendingSecOwnership(
      db.dataSource,
      async () => new Response(eventFailure ? xml : '<malformed>'),
      'Orsem test@example.com',
      1000,
    );
    expect(result).toMatchObject({ ownershipFailed: 1, ownershipCompleted: 0 });
    expect(db.rows(EventClusterEntity)).toHaveLength(1);
    expect(db.rows(SourceItemEntity)[0]).toMatchObject({
      title: 'SEC Form 4',
      rawMetadataJson: { ownershipStatus: 'FAILED' },
    });
    expect((db.rows(SourceItemEntity)[0]?.rawMetadataJson as Row).secOwnership).toBeUndefined();
  },
);
