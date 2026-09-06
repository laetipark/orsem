import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { NaverNewsSearchService } from './naver-news-search.service';
import {
  NaverFocusNewsService,
  NAVER_FOCUS_INTERVAL_MS,
  NAVER_NEWS_TOPICS,
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
function context(items = [providerItem()], catalogue: object[] = [company]) {
  const calls: string[] = [];
  const queries: string[] = [];
  let allowed = true;
  let failure = false;
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
        return [company];
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
    search: async (input: { q: string }) => {
      calls.push(input.q);
      if (failure) throw Error('provider unavailable');
      return { provider: 'NAVER', items };
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

test('company and all eight topic searches use the same bounded round robin and shared allowance', async () => {
  const { service, calls, setAllowed } = context();
  try {
    const pending = service.refresh();
    assert.equal(service.refresh(), pending);
    await pending;
    assert.deepEqual(calls, [company.name, ...NAVER_NEWS_TOPICS.map((topic) => topic.name)]);
    assert.ok(calls.length <= 10);
    const market = await service.feed({ scope: 'market' }, 'MEMBER:a');
    assert.equal(market.groups.length, 3);
    const asset = await service.feed({ asset: 'wti' }, 'MEMBER:a');
    assert.equal(asset.groups.length, 1);
    assert.equal(calls.length, 9); // Reading a topic never starts another provider request.
    setAllowed(false);
    await service.refresh();
    assert.equal(calls.length, 9);
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
    assert.equal((await service.feed({ asset: 'btc' }, 'MEMBER:a')).status, 'UNAVAILABLE');
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
