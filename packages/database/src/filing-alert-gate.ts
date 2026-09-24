import {
  AlertStatus,
  classifyOpenDartFiling,
  EventState,
  EventType,
  hasParseTypeInvariant,
  isSupportedFilingType,
  ParseStatus,
} from '@orsem/contracts';
import type { EntityManager } from 'typeorm';
import {
  type AlertEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  ParseRunEntity,
} from './entities';

export const FILING_ALERT_INELIGIBLE =
  'Filing classification or active parse no longer matches the queued alert.';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Read-only gate shared by fan-out and final delivery; never repairs or activates data. */
export async function filingAlertIsEligible(
  manager: EntityManager,
  alert: AlertEntity,
): Promise<boolean> {
  if (alert.status === AlertStatus.CANCELLED) return false;
  const payload = alert.payloadJson;
  const event = alert.eventClusterId
    ? await manager.getRepository(EventClusterEntity).findOneBy({ id: alert.eventClusterId })
    : null;
  if (alert.eventClusterId && !event) return false;
  if (event?.state === EventState.CANCELLED || event?.state === EventState.SUPERSEDED) return false;
  const memberships = event
    ? await manager.getRepository(EventClusterItemEntity).find({
        where: { eventClusterId: event.id, itemType: 'FILING' },
        order: { isPrimary: 'DESC' },
      })
    : [];
  const filingId = text(payload['filingId']);
  const rceptNo = text(payload['rceptNo']);
  if (!memberships.length && !filingId && !rceptNo) return true;
  const filings = manager.getRepository(FilingEntity);
  const filing = filingId
    ? await filings.findOneBy({ id: filingId })
    : rceptNo
      ? await filings.findOneBy({ rceptNo })
      : memberships[0]
        ? await filings.findOneBy({ id: memberships[0].itemId })
        : null;
  if (!filing || (rceptNo && filing.rceptNo !== rceptNo)) return false;
  if (event && !memberships.some((item) => item.itemId === filing.id)) return false;
  if (filing.source !== 'OPENDART') return true;
  if (event?.metadataJson?.['suppressAlerts'] === true) return false;

  // Recheck the current title too: old persisted classifications can predate the fix.
  const classification = classifyOpenDartFiling({
    reportName: filing.reportName,
    sourceDetailType: filing.sourceDetailType,
    manualCanonicalType:
      filing.classificationStatus === 'MANUAL_OVERRIDE' ? filing.canonicalType : null,
  });
  if (
    !isSupportedFilingType(filing.canonicalType) ||
    !['CONFIRMED', 'MANUAL_OVERRIDE'].includes(filing.classificationStatus) ||
    !['CONFIRMED', 'MANUAL_OVERRIDE'].includes(classification.classificationStatus) ||
    classification.canonicalType !== filing.canonicalType ||
    payload['detailType'] !== filing.canonicalType
  )
    return false;
  const eventTypes = {
    D001: EventType.LARGE_HOLDER,
    D002: EventType.INSIDER_OWNERSHIP,
    D003: EventType.PROXY_SOLICITATION,
    D004: EventType.TENDER_OFFER,
    D005: EventType.TRADE_PLAN,
  };
  if (
    event &&
    event.canonicalEventType !== eventTypes[filing.canonicalType] &&
    event.canonicalEventType !== EventType.CORRECTION
  )
    return false;
  if (payload['phase'] !== 'PARSED' || !filing.activeParseRunId) return false;
  const parseRunId =
    text(payload['parseRunId']) ?? /:parsed:([a-f0-9-]{36}):/u.exec(alert.idempotencyKey)?.[1];
  if (!parseRunId || parseRunId !== filing.activeParseRunId) return false;
  const run = await manager.getRepository(ParseRunEntity).findOneBy({ id: parseRunId });
  const parsed = run?.resultJson?.['parsed'];
  const resultType =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)['detailType']
      : null;
  const crosscheck = run?.resultJson?.['crosscheck'] as Record<string, unknown> | undefined;
  const receiptMatches = crosscheck?.['exactReceiptMatches'];
  const sourceConfirmed =
    filing.canonicalType === 'D003' || filing.canonicalType === 'D004'
      ? crosscheck?.['status'] === 'NOT_APPLICABLE' &&
        crosscheck?.['reason'] === `NO_SUMMARY_API_FOR_${filing.canonicalType}` &&
        hasConfirmedSourceReview(run)
      : filing.canonicalType === 'D005'
        ? crosscheck?.['status'] === 'NOT_APPLICABLE'
        : crosscheck?.['status'] === 'OK' &&
          Array.isArray(receiptMatches) &&
          receiptMatches.some(
            (row) => row && typeof row === 'object' && row['rcept_no'] === filing.rceptNo,
          );
  return Boolean(
    run &&
    run.filingId === filing.id &&
    run.status === ParseStatus.SUCCEEDED &&
    run.validationStatus === 'PASSED' &&
    run.resultJson?.['projectionApplied'] === true &&
    run.resultJson?.['suppressAlerts'] !== true &&
    (run.resultJson?.['staging'] as Record<string, unknown> | undefined)?.['mode'] !==
      'OFFLINE_INACTIVE' &&
    event?.metadataJson?.['parseRunId'] === run.id &&
    resultType === run.resultType &&
    sourceConfirmed &&
    hasParseTypeInvariant({
      canonicalType: filing.canonicalType,
      classificationStatus: filing.classificationStatus,
      inputType: run.inputType,
      extractorType: run.extractorType,
      resultType: run.resultType,
    }),
  );
}

/** Approval belongs to the exact immutable extraction and source, not just the filing. */
export function hasConfirmedSourceReview(
  run: Pick<ParseRunEntity, 'id' | 'rawSha256' | 'resultJson'> | null | undefined,
  now = Date.now(),
): boolean {
  const review = run?.resultJson?.['sourceReview'];
  if (!run || !review || typeof review !== 'object' || Array.isArray(review)) return false;
  const record = review as Record<string, unknown>;
  const confirmedAt = record['confirmedAt'];
  return (
    record['parseRunId'] === run.id &&
    record['rawSha256'] === run.rawSha256 &&
    /^[a-f0-9]{64}$/iu.test(run.rawSha256) &&
    typeof record['confirmedByAdminId'] === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(
      record['confirmedByAdminId'],
    ) &&
    typeof confirmedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(confirmedAt) &&
    Number.isFinite(Date.parse(confirmedAt)) &&
    Date.parse(confirmedAt) <= now &&
    new Date(confirmedAt).toISOString() === confirmedAt
  );
}
