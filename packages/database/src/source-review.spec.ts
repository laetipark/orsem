import assert from 'node:assert/strict';
import test from 'node:test';
import { hasConfirmedSourceReview } from './filing-alert-gate';

const now = Date.parse('2026-09-05T01:00:00.000Z');
const proof = {
  parseRunId: '11111111-1111-4111-8111-111111111111',
  rawSha256: 'a'.repeat(64),
  confirmedByAdminId: '22222222-2222-4222-8222-222222222222',
  confirmedAt: '2026-09-05T00:59:00.000Z',
};
const run = {
  id: proof.parseRunId,
  rawSha256: proof.rawSha256,
  resultJson: { sourceReview: proof },
};
test('source review is tied to exact run, original hash and canonical audit timestamp', () => {
  assert.equal(hasConfirmedSourceReview(run, now), true);
  assert.equal(hasConfirmedSourceReview({ ...run, id: 'other-run' }, now), false);
  assert.equal(hasConfirmedSourceReview({ ...run, rawSha256: 'b'.repeat(64) }, now), false);
  for (const changed of [
    { confirmedByAdminId: '' },
    { confirmedByAdminId: 'not-an-admin-id' },
    { confirmedAt: '2026-09-05T10:00:00.000+09:00' },
    { confirmedAt: '2026-09-05T01:00:01.000Z' },
    { confirmedAt: '2026-02-31T00:00:00.000Z' },
  ])
    assert.equal(
      hasConfirmedSourceReview(
        { ...run, resultJson: { sourceReview: { ...proof, ...changed } } },
        now,
      ),
      false,
    );
  assert.equal(
    hasConfirmedSourceReview(
      { ...run, resultJson: { crosscheck: { status: 'NOT_APPLICABLE' } } },
      now,
    ),
    false,
  );
});
