import assert from 'node:assert/strict';
import test from 'node:test';
import { RightsMode } from '@orsem/contracts';
import type { EntityManager } from 'typeorm';
import { FilingEntity, SourceItemEntity } from './entities';
import {
  buildNewsOfficialReferences,
  extractNewsOfficialIdentifiers,
  refreshNewsOfficialReferences,
} from './news-official-references';

function news(overrides: Partial<SourceItemEntity> = {}): SourceItemEntity {
  return Object.assign(new SourceItemEntity(), {
    id: 'news-1',
    source: 'MARKETAUX_NEWS',
    sourceKind: 'AGGREGATOR',
    title: 'Example announcement',
    url: 'https://publisher.example/a',
    companyId: 'company-a',
    rawHash: 'a'.repeat(64),
    publishedAt: new Date('2026-09-07T00:00:00Z'),
    rightsMode: RightsMode.STORE_METADATA_ONLY,
    sourcePolicyJson: {
      rightsMode: RightsMode.STORE_METADATA_ONLY,
      metadataStorageAllowed: true,
      displayAllowed: true,
    },
    rawMetadataJson: { manualCompanyIds: ['company-a'] },
    ...overrides,
  });
}
const filing = Object.assign(new FilingEntity(), {
  id: 'filing-1',
  source: 'OPENDART',
  rceptNo: '20260907000001',
  companyId: 'company-a',
  rceptDate: '2026-09-07',
});
const sec = news({
  id: 'sec-1',
  source: 'SEC',
  sourceKind: 'OFFICIAL_DISCLOSURE',
  externalId: '0001234567-26-000001',
  url: 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000001/report.htm',
  rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
  sourcePolicyJson: null,
});

test('official identifier parser extracts DART receipt, SEC accession and archive URL without requests', () => {
  const ids = extractNewsOfficialIdentifiers([
    'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260907000001',
    sec.url,
    '0001234567-26-000001',
    'https://user:password@publisher.example/private',
  ]);
  assert.deepEqual(ids.dartReceiptIds, ['20260907000001']);
  assert.deepEqual(ids.secAccessions, ['0001234567-26-000001']);
  assert.ok(!ids.urls.some((url) => url.includes('password')));
});

test('company/time associations stay UNVERIFIED; explicit references become LINKED, never automatically CONFIRMED', () => {
  const input = {
    source: news(),
    companyIds: ['company-a'],
    texts: [],
    filings: [filing],
    officialSources: [sec],
  };
  const related = buildNewsOfficialReferences(input);
  assert.equal(related.officialVerification, 'UNVERIFIED');
  assert.equal(related.officialReferences.length, 2);
  assert.ok(
    related.officialReferences.every(
      (ref) => ref.status === 'RELATED' && ref.matchMethod === 'COMPANY_TIME',
    ),
  );
  const linked = buildNewsOfficialReferences({ ...input, texts: ['20260907000001', sec.url] });
  assert.equal(linked.officialVerification, 'LINKED');
  assert.deepEqual(
    new Set(linked.officialReferences.map((ref) => ref.matchMethod)),
    new Set(['EXPLICIT_ID', 'EXPLICIT_URL']),
  );
  assert.ok(linked.officialReferences.every((ref) => ref.status === 'RELATED'));
});

test('unrelated company, publication gap, unknown rights and independent articles do not become official candidates', () => {
  for (const source of [
    news({ companyId: 'company-b' }),
    news({ publishedAt: new Date('2026-09-11T00:00:00Z') }),
  ]) {
    assert.equal(
      buildNewsOfficialReferences({
        source,
        companyIds: [source.companyId!],
        texts: [],
        filings: [filing],
        officialSources: [sec],
      }).officialReferences.length,
      0,
    );
  }
  const hidden = news({
    id: 'ir-1',
    source: 'IR',
    sourceKind: 'COMPANY_IR',
    sourcePolicyJson: null,
  });
  const media = news({ id: 'media-1', sourceKind: 'INDEPENDENT_MEDIA' });
  const result = buildNewsOfficialReferences({
    source: news(),
    companyIds: ['company-a'],
    texts: [hidden.url],
    filings: [],
    officialSources: [hidden, media],
  });
  assert.deepEqual(result.officialReferences, []);
});

test('manual confirmation and rejection persist only for the same news and target hashes', () => {
  const input = {
    source: news(),
    companyIds: ['company-a'],
    texts: [sec.url],
    filings: [filing],
    officialSources: [sec],
  };
  const refs = buildNewsOfficialReferences(input).officialReferences;
  const previous = refs.map((ref) => ({
    ...ref,
    status: ref.kind === 'FILING' ? 'REJECTED' : 'CONFIRMED',
    reviewedByAdminId: 'admin-a',
    reviewedAt: '2026-09-07T01:00:00Z',
  }));
  const accepted = buildNewsOfficialReferences({ ...input, previous });
  assert.equal(accepted.officialVerification, 'CONFIRMED');
  assert.ok(accepted.officialReferences.some((ref) => ref.status === 'REJECTED'));
  const sourceChanged = buildNewsOfficialReferences({
    ...input,
    source: news({ rawHash: 'b'.repeat(64) }),
    previous,
  });
  assert.ok(sourceChanged.officialReferences.every((ref) => ref.status === 'RELATED'));
  const targetChanged = buildNewsOfficialReferences({
    ...input,
    officialSources: [{ ...sec, rawHash: 'c'.repeat(64) }],
    previous,
  });
  assert.equal(targetChanged.officialVerification, 'LINKED');
});

test('candidate projection caps results at ten and cannot assign CONFIRMED to API-reported numbers', () => {
  const filings = Array.from({ length: 30 }, (_, index) => ({
    ...filing,
    id: `filing-${String(index).padStart(2, '0')}`,
  }));
  const result = buildNewsOfficialReferences({
    source: news(),
    companyIds: ['company-a'],
    texts: ['Revenue $500 million; positive sentiment'],
    filings,
    officialSources: [],
  });
  assert.equal(result.officialReferences.length, 10);
  assert.equal(result.officialVerification, 'UNVERIFIED');
});

test('DART dates use the news calendar day in KST and existing many-company links are reused', () => {
  const source = news({ publishedAt: new Date('2026-09-06T16:00:00Z') });
  const dated = { ...filing, rceptDate: '2026-09-10' };
  const linkedCompanySource = { ...sec, companyId: 'company-b' };
  const result = buildNewsOfficialReferences({
    source,
    companyIds: ['company-a'],
    texts: [],
    filings: [dated],
    officialSources: [linkedCompanySource],
    officialCompanyIds: { [sec.id]: ['company-a'] },
  });
  assert.equal(result.officialReferences.length, 2);
  assert.equal(result.officialVerification, 'UNVERIFIED');
  assert.equal(dated.rceptDate, '2026-09-10');
});

test('rights gate prevents reads of article descriptions and official targets; manual company choices survive invalidation', async () => {
  const source = news({ sourcePolicyJson: null });
  let updates = 0;
  const manager = {
    getRepository(entity: unknown) {
      assert.equal(entity, SourceItemEntity);
      return {
        save: async () => {
          updates += 1;
        },
      };
    },
  } as unknown as EntityManager;
  await refreshNewsOfficialReferences(manager, source);
  assert.equal(updates, 1);
  assert.deepEqual(source.rawMetadataJson?.manualCompanyIds, ['company-a']);
  assert.deepEqual(source.rawMetadataJson?.officialReferences, []);
  assert.equal(source.rawMetadataJson?.officialVerification, 'UNVERIFIED');
});
