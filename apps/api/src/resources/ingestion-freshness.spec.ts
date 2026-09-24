import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorStatus } from '@orsem/contracts';
import { ingestionFreshness } from './ingestion-freshness';

const now = Date.parse('2026-09-24T09:00:00Z');
const row = {
  connector: 'ir',
  status: ConnectorStatus.HEALTHY,
  lastSuccessAt: new Date(now - 46 * 60_000),
  metadataJson: {},
};
test('old ingestion success becomes stale without advancing its timestamp', () => {
  assert.equal(ingestionFreshness(row, now).status, 'DEGRADED');
  assert.equal(ingestionFreshness(row, now).freshnessState, 'STALE');
  assert.equal(row.lastSuccessAt.getTime(), now - 46 * 60_000);
});
test('recent unchanged polls are healthy and partial failure remains degraded', () => {
  const fresh = { ...row, lastSuccessAt: new Date(now), metadataJson: { httpStatus: 304 } };
  assert.equal(ingestionFreshness(fresh, now).freshnessState, 'NO_NEW_ITEMS');
  assert.equal(
    ingestionFreshness(
      { ...fresh, metadataJson: { httpStatus: 200, discoveryCreated: 0, notModifiedCount: 5 } },
      now,
    ).freshnessState,
    'NO_NEW_ITEMS',
  );
  assert.equal(
    ingestionFreshness({ ...fresh, metadataJson: { partialFailureCount: 1 } }, now).freshnessState,
    'PARTIAL',
  );
  assert.equal(
    ingestionFreshness({ ...fresh, metadataJson: { issuerFailureCount: 1 } }, now).status,
    'DEGRADED',
  );
  assert.equal(
    ingestionFreshness({ ...fresh, status: ConnectorStatus.UNCONFIGURED }, now).status,
    'UNCONFIGURED',
  );
});
