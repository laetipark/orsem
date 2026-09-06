// Synthetic, offline benchmark: no credentials, database, or provider requests.
// Usage: node --expose-gc scripts/benchmark-news-content.cjs <compiled-news-content.js>
const { resolve } = require('node:path');
if (!global.gc || !process.argv[2]) {
  throw new Error('Use node --expose-gc and supply the compiled news-content.js path.');
}
const { contentSummary } = require(resolve(process.argv[2]));
const { performance } = require('node:perf_hooks');
const rightsMode = 'OFFICIAL_PUBLIC_DATA';
const timestamp = '2026-09-05T00:00:00.000Z';
const blocks = Array.from({ length: 2000 }, (_, i) => ({
  type: 'PARAGRAPH',
  text: `Synthetic paragraph ${i}. ` + 'x'.repeat(150),
}));
const translated = blocks.map((block, i) => ({
  ...block,
  text: `합성 번역 문단 ${i}. ` + '가'.repeat(120),
}));
const record = {
  sourceItemId: 'synthetic',
  status: 'AVAILABLE',
  language: 'en',
  blocksJson: blocks,
  contentHash: 'a'.repeat(64),
  fetchedAt: new Date(timestamp),
  rightsPolicyJson: {
    rightsMode,
    metadataStorageAllowed: true,
    displayAllowed: true,
    fullTextStorageAllowed: true,
    aiAllowed: true,
  },
  translationJson: {
    version: 1,
    status: 'COMPLETED',
    inputHash: 'a'.repeat(64),
    provider: 'LOCAL',
    model: 'synthetic',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    blocks: translated,
    attemptedAt: timestamp,
    translatedAt: timestamp,
    attempts: 1,
    nextAttemptAt: null,
  },
};
for (let i = 0; i < 20; i++)
  if (!contentSummary(record, rightsMode).translated) throw new Error('Invalid synthetic content');
global.gc();
const before = process.memoryUsage();
const durations = [];
let heapPeak = before.heapUsed;
for (let i = 0; i < 400; i++) {
  const start = performance.now();
  contentSummary(record, rightsMode);
  durations.push(performance.now() - start);
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
}
global.gc();
const after = process.memoryUsage();
durations.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    iterations: 400,
    blocks: 2000,
    p50Ms: durations[200],
    p95Ms: durations[380],
    heapPeakMiB: heapPeak / 1048576,
    retainedHeapDeltaMiB: (after.heapUsed - before.heapUsed) / 1048576,
    maxRssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
