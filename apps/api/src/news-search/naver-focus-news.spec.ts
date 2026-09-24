import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadGatewayException, HttpException, ServiceUnavailableException } from '@nestjs/common';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { NaverNewsSearchService } from './naver-news-search.service';
import {
  NaverFocusNewsService,
  NAVER_FOCUS_INTERVAL_MS,
  NAVER_NEWS_TOPICS,
  naverCompanySearchTerm,
} from './naver-focus-news.service';

const company = {
  id: '11111111-1111-4111-a111-111111111111',
  name: '삼성전자',
  nameKo: '삼성전자',
  nameEn: 'Samsung Electronics',
  market: 'KOSPI',
  stockCode: '005930',
  ticker: null,
  isListed: true,
};
const providerItem = (title = '<b>삼성전자</b> 실적 발표', description = '실적 요약') => ({
  title,
  description,
  link: 'https://news.naver.com/article/1',
  originallink: 'https://publisher.example/article',
  pubDate: 'Sun, 06 Sep 2026 12:00:00 +0900',
});
function context(
  items = [providerItem()],
  catalogue: object[] = [company],
  scheduledCompanies: object[] = [company],
) {
  const calls: string[] = [];
  const queries: string[] = [];
  let allowed = true;
  let failure = false;
  const targetErrors = new Map<string, Error>();
  let remainingWindow: number | undefined;
  let nextRequestAt: string | null = null;
  const database = {
    requireDataSource: () => ({
      query: async (sql: string, params?: string[]) => {
        queries.push(sql);
        if (sql.includes('FROM company_aliases'))
          return [{ companyId: company.id, alias: '자금', aliasType: 'COMPANY_NAME' }];
        if (sql.includes('is_listed isListed')) return catalogue;
        if (params?.length && params[0] !== company.id && params[0] !== 'MEMBER:a') return [];
        return scheduledCompanies;
      },
    }),
  } as unknown as DatabaseRuntimeService;
  const search = {
    status: async () => ({
      configured: true,
      automaticAllowed: allowed && (remainingWindow === undefined || remainingWindow > 0),
      remainingToday: 100,
      remainingMonth: 100,
      reason: null,
      ...(remainingWindow === undefined ? {} : { remainingWindow, nextRequestAt }),
    }),
    search: async (input: { q: string }, onRequest?: () => void) => {
      calls.push(input.q);
      onRequest?.();
      if (failure) throw Error('provider unavailable');
      if (targetErrors.has(input.q)) throw targetErrors.get(input.q);
      return {
        provider: 'NAVER',
        items,
        total: items.length,
        start: 1,
        display: items.length,
        lastBuildDate: 'Sun, 06 Sep 2026 12:00:00 +0900',
      };
    },
  } as unknown as NaverNewsSearchService;
  const service = new NaverFocusNewsService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    database,
    search,
  );
  return {
    service,
    calls,
    queries,
    setTargetFailure: (query: string, error: Error) => targetErrors.set(query, error),
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setFailure: (value: boolean) => {
      failure = value;
    },
    setWindow: (remaining: number, retryAt: string | null) => {
      remainingWindow = remaining;
      nextRequestAt = retryAt;
    },
  };
}

