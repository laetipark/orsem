import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AlertStatus, EventState, EventType, ParseStatus } from '@orsem/contracts';
import type { EntityManager } from 'typeorm';
import {
  AlertEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  ParseRunEntity,
} from './entities';
import { filingAlertIsEligible } from './filing-alert-gate';

const RUN = '00000000-0000-4000-8000-000000000001';

function context() {
  const alert = {
    eventClusterId: 'event',
    status: AlertStatus.PENDING,
    idempotencyKey: `event:WEB:parsed:${RUN}:SUCCEEDED:v1`,
    payloadJson: { phase: 'PARSED', detailType: 'D002', rceptNo: '20260905000001' },
  } as unknown as AlertEntity;
  const filing = {
    id: 'filing',
    source: 'OPENDART',
    rceptNo: '20260905000001',
    reportName: '[기재정정]임원ㆍ주요주주특정증권등소유상황보고서',
    canonicalType: 'D002',
    sourceDetailType: null,
    classificationStatus: 'CONFIRMED',
    activeParseRunId: RUN,
  } as FilingEntity;
  const run = {
    id: RUN,
    filingId: filing.id,
    inputType: 'D002',
    extractorType: 'D002',
    resultType: 'D002',
    status: ParseStatus.SUCCEEDED,
    validationStatus: 'PASSED',
    resultJson: {
      projectionApplied: true,
      parsed: { detailType: 'D002' },
      crosscheck: { status: 'OK', exactReceiptMatches: [{ rcept_no: filing.rceptNo }] },
    },
  } as unknown as ParseRunEntity;
  const event = {
    id: 'event',
    canonicalEventType: EventType.INSIDER_OWNERSHIP,
    state: EventState.VERIFIED,
    metadataJson: { parseRunId: RUN },
  } as unknown as EventClusterEntity;
  const tables = new Map<unknown, object[]>([
    [FilingEntity, [filing]],
    [ParseRunEntity, [run]],
    [EventClusterEntity, [event]],
    [EventClusterItemEntity, [{ eventClusterId: 'event', itemType: 'FILING', itemId: 'filing' }]],
  ]);
  const matching = (entity: unknown, where: Record<string, unknown>) =>
    (tables.get(entity) ?? []).filter((row) =>
      Object.entries(where).every(
        ([key, value]) => (row as Record<string, unknown>)[key] === value,
      ),
    );
  const manager = {
    getRepository(entity: unknown) {
      return {
        find: async ({ where }: { where: Record<string, unknown> }) => matching(entity, where),
        findOneBy: async (where: Record<string, unknown>) => matching(entity, where)[0] ?? null,
      };
    },
  } as unknown as EntityManager;
  return { alert, filing, run, event, tables, manager };
}

test('current supported parsed alert passes with old idempotency provenance or explicit run ID', async () => {
  const c = context();
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);
  c.alert.idempotencyKey = 'new-alert';
  c.alert.payloadJson.parseRunId = RUN;
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);
});

test('pending parsed alerts cannot reuse superseded, legacy, partial, or unapplied results', async () => {
  for (const change of [
    (c: ReturnType<typeof context>) => {
      c.filing.activeParseRunId = 'newer-run';
    },
    (c: ReturnType<typeof context>) => {
      c.run.validationStatus = 'LEGACY';
    },
    (c: ReturnType<typeof context>) => {
      c.run.status = ParseStatus.PARTIAL;
    },
    (c: ReturnType<typeof context>) => {
      c.run.resultJson!.projectionApplied = false;
    },
    (c: ReturnType<typeof context>) => {
      c.run.extractorType = 'D005';
    },
    (c: ReturnType<typeof context>) => {
      c.run.resultJson!.crosscheck = { status: 'OK', exactReceiptMatches: [] };
    },
    (c: ReturnType<typeof context>) => {
      c.run.resultJson!.parsed = { detailType: 'D005' };
    },
    (c: ReturnType<typeof context>) => {
      c.event.metadataJson!.parseRunId = 'newer-run';
    },
  ]) {
    const c = context();
    change(c);
    assert.equal(await filingAlertIsEligible(c.manager, c.alert), false);
  }
});

test('title, event family, payload type, and receipt membership must agree', async () => {
  for (const change of [
    (c: ReturnType<typeof context>) => {
      c.alert.payloadJson.detailType = 'D005';
    },
    (c: ReturnType<typeof context>) => {
      c.event.canonicalEventType = EventType.TRADE_PLAN;
    },
    (c: ReturnType<typeof context>) => {
      c.filing.reportName = '공개매수신고서';
    },
    (c: ReturnType<typeof context>) => {
      c.filing.classificationStatus = 'UNKNOWN';
    },
    (c: ReturnType<typeof context>) => {
      c.alert.payloadJson.rceptNo = 'different-receipt';
    },
    (c: ReturnType<typeof context>) => {
      c.tables.set(EventClusterItemEntity, []);
    },
  ]) {
    const c = context();
    change(c);
    assert.equal(await filingAlertIsEligible(c.manager, c.alert), false);
  }
});

test('detection does not require a parsed result; non-filing news and operations remain independent', async () => {
  const c = context();
  c.alert.payloadJson.phase = 'DETECTED';
  c.filing.activeParseRunId = null;
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);
  c.tables.set(EventClusterItemEntity, []);
  c.alert.payloadJson = { phase: 'NEWS' };
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);
  c.alert.eventClusterId = null;
  c.alert.payloadJson = { phase: 'OPERATIONAL' };
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);
  c.alert.status = AlertStatus.CANCELLED;
  assert.equal(await filingAlertIsEligible(c.manager, c.alert), false);
});

test('D003 and D004 parsed alerts require the exact source review and summary-API reason', async () => {
  for (const [detailType, reportName, eventType] of [
    ['D003', '의결권대리행사권유참고서류', EventType.PROXY_SOLICITATION],
    ['D004', '공개매수신고서', EventType.TENDER_OFFER],
  ] as const) {
    const c = context();
    c.filing.detailType = detailType;
    c.filing.canonicalType = detailType;
    c.filing.reportName = reportName;
    c.event.canonicalEventType = eventType;
    c.alert.payloadJson.detailType = detailType;
    c.alert.payloadJson.parseRunId = RUN;
    c.run.inputType = detailType;
    c.run.extractorType = detailType;
    c.run.resultType = detailType;
    c.run.rawSha256 = 'a'.repeat(64);
    c.run.resultJson = {
      projectionApplied: true,
      parsed: { detailType },
      crosscheck: { status: 'NOT_APPLICABLE', reason: `NO_SUMMARY_API_FOR_${detailType}` },
      sourceReview: {
        parseRunId: RUN,
        rawSha256: c.run.rawSha256,
        confirmedByAdminId: '22222222-2222-4222-8222-222222222222',
        confirmedAt: '2020-09-05T00:59:00.000Z',
      },
    };
    assert.equal(await filingAlertIsEligible(c.manager, c.alert), true);

    delete c.run.resultJson.sourceReview;
    assert.equal(await filingAlertIsEligible(c.manager, c.alert), false);
    c.run.resultJson.sourceReview = {
      parseRunId: RUN,
      rawSha256: c.run.rawSha256,
      confirmedByAdminId: '22222222-2222-4222-8222-222222222222',
      confirmedAt: '2020-09-05T00:59:00.000Z',
    };
    c.run.resultJson.crosscheck = { status: 'NOT_APPLICABLE', reason: 'WRONG_DOMAIN' };
    assert.equal(await filingAlertIsEligible(c.manager, c.alert), false);
  }
});
