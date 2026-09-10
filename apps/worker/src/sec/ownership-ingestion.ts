import { createHash, randomUUID } from 'node:crypto';
import { EvidenceGrade, EventState, EventType } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { FetchImplementation } from '../opendart/opendart.client';
import { readBoundedResponseBytes } from '../common/bounded-response';
import { parseSecOwnership, SEC_OWNERSHIP_MAX_BYTES } from './ownership-parser';
import { SecAccessCooldownError, SecAccessPolicyError } from '../connectors/sec-access-policy';

function unfinishedOwnership(dataSource: DataSource) {
  return dataSource
    .getRepository(SourceItemEntity)
    .createQueryBuilder('source')
    .where('source.source = :source', { source: 'SEC' })
    .andWhere(
      "JSON_UNQUOTE(JSON_EXTRACT(source.rawMetadataJson, '$.form')) IN ('3','4','5','3/A','4/A','5/A')",
    )
    .andWhere(
      "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(source.rawMetadataJson, '$.ownershipStatus')), '') <> 'COMPLETED'",
    );
}

export function ownershipXmlUrl(
  source: Pick<SourceItemEntity, 'url' | 'externalId' | 'rawMetadataJson'>,
): URL {
  const cik = String(source.rawMetadataJson?.cik ?? ''),
    accession = source.externalId ?? '';
  if (!/^\d{10}$/.test(cik) || !/^\d{10}-\d{2}-\d{6}$/.test(accession))
    throw new Error('Invalid SEC ownership identifiers');
  if (/[\\%]/.test(source.url)) throw new Error('Encoded or backslash SEC ownership URL');
  const url = new URL(source.url);
  const prefix = `/Archives/edgar/data/${cik.replace(/^0+/, '')}/${accession.replaceAll('-', '')}/`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'www.sec.gov' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  )
    throw new Error('Unsafe SEC ownership URL');
  // SEC viewer stylesheet prefix is not the underlying XML document directory.
  const path = url.pathname.slice(prefix.length).replace(/^xslF345X\d+\//, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.xml$/i.test(path))
    throw new Error('SEC primary document is not a safe ownership XML');
  return new URL(`${url.origin}${prefix}${path}`);
}

