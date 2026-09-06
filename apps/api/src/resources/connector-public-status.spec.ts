import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDiscoveryStatus } from './connector-public-status';

test('SEC status distinguishes declared-bot denial from rate limit and preserves skipped state', () => {
  for (const [providerCode, expected] of [
    ['SEC_UNDECLARED_AUTOMATION', '미신고 자동화 도구'],
    ['SEC_RATE_LIMIT', '요청 빈도 제한 응답'],
    ['SEC_ACCESS_DENIED', '접근 정책'],
    ['private provider error with reflected credentials', '원인을 확정할 수 없습니다'],
  ]) {
    const value = publicDiscoveryStatus({
      connector: 'sec',
      status: 'DEGRADED',
      metadataJson: {
        httpStatus: 403,
        providerCode,
        requestAttempted: false,
        retryAt: '2026-09-06T08:40:00Z',
        lastAttemptAt: '2026-09-06T08:30:00Z',
      },
    });
    assert.ok(value.message.includes(expected!));
    assert.ok(value.message.includes('대기 중이므로 새 요청을 보내지 않았습니다'));
    assert.ok(value.message.includes('접근 복구를 보장하지 않습니다'));
    assert.ok(!value.message.includes('private provider'));
    assert.equal(value.nextRetryAt, '2026-09-06T08:40:00.000Z');
    assert.equal(value.lastAttemptAt, '2026-09-06T08:30:00.000Z');
  }
});

test('SEC-specific diagnostics are not presented for unrelated providers or healthy collection', () => {
  assert.ok(
    !publicDiscoveryStatus({
      connector: 'gdelt',
      status: 'DEGRADED',
      metadataJson: {
        httpStatus: 403,
        providerCode: 'SEC_UNDECLARED_AUTOMATION',
      },
    }).message.includes('미신고'),
  );
  assert.ok(
    !publicDiscoveryStatus({
      connector: 'sec',
      status: 'HEALTHY',
      metadataJson: {
        httpStatus: 200,
        providerCode: 'SEC_UNDECLARED_AUTOMATION',
      },
    }).message.includes('SEC Webmaster'),
  );
});
