import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GDELT_METADATA_POLICY } from '@orsem/contracts';
import { SourceItemEntity } from '@orsem/database';
import { newsFiltersSql, visibleNewsSql, representativeNewsSql } from './news-query';
import { mapSourceItem } from './resource-mappers';
import { publicDiscoveryStatus } from './connector-public-status';

test('market selects Fed/BLS only and company filtering uses the multi-company relation', () => {
  assert.match(newsFiltersSql('source', { scope: 'market' }), /IN \('federal-reserve', 'bls'\)/);
  assert.match(
    newsFiltersSql('source', { scope: 'company', companyId: 'company' }),
    /relevance.company_id = :newsCompanyId/,
  );
  assert.doesNotMatch(
    newsFiltersSql('source', { companyId: 'company' }),
    /source.company_id = :newsCompanyId/,
  );
  const regional = newsFiltersSql('source', { region: 'us' });
  assert.match(regional, /relevance_company.market IN \(:\.\.\.newsMarkets\)/);
  assert.match(regional, /OR \(NOT \(EXISTS \(SELECT 1 FROM news_source_companies/);
});
test('metadata visibility needs explicit rights but never a body or translation and official sources win deduplication', () => {
  const sql = visibleNewsSql('content', 'source');
  assert.match(sql, /metadataStorageAllowed/);
  assert.match(sql, /displayAllowed/);
  assert.doesNotMatch(sql, /content\.|translation|fullText/);
  assert.match(newsFiltersSql('source', {}), /APPROVED_PUBLISHER_METADATA/);
  assert.match(newsFiltersSql('source', { asset: 'wti' }), /1 = 0/);
  assert.match(
    representativeNewsSql({}),
    /duplicate.source IN \('GDELT','ALPACA_NEWS','MARKETAUX','ALPHAVANTAGE','FINNHUB'\)\) < \(source.source IN/,
  );
});
test('external metadata cards cannot expose a description, translation, or a fake body', () => {
  const row = Object.assign(new SourceItemEntity(), {
    id: 'source',
    source: 'GDELT',
    title: 'Headline',
    url: 'https://publisher.example/article',
    sourceKind: 'INDEPENDENT_MEDIA',
    sourcePolicyJson: GDELT_METADATA_POLICY,
    rightsMode: 'STORE_METADATA_ONLY',
    firstObservedAt: new Date('2026-09-06T00:00:00Z'),
    rawMetadataJson: { description: 'unreviewed snippet' },
    translationJson: { status: 'COMPLETED', title: 'must not display' },
  });
  const result = mapSourceItem(row);
  assert.equal(result.displayMode, 'EXTERNAL_LINK');
  assert.equal(result.contentState, 'UNAVAILABLE');
  assert.equal(result.description, null);
  assert.equal(result.translation, null);
  assert.equal(result.translated, false);
  assert.equal(result.url, 'https://publisher.example/article');
});

test('cooldown status distinguishes observed denials from skipped work and never renders raw errors', () => {
  const raw = {
    connector: 'sec',
    status: 'DEGRADED' as const,
    metadataJson: {
      httpStatus: 403,
      requestAttempted: false,
      lastAttemptAt: '2026-09-05T23:00:00Z',
      retryAt: '2026-09-06T00:00:00Z',
      error: 'secret token in provider body',
    },
  };
  const skipped = publicDiscoveryStatus(raw);
  assert.equal(skipped.requestAttempted, false);
  assert.match(skipped.message, /새 요청을 보내지 않았습니다/u);
  assert.equal(skipped.lastAttemptAt, '2026-09-05T23:00:00.000Z');
  assert.equal(skipped.nextRetryAt, '2026-09-06T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(skipped), /secret|provider body/);
  const actual = publicDiscoveryStatus({
    ...raw,
    metadataJson: { ...raw.metadataJson, requestAttempted: true, httpStatus: 429 },
  });
  assert.match(actual.message, /429/);
  assert.match(actual.message, /실제 공급자 응답/u);
});

test('metadata mapper exposes translation failure and waiting states without any body dependency', () => {
  const row = Object.assign(new SourceItemEntity(), {
    id: 'source',
    source: 'IR',
    title: 'Company releases new quarterly results',
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    firstObservedAt: new Date(),
    rawHash: 'a'.repeat(64),
    sourcePolicyJson: {
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      metadataStorageAllowed: true,
      displayAllowed: true,
      aiAllowed: true,
      fullTextStorageAllowed: false,
    },
    rawMetadataJson: { description: 'Original feed summary' },
  });
  assert.equal(mapSourceItem(row).translationStatus, 'PENDING');
  row.translationJson = { inputHash: row.rawHash, status: 'FAILED', error: 'private error' };
  assert.equal(mapSourceItem(row).translationStatus, 'FAILED');
  assert.equal(mapSourceItem(row).description, 'Original feed summary');
  assert.equal(mapSourceItem(row).contentState, 'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(mapSourceItem(row)), /private error/);
  row.source = 'NAVER';
  assert.equal(mapSourceItem(row).translationStatus, 'UNAVAILABLE');
});