/** Independent retry unit after filing receipt commit; malformed XML cannot erase a receipt. */
export async function ingestPendingSecOwnership(
  dataSource: DataSource,
  fetchImpl: FetchImplementation,
  userAgent: string,
  timeoutMs: number,
  limit = 3,
): Promise<Record<string, unknown>> {
  const pending = await unfinishedOwnership(dataSource)
    .andWhere(
      "(JSON_EXTRACT(source.rawMetadataJson, '$.ownershipRetryAt') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(source.rawMetadataJson, '$.ownershipRetryAt')) <= :now)",
      { now: new Date().toISOString() },
    )
    .orderBy('source.firstObservedAt', 'ASC')
    .take(limit)
    .getMany();
  let completed = 0,
    failed = 0,
    attempted = 0,
    skipped = 0,
    unknownAttempts = 0;
  let httpStatus: number | null = null;
  for (const source of pending) {
    let requestAttempted: boolean | null = false;
    httpStatus = null;
    try {
      const url = ownershipXmlUrl(source);
      attempted++;
      requestAttempted = true;
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/xml,text/xml' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`SEC ownership HTTP ${response.status}`);
      }
      const bytes = await readBoundedResponseBytes(response, {
        maxBytes: SEC_OWNERSHIP_MAX_BYTES,
        errorMessage: 'SEC ownership response size limit',
      });
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const metadata = source.rawMetadataJson ?? {};
      const ownership = parseSecOwnership(xml, {
        accessionNumber: source.externalId!,
        expectedCik: String(metadata.cik),
        filingDate: typeof metadata.filingDate === 'string' ? metadata.filingDate : null,
        acceptanceDateTime:
          typeof metadata.acceptanceDateTime === 'string' ? metadata.acceptanceDateTime : null,
        sourceUrl: url.toString(),
      });
      // Hash the received document bytes, including a possible UTF-8 BOM removed by decoding.
      ownership.rawSha256 = createHash('sha256').update(bytes).digest('hex');
      if (ownership.documentType !== String(metadata.form))
        throw new Error('SEC ownership form mismatch');
      await dataSource.transaction(async (manager) => {
        const sources = manager.getRepository(SourceItemEntity);
        const current = await sources.findOne({
          where: { id: source.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current) throw new Error('SEC receipt missing');
        if (current.rawMetadataJson?.ownershipStatus === 'COMPLETED') return;
        current.rawMetadataJson = {
          ...current.rawMetadataJson,
          secOwnership: ownership,
          ownershipStatus: 'COMPLETED',
          ownershipRetryAt: null,
          ownershipProcessedAt: new Date().toISOString(),
          ownershipError: null,
          ownershipHttpStatus: response.status,
          ownershipRequestAttempted: true,
        };
        await sources.save(current);
        const companies = await manager.getRepository(CompanyEntity).find({
          where: [{ cik: ownership.issuer.cik }, { cik: ownership.issuer.cik.replace(/^0+/, '') }],
        });
        const dedupeKey = `SEC_OWNERSHIP:${ownership.provenance.accessionNumber}`;
        const events = manager.getRepository(EventClusterEntity);
        await events
          .createQueryBuilder()
          .insert()
          .values({
            id: randomUUID(),
            dedupeKey,
            canonicalEventType: EventType.OTHER,
            companyId: companies.length === 1 ? companies[0]!.id : null,
            occurredAt: null,
            publishedAt: source.publishedAt,
            firstObservedAt: source.firstObservedAt,
            processedAt: new Date(),
            state: EventState.OPEN,
            evidenceGrade: EvidenceGrade.A,
            summary: `SEC Form ${ownership.documentType} 내부자 지분 관측 · 거래 ${ownership.transactions.length}건`,
            metadataJson: {
              source: 'SEC',
              observationKind: 'SEC_INSIDER_TRANSACTION',
              sourceItemId: source.id,
              accessionNumber: source.externalId!,
              relatedCompanyIds: companies.map((company) => company.id),
              ownership,
            },
          })
          .orIgnore()
          .execute();
        const event = await events.findOneBy({ dedupeKey });
        if (!event) throw new Error('SEC ownership event persistence failed');
        await manager
          .getRepository(EventClusterItemEntity)
          .createQueryBuilder()
          .insert()
          .values({
            id: randomUUID(),
            eventClusterId: event.id,
            itemType: 'SOURCE_ITEM',
            itemId: source.id,
            isPrimary: true,
            provenanceJson: {
              source: 'SEC',
              sourceUrl: url.toString(),
              rawSha256: ownership.rawSha256,
            },
          })
          .orIgnore()
          .execute();
      });
      completed++;
    } catch (error) {
      failed++;
      const accessWaiting = error instanceof SecAccessCooldownError;
      const requestSkipped = accessWaiting && !error.requestAttempted;
      if (requestSkipped) {
        attempted--;
        skipped++;
        requestAttempted = false;
      }
      if (error instanceof SecAccessPolicyError) {
        attempted--;
        unknownAttempts++;
        requestAttempted = null;
      }
      if (accessWaiting) httpStatus = error.providerStatus;
      const retryAt = new Date(
        Math.max(Date.now() + 3600_000, accessWaiting ? error.retryAt.getTime() : 0),
      );
      // Do not expose raw payloads, network details, or contact headers in an error field.
      await dataSource.transaction(async (manager) => {
        const sources = manager.getRepository(SourceItemEntity);
        const current = await sources.findOne({
          where: { id: source.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!current || current.rawMetadataJson?.ownershipStatus === 'COMPLETED') return;
        current.rawMetadataJson = {
          ...current.rawMetadataJson,
          ownershipStatus: accessWaiting ? 'WAITING' : 'FAILED',
          ownershipRetryAt: retryAt.toISOString(),
          ownershipError: 'XML_FETCH_OR_VALIDATION_FAILED',
          ownershipHttpStatus: httpStatus,
          ownershipRequestAttempted: requestAttempted,
        };
        await sources.save(current);
      });
      // A blocked SEC route must not be probed repeatedly in the same run.
      break;
    }
  }
  // Include deferred and overflow documents; no request this run is not evidence of recovery.
  const [remaining, waiting] = await Promise.all([
    unfinishedOwnership(dataSource).getCount(),
    unfinishedOwnership(dataSource)
      .andWhere("JSON_UNQUOTE(JSON_EXTRACT(source.rawMetadataJson, '$.ownershipRetryAt')) > :now", {
        now: new Date().toISOString(),
      })
      .getCount(),
  ]);
  return {
    ownershipAttempted: attempted,
    ownershipCompleted: completed,
    ownershipFailed: failed,
    ownershipSkipped: skipped,
    ownershipUnknownAttempts: unknownAttempts,
    ownershipHttpStatus: httpStatus,
    ownershipPending: remaining,
    ownershipWaiting: waiting,
    ownershipIncomplete: remaining > 0,
    ownershipStatus:
      remaining === 0
        ? completed > 0
          ? 'COMPLETED'
          : 'NO_PENDING'
        : remaining === waiting
          ? 'RETRY_WAITING'
          : 'PENDING',
  };
}