test('scheduled topics share the durable remaining slots and expose the budget retry time', async () => {
  const { service, calls, setWindow } = context();
  const retryAt = '2026-09-07T00:15:00.000Z';
  try {
    setWindow(2, null);
    await service.refresh();
    assert.equal(calls.length, 2);
    setWindow(0, retryAt);
    await service.refresh();
    assert.equal(calls.length, 2);
    assert.equal((await service.feed({ scope: 'market' }, 'MEMBER:a')).nextRequestAt, retryAt);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('company arrays read existing snapshots without triggering one provider search per company', async () => {
  const { service, calls } = context([
    providerItem(),
    providerItem('금리 정책 발표', '관련 기업이 없는 시장 뉴스'),
  ]);
  try {
    const initial = await service.feed({ companyIds: [company.id], scope: 'company' }, 'MEMBER:a');
    assert.deepEqual(initial.groups, []);
    assert.deepEqual(calls, []);
    await service.feed({ companyId: company.id, scope: 'company' }, 'MEMBER:a');
    assert.equal(calls.length, 1);
    const cached = await service.feed({ companyIds: [company.id], scope: 'company' }, 'MEMBER:a');
    assert.equal(calls.length, 1);
    assert.equal(cached.groups.flat().length, 1);
    assert.deepEqual(cached.groups[0]![0]!.providerOriginal, providerItem());
    assert.deepEqual(
      (await service.feed({ companyIds: [], scope: 'company' }, 'MEMBER:a')).groups,
      [],
    );
    assert.equal(calls.length, 1);
    await assert.rejects(() => service.feed({ companyIds: [company.id, company.id] }, 'MEMBER:a'));
  } finally {
    await service.onApplicationShutdown();
  }
});

test('market summaries cannot create badges from unlisted ordinary words or unreviewed alias rows', async () => {
  const ordinary = ['자금', '대해', '모든', '보라', '지지'].map((name) => ({
    ...company,
    id: name,
    name,
    nameKo: name,
    nameEn: null,
    market: 'OTHER',
    isListed: false,
    stockCode: null,
    ticker: name,
  }));
  const words = providerItem('금리 인하 지지 의견', '모든 정책에 대해 자금 지원을 보라');
  const explicit = {
    ...providerItem('삼성전자와 NVIDIA 실적 발표', '제공된 기업 소식'),
    originallink: 'https://publisher.example/explicit-companies',
  };
  const nvidia = {
    ...company,
    id: 'nvidia',
    name: '엔비디아',
    nameKo: '엔비디아',
    nameEn: 'NVIDIA Corporation',
    market: 'NASDAQ',
    stockCode: null,
    ticker: 'NVDA',
  };
  const { service, queries } = context([words, explicit], [company, nvidia, ...ordinary]);
  try {
    await service.refresh();
    const market = await service.feed({ scope: 'market' }, 'MEMBER:a');
    const [general, relevant] = market.groups[0]!;
    assert.deepEqual(general?.relatedCompanies, []);
    assert.deepEqual(general?.tickers, []);
    assert.deepEqual(general?.providerOriginal, words);
    assert.deepEqual(
      relevant?.relatedCompanies?.map((item) => item.id).sort(),
      [company.id, nvidia.id].sort(),
    );
    assert.ok(queries.some((sql) => /WHERE is_listed=1 AND market IN/u.test(sql)));
    assert.ok(queries.every((sql) => !sql.includes('company_aliases')));
  } finally {
    await service.onApplicationShutdown();
  }
});

test('Samsung DX division acronyms do not attach the unrelated US DX security badge', async () => {
  const dynex = {
    ...company,
    id: 'dynex',
    name: '다이넥스캐피탈',
    nameKo: '다이넥스캐피탈',
    nameEn: 'Dynex Capital Inc.',
    market: 'NYSE',
    stockCode: null,
    ticker: 'DX',
  };
  const nvidia = {
    ...dynex,
    id: 'nvidia',
    name: '엔비디아',
    nameKo: '엔비디아',
    nameEn: 'NVIDIA Corporation',
    market: 'NASDAQ',
    ticker: 'NVDA',
  };
  const division = providerItem('삼성전자 DX 동행노조 소식', '디바이스경험(DX) 부문 관련 요약');
  const explicit = {
    ...providerItem('해외 종목 소식', '$NVDA 및 NYSE:DX 실적 발표'),
    originallink: 'https://publisher.example/explicit-symbols',
  };
  const { service } = context([division, explicit], [company, dynex, nvidia]);
  try {
    await service.refresh();
    const [first, second] = (await service.feed({ scope: 'market' }, 'MEMBER:a')).groups[0]!;
    assert.deepEqual(
      first?.relatedCompanies?.map((item) => item.id),
      [company.id],
    );
    assert.deepEqual(first?.providerOriginal, division);
    assert.deepEqual(second?.relatedCompanies?.map((item) => item.id).sort(), ['dynex', 'nvidia']);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('company and eleven topic searches share a ten-request cycle and region-specific market queries', async () => {
  const { service, calls, setAllowed } = context();
  try {
    const pending = service.refresh();
    assert.equal(service.refresh(), pending);
    await pending;
    assert.deepEqual(calls, [
      company.name,
      ...NAVER_NEWS_TOPICS.slice(0, 9).map((topic) => topic.name),
    ]);
    assert.ok(calls.length <= 10);
    const market = await service.feed({ scope: 'market' }, 'MEMBER:a');
    assert.equal(market.groups.length, 6);
    const korean = await service.feed({ scope: 'market', region: 'kr' }, 'MEMBER:a');
    const overseas = await service.feed({ scope: 'market', region: 'us' }, 'MEMBER:a');
    assert.deepEqual(
      korean.resultSets.map((set) => set.queryLabel),
      ['국내 증시', '한국은행 기준금리', '원달러 환율'],
    );
    assert.deepEqual(
      overseas.resultSets.map((set) => set.queryLabel),
      ['미국 증시', '미국 연준 금리', '미국 경제'],
    );
    assert.ok(korean.resultSets.every((set) => set.region === 'kr'));
    assert.ok(overseas.resultSets.every((set) => set.region === 'us'));
    const asset = await service.feed({ asset: 'wti' }, 'MEMBER:a');
    assert.equal(asset.groups.length, 1);
    assert.equal(calls.length, 10); // Reading a topic never starts another provider request.
    setAllowed(false);
    await service.refresh();
    assert.equal(calls.length, 10);
    assert.equal((await service.feed({ scope: 'personal' }, 'MEMBER:other')).groups.length, 0);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('company relevance requires original title or description evidence and preserves raw provider fields', async () => {
  const raw = providerItem('반도체 시장 소식', '<b>삼성전자</b>가 실적을 발표했다');
  const { service, calls } = context([
    raw,
    {
      ...providerItem('다른 기업 뉴스', '검색어는 근거가 아니다'),
      originallink: 'https://publisher.example/unrelated',
    },
    { ...providerItem(), originallink: 'javascript:alert(1)', link: '' },
  ]);
  try {
    const [first, second] = await Promise.all([
      service.feed({ companyId: company.id }, 'MEMBER:a'),
      service.feed({ companyId: company.id }, 'MEMBER:a'),
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(first, second);
    assert.equal(first.groups[0]?.length, 1);
    assert.equal(first.resultSets[0]?.items.length, 3);
    assert.deepEqual(first.resultSets[0]?.items[0], raw);
    assert.equal(first.resultSets[0]?.items[1]?.title, '다른 기업 뉴스');
    assert.equal(first.resultSets[0]?.items[2]?.originallink, 'javascript:alert(1)');
    assert.equal(first.resultSets[0]?.queryLabel, company.name);
    assert.equal(first.resultSets[0]?.total, 3);
    const item = first.groups[0]?.[0];
    assert.deepEqual(item?.providerOriginal, raw);
    assert.equal(item?.title, raw.title);
    assert.equal(item?.description, raw.description);
    assert.equal(item?.relatedCompanies?.[0]?.id, company.id);
    assert.equal(item?.displayMode, 'EXTERNAL_LINK');
    assert.equal(item?.url, raw.originallink);
    assert.equal(item?.rightsMode, 'LINK_ONLY');
  } finally {
    await service.onApplicationShutdown();
  }
});

test('expired snapshots disappear and provider failures observe the same cooldown', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const { service, calls, setFailure } = context();
  try {
    await service.feed({ companyId: company.id }, 'MEMBER:a');
    assert.equal(calls.length, 1);
    now += NAVER_FOCUS_INTERVAL_MS + 1;
    setFailure(true);
    assert.equal((await service.feed({ companyId: company.id }, 'MEMBER:a')).groups.length, 0);
    await service.feed({ companyId: company.id }, 'MEMBER:a');
    assert.equal(calls.length, 2);
    assert.equal((await service.feed({ asset: 'btc' }, 'MEMBER:a')).status, 'PENDING');
    assert.equal(
      (await service.feed({ companyIds: [company.id] }, 'MEMBER:a')).status,
      'UNAVAILABLE',
    );
    assert.equal(calls.length, 2);
  } finally {
    Date.now = originalNow;
    await service.onApplicationShutdown();
  }
});

test('public company feeds collect validated nonrepresentative classes without changing actual relevance IDs', async () => {
  const component = {
    ...company,
    id: 'goog-class',
    name: '알파벳 C',
    nameKo: '알파벳 C',
    nameEn: 'Alphabet Class C',
    market: 'NASDAQ',
    stockCode: null,
    ticker: 'GOOG',
  };
  const calls: string[] = [],
    queries: string[] = [];
  const database = {
    requireDataSource: () => ({
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('is_listed isListed')) return [component];
        assert.match(sql, /market_leader_company_links/u);
        return [component];
      },
    }),
  } as unknown as DatabaseRuntimeService;
  const search = {
    status: async () => ({
      configured: true,
      automaticAllowed: true,
      remainingToday: 10,
      remainingMonth: 10,
    }),
    search: async ({ q }: { q: string }) => {
      calls.push(q);
      return { items: [providerItem('$GOOG 실적 발표')] };
    },
  } as unknown as NaverNewsSearchService;
  const service = new NaverFocusNewsService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'false' }),
    database,
    search,
  );
  try {
    await service.refresh();
    const priorCalls = calls.length;
    const result = await service.feed({ scope: 'company', region: 'us' }, 'BOT:PUBLIC');
    assert.equal(calls.length, priorCalls);
    assert.ok(calls.includes('알파벳 C'));
    assert.deepEqual(
      result.groups.flat().map((row) => row.relatedCompanies?.map((c) => c.id)),
      [['goog-class']],
    );
    assert.ok(queries.filter((sql) => sql.includes('market_leader_company_links')).length >= 2);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('large company queues alternate with topics and missing targets report partial coverage', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({
    ...company,
    id: `company-${index}`,
    name: `회사 ${index}`,
    nameKo: `회사 ${index}`,
  }));
  const { service, calls } = context([providerItem()], [company], many);
  try {
    await service.refresh();
    assert.deepEqual(
      calls,
      Array.from({ length: 5 }, (_, index) => [
        many[index]!.name,
        NAVER_NEWS_TOPICS[index]!.name,
      ]).flat(),
    );
    const market = await service.feed({ scope: 'market' }, 'MEMBER:a');
    assert.equal(market.status, 'PARTIAL');
    assert.equal(market.resultSets.filter((set) => set.status === 'AVAILABLE').length, 5);
    assert.equal(market.resultSets.filter((set) => set.status === 'PENDING').length, 1);
    const diagnostic = service.collectionStatus();
    assert.equal(diagnostic.availableTargets, 10);
    assert.equal(diagnostic.pendingTargets, 101);
    assert.equal(diagnostic.failedTargets, 0);
    assert.ok(diagnostic.lastSuccessAt && diagnostic.lastAttemptAt);
    assert.doesNotMatch(JSON.stringify(diagnostic), /회사|삼성|publisher|pubDate/);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('individual provider failures do not block topics, but shared authentication or budget failures stop the cycle', async () => {
  const isolated = context();
  try {
    isolated.setTargetFailure(company.name, new BadGatewayException('synthetic failure'));
    await isolated.service.refresh();
    assert.equal(isolated.calls.length, 10);
    const failed = await isolated.service.feed({ companyIds: [company.id] }, 'MEMBER:a');
    assert.equal(failed.resultSets[0]?.status, 'UNAVAILABLE');
    const topics = await isolated.service.feed({ scope: 'market' }, 'MEMBER:a');
    assert.equal(topics.status, 'AVAILABLE');
    assert.ok(topics.resultSets.every((set) => set.status === 'AVAILABLE'));
    assert.equal(isolated.service.collectionStatus().failedTargets, 1);
  } finally {
    await isolated.service.onApplicationShutdown();
  }
  for (const error of [
    new ServiceUnavailableException({ code: 'NAVER_AUTH_INVALID', message: 'synthetic' }),
    new ServiceUnavailableException({ code: 'NAVER_ACCESS_DENIED', message: 'synthetic' }),
    new ServiceUnavailableException({ code: 'USAGE_UNAVAILABLE', message: 'synthetic' }),
    new HttpException('synthetic', 429),
  ]) {
    const shared = context();
    try {
      shared.setTargetFailure(company.name, error);
      await shared.service.refresh();
      assert.deepEqual(shared.calls, [company.name]);
      assert.equal(
        (await shared.service.feed({ scope: 'market' }, 'MEMBER:a')).status,
        'UNAVAILABLE',
      );
    } finally {
      await shared.service.onApplicationShutdown();
    }
  }
});

test('next provider request discards the previous set even when the new request fails', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const { service, setFailure } = context();
  try {
    await service.refresh();
    assert.equal(
      (await service.feed({ scope: 'market', region: 'kr' }, 'MEMBER:a')).resultSets[0]?.status,
      'AVAILABLE',
    );
    now += NAVER_FOCUS_INTERVAL_MS + 1;
    setFailure(true);
    await service.refresh();
    const result = await service.feed({ scope: 'market', region: 'kr' }, 'MEMBER:a');
    assert.equal(result.resultSets[0]?.status, 'UNAVAILABLE');
    assert.deepEqual(result.resultSets[0]?.items, []);
    assert.equal(result.resultSets[0]?.fetchedAt, null);
  } finally {
    Date.now = originalNow;
    await service.onApplicationShutdown();
  }
});

test('raw snapshots are evicted at expiry without waiting for another collection or feed read', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-09-24T00:00:00Z') });
  const { service } = context();
  try {
    await service.feed({ companyId: company.id }, 'MEMBER:a');
    const storage = service as unknown as { snapshots: Map<string, unknown> };
    assert.equal(storage.snapshots.size, 1);
    t.mock.timers.tick(NAVER_FOCUS_INTERVAL_MS - 1);
    assert.equal(storage.snapshots.size, 1);
    t.mock.timers.tick(1);
    assert.equal(storage.snapshots.size, 0);
    assert.equal(service.collectionStatus().availableTargets, 0);
    assert.ok(service.collectionStatus().lastSuccessAt);
  } finally {
    await service.onApplicationShutdown();
  }
});

test('ordinary-word listed names use full company names in actual provider queries and result labels', async () => {
  const newCompany = {
    ...company,
    name: 'NEW',
    nameKo: 'NEW',
    nameEn: 'Next Entertainment World Co., Ltd.',
    stockCode: '160550',
  };
  const nice = {
    ...company,
    name: 'NICE',
    nameKo: 'NICE',
    nameEn: 'NICE Holdings Co., Ltd.',
    stockCode: '034310',
  };
  assert.equal(naverCompanySearchTerm(newCompany), newCompany.nameEn);
  assert.equal(naverCompanySearchTerm(nice), nice.nameEn);
  assert.equal(naverCompanySearchTerm({ ...newCompany, nameEn: null }), 'KRX:160550');
  assert.equal(naverCompanySearchTerm({ ...newCompany, nameEn: null, stockCode: null }), null);
  const { service, calls } = context(
    [providerItem('Next Entertainment World 실적')],
    [newCompany],
    [newCompany],
  );
  try {
    const result = await service.feed({ companyId: company.id }, 'MEMBER:a');
    assert.deepEqual(calls, [newCompany.nameEn]);
    assert.equal(result.resultSets[0]?.queryLabel, newCompany.nameEn);
  } finally {
    await service.onApplicationShutdown();
  }
});
