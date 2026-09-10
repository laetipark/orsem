import { createHash } from 'node:crypto';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';
import { ingestPendingSecOwnership } from '../src/sec/ownership-ingestion';
import { SecAccessCooldownError, SecAccessPolicyError } from '../src/connectors/sec-access-policy';

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
      let retryMode: 'DUE' | 'WAITING' | null = null;
      let now = '';
      let limit = Number.MAX_SAFE_INTEGER;
      const selected = () =>
        rows(type).filter((row) => {
          const metadata = row.rawMetadataJson as Row;
          if (metadata?.ownershipStatus === 'COMPLETED') return false;
          const retryAt = metadata?.ownershipRetryAt;
          if (!retryMode) return true;
          return retryMode === 'WAITING'
            ? typeof retryAt === 'string' && retryAt > now
            : typeof retryAt !== 'string' || retryAt <= now;
        });
      const query = {
        where: () => query,
        andWhere: (clause: string, parameters?: { now: string }) => {
          if (clause.includes('ownershipRetryAt')) {
            retryMode = clause.includes(' <= ') ? 'DUE' : 'WAITING';
            now = parameters!.now;
          }
          return query;
        },
        orderBy: () => query,
        take: (value: number) => {
          limit = value;
          return query;
        },
        getMany: async () => selected().slice(0, limit),
        getCount: async () => selected().length,
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
  ).toMatchObject({ ownershipCompleted: 1, ownershipPending: 0, ownershipIncomplete: false });
  expect(db.rows(EventClusterEntity)).toHaveLength(2);
  expect(db.rows(EventClusterEntity)[1]).toMatchObject({
    companyId: null,
    metadataJson: {
      observationKind: 'SEC_INSIDER_TRANSACTION',
      relatedCompanyIds: ['classA', 'classB'],
      ownership: { rawSha256: createHash('sha256').update(document).digest('hex') },
    },
  });
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({
    ownershipStatus: 'NO_PENDING',
    ownershipAttempted: 0,
    ownershipHttpStatus: null,
  });
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

it('keeps a deferred denied document incomplete on the next run without making another request', async () => {
  const db = database();
  const retryAt = new Date(Date.now() + 6 * 3600_000);
  const fetcher = jest
    .fn()
    .mockRejectedValue(new SecAccessCooldownError(retryAt, 403, true, 'SEC_RATE_LIMIT'));
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({
    ownershipAttempted: 1,
    ownershipHttpStatus: 403,
    ownershipFailed: 1,
    ownershipPending: 1,
    ownershipWaiting: 1,
    ownershipIncomplete: true,
  });
  expect((db.rows(SourceItemEntity)[0]?.rawMetadataJson as Row).ownershipRetryAt).toBe(
    retryAt.toISOString(),
  );
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({
    ownershipAttempted: 0,
    ownershipHttpStatus: null,
    ownershipFailed: 0,
    ownershipPending: 1,
    ownershipWaiting: 1,
    ownershipIncomplete: true,
    ownershipStatus: 'RETRY_WAITING',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(db.rows(SourceItemEntity)).toHaveLength(1);
});

it('reports a shared cooldown skip separately from an actual ownership HTTP request', async () => {
  const db = database();
  const fetcher = jest
    .fn()
    .mockRejectedValue(new SecAccessCooldownError(new Date(Date.now() + 600_000), 403, false));
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({ ownershipAttempted: 0, ownershipSkipped: 1, ownershipIncomplete: true });
  expect((db.rows(SourceItemEntity)[0]?.rawMetadataJson as Row).ownershipRequestAttempted).toBe(
    false,
  );
});

it('keeps request provenance unknown when a policy persistence error could follow an actual denial', async () => {
  const db = database();
  const result = await ingestPendingSecOwnership(
    db.dataSource,
    async () => {
      throw new SecAccessPolicyError();
    },
    'Orsem test@example.com',
    1000,
  );
  expect(result).toMatchObject({
    ownershipAttempted: 0,
    ownershipSkipped: 0,
    ownershipUnknownAttempts: 1,
  });
  expect(
    (db.rows(SourceItemEntity)[0]?.rawMetadataJson as Row).ownershipRequestAttempted,
  ).toBeNull();
});

it('counts documents beyond the per-run limit as incomplete even when all attempted XMLs succeed', async () => {
  const db = database();
  const original = db.rows(SourceItemEntity)[0]!;
  for (let index = 2; index <= 5; index++) {
    const nextAccession = `0000000123-26-00000${index}`;
    db.rows(SourceItemEntity).push({
      ...original,
      id: `receipt-${index}`,
      externalId: nextAccession,
      rawMetadataJson: { ...(original.rawMetadataJson as Row) },
      url: `https://www.sec.gov/Archives/edgar/data/123/${nextAccession.replaceAll('-', '')}/ownership.xml`,
    });
  }
  const fetcher = jest.fn(async () => new Response(xml));
  expect(
    await ingestPendingSecOwnership(db.dataSource, fetcher, 'Orsem test@example.com', 1000),
  ).toMatchObject({
    ownershipCompleted: 3,
    ownershipFailed: 0,
    ownershipPending: 2,
    ownershipWaiting: 0,
    ownershipIncomplete: true,
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
