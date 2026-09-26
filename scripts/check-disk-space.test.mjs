import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDiskSpace, evaluateDiskSpace } from './check-disk-space.mjs';

const stats = (freeMiB, totalMiB = 10_000n) => ({
  bsize: 1024n * 1024n,
  blocks: totalMiB,
  bavail: freeMiB,
});

test('Disk diagnostics fail below 128 MiB and warn below 5 percent available', () => {
  assert.equal(evaluateDiskSpace(stats(0n)).state, 'FAIL');
  assert.equal(evaluateDiskSpace(stats(127n)).state, 'FAIL');
  assert.equal(evaluateDiskSpace(stats(128n)).state, 'WARN');
  assert.equal(evaluateDiskSpace(stats(499n)).state, 'WARN');
  assert.equal(evaluateDiskSpace(stats(500n)).state, 'OK');
  assert.equal(evaluateDiskSpace(stats(127n, 128n)).state, 'FAIL');
  assert.equal(evaluateDiskSpace(stats(128n, 128n)).state, 'OK');
});

test('Disk diagnostics use space available to the service, excluding reserved blocks', () => {
  const result = evaluateDiskSpace({ ...stats(1_750n, 400_000n), bfree: 30_000n });
  assert.equal(result.state, 'WARN');
  assert.match(result.detail, /1750 MiB available \(0\.4%\)/);
});

test('Disk diagnostics reject invalid counters without returning raw information', () => {
  for (const info of [stats(-1n), stats(1n, 0n), stats(2n, 1n), { ...stats(1n), bsize: 0n }]) {
    assert.equal(evaluateDiskSpace(info).state, 'WARN');
  }
});

test('Disk diagnostics inspect the configured directory and sanitize filesystem errors', async () => {
  const result = await checkDiskSpace('/external/test-data', {
    readStats: async (directory, options) => {
      assert.equal(directory, '/external/test-data');
      assert.deepEqual(options, { bigint: true });
      return stats(500n);
    },
  });
  assert.equal(result.state, 'OK');
  const failure = await checkDiskSpace('/external/private-path', {
    readStats: async () => {
      throw new Error('private-filesystem-error');
    },
  });
  assert.equal(failure.state, 'WARN');
  assert.doesNotMatch(JSON.stringify(failure), /private-/);
});
