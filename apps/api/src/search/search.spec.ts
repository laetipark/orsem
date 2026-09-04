import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RightsMode } from '@orsem/contracts';
import { CompanyEntity, FilingEntity, SourceItemEntity } from '@orsem/database';
import { DataSource, type EntityTarget } from 'typeorm';
import type { AuthService } from '../auth/auth.service';
import type { MemberService } from '../auth/member.service';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { AdminSessionGuard } from '../security/security';
import { SearchController } from './search.controller';
import { publicSourceUrl, searchPattern, SearchService } from './search.service';

function fixtureSearch() {
  const fixtures = new FixtureStoreService();
  const service = new SearchService(
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
    {
      requireDataSource: () => {
        throw new Error('예시 검색은 DB에 접근하지 않습니다.');
      },
    } as unknown as DatabaseRuntimeService,
    fixtures,
  );
  return { fixtures, service, controller: new SearchController(service) };
}

test('검색어와 그룹 한도를 검증하고 빈 검색으로 전체 목록을 반환하지 않는다', async () => {
  const { controller } = fixtureSearch();
  const result = await controller.search({ q: '  삼성  ' });
  assert.equal(result.query, '삼성');
  assert.equal(result.companies[0]?.title, '삼성전자');
  for (const query of [
    {},
    { q: '' },
    { q: '  ' },
    { q: 'a'.repeat(121) },
    { q: ['삼성', '애플'] },
    { q: '삼성', limit: 0 },
    { q: '삼성', limit: 11 },
    { q: '삼성', limit: 1.5 },
    { q: '삼성', unexpected: true },
  ]) {
    assert.throws(
      () => controller.search(query),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
    );
  }
});

test('예시에서도 티커 검색과 그룹별 한도, 공시 날짜와 출처를 보존한다', async () => {
  const { controller, fixtures } = fixtureSearch();
  assert.equal((await controller.search({ q: 'nvda' })).companies[0]?.title, '엔비디아');
  const original = fixtures.filings[0]!;
  fixtures.filings.push({
    ...original,
    id: 'second-filing',
    rceptNo: '20260902000001',
    rceptDate: '2026-09-02',
  });
  const result = await controller.search({ q: '삼성', limit: '1' });
  assert.equal(result.filings.length, 1);
  assert.equal(result.hasMore.filings, true);
  assert.equal(result.filings[0]?.rceptDate, original.rceptDate);
  assert.equal(result.filings[0]?.publishedAt, null);
  assert.equal(result.filings[0]?.firstObservedAt, original.firstObservedAt);
  assert.equal(result.filings[0]?.rightsMode, RightsMode.OFFICIAL_PUBLIC_DATA);
  assert.match(result.filings[0]!.url, /^https:\/\/dart\.fss\.or\.kr\//u);
  assert.deepEqual((await controller.search({ q: '검색결과없음' })).hasMore, {
    companies: false,
    news: false,
    filings: false,
  });
});

test('검색은 지역을 그룹별 한도 전에 적용하고 지역 불명 뉴스는 전체에서만 반환한다', async () => {
  const { fixtures, controller } = fixtureSearch();
  const original = fixtures.sourceItems[0]!;
  fixtures.sourceItems.push(
    { ...original, source: 'GDELT', id: 'unassigned', title: '지역 검색 뉴스', tickers: [] },
    { ...original, id: 'sec', title: '지역 검색 공시', source: 'SEC', tickers: [] },
  );
  assert.equal((await controller.search({ q: 'NVDA', region: 'kr' })).companies.length, 0);
  assert.equal((await controller.search({ q: 'NVDA', region: 'us' })).companies.length, 1);
  assert.equal((await controller.search({ q: '삼성', region: 'us' })).filings.length, 0);
  const all = await controller.search({ q: '지역 검색', region: 'all', limit: 1 });
  assert.equal(all.news[0]?.id, 'unassigned');
  assert.equal(all.filings[0]?.id, 'sec');
  const kr = await controller.search({ q: '지역 검색', region: 'kr', limit: 1 });
  assert.deepEqual([kr.news.length, kr.filings.length], [0, 0]);
  const us = await controller.search({ q: '지역 검색', region: 'us', limit: 1 });
  assert.deepEqual([us.news.length, us.filings[0]?.id], [0, 'sec']);
  assert.throws(() => controller.search({ q: '삼성', region: 'invalid' }), HttpException);
});

test('시장 전반 RSS는 종목 연결 없이 양 지역 검색에 포함하고 일반 미분류 뉴스와 구분한다', async () => {
  const { fixtures, controller } = fixtureSearch();
  const original = fixtures.sourceItems[0]!;
  fixtures.sourceItems.push(
    {
      ...original,
      id: 'unassigned-newest',
      title: '시장 전반 테스트',
      source: 'NAVER',
      tickers: [],
      publishedAt: '2026-09-04T04:00:00.000Z',
    },
    ...['03', '02'].map((hour) => ({
      ...original,
      id: `rss-${hour}`,
      title: '시장 전반 테스트',
      source: 'NEWS_RSS',
      sourceName: '테스트 RSS 제공자',
      tickers: [],
      publishedAt: `2026-09-04T${hour}:00:00.000Z`,
    })),
  );
  for (const region of ['kr', 'us']) {
    const result = await controller.search({ q: '시장 전반 테스트', region, limit: 1 });
    assert.deepEqual(
      result.news.map((item) => item.id),
      ['rss-03'],
    );
    assert.equal(result.hasMore.news, true);
    assert.equal(result.news[0]?.source, 'NEWS_RSS');
    assert.equal(result.news[0]?.companyId, null);
    assert.equal(result.news[0]?.subtitle, '테스트 RSS 제공자');
    assert.equal(result.news[0]?.translation, null);
  }
  const all = await controller.search({ q: '시장 전반 테스트', region: 'all', limit: 1 });
  assert.equal(all.news[0]?.id, 'rss-03');
  assert.equal(
    all.news.some((item) => item.source === 'NAVER'),
    false,
  );
});

test('검색 SQL은 RSS의 명시적 global 또는 해당 지역 메타데이터를 종목 연결과 함께 조회한다', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    database: 'test',
    entities: [CompanyEntity, FilingEntity, SourceItemEntity],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: Array<{ sql: string; parameters: unknown[] }> = [];
  const source = {
    getRepository(entity: EntityTarget<CompanyEntity | FilingEntity | SourceItemEntity>) {
      return {
        createQueryBuilder(alias: string) {
          const qb = metadata.getRepository(entity).createQueryBuilder(alias);
          qb.getRawMany = async <T>() => {
            const [sql, parameters] = qb.getQueryAndParameters();
            captured.push({ sql, parameters });
            return [] as T[];
          };
          return qb;
        },
      };
    },
  } as unknown as DataSource;
  const service = new SearchService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { requireDataSource: () => source } as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  for (const region of ['kr', 'us'] as const) {
    captured.length = 0;
    await service.search({ q: '시장', region, limit: 1 });
    const news = captured.find((query) =>
      query.sql.includes("`item`.`source` NOT IN ('SEC', 'NAVER')"),
    )!;
    assert.ok(news);
    assert.match(news.sql, /LEFT JOIN `companies`/u);
    assert.match(news.sql, /OR \(`item`\.`source` = 'NEWS_RSS' AND JSON_UNQUOTE/u);
    assert.match(news.sql, /JSON_EXTRACT\(`item`\.`raw_metadata_json`, '\$\.marketRegion'\)/u);
    assert.match(news.sql, /IN \('global', \?\)/u);
    assert.match(news.sql, /LIMIT 2$/u);
    assert.ok(news.parameters.includes(region));
    assert.ok(news.parameters.includes(region === 'kr' ? 'KOSPI' : 'NASDAQ'));
    assert.equal(news.sql.split(' FROM ')[0]?.includes('raw_metadata_json'), false);
  }
});

test('외부 링크는 인증정보 없는 HTTP(S)만 허용한다', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,test',
    '//example.com',
    'https://user:secret@example.com/a',
    'https://user@example.com/a',
    'https://example.com/\ninvalid',
    'not-a-url',
  ])
    assert.equal(publicSourceUrl(url), null);
  assert.equal(publicSourceUrl('https://example.com/news?q=1'), 'https://example.com/news?q=1');
  assert.equal(publicSourceUrl('http://example.com/news'), 'http://example.com/news');
  assert.equal(searchPattern('50%_!'), '%50!%!_!!%');
});

test('실제 TypeORM SQL은 입력을 바인딩하고 원문·권리 제한 데이터를 검색 응답에서 제외한다', async () => {
  const metadata = new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    username: 'test',
    password: 'test',
    database: 'test',
    entities: [CompanyEntity, FilingEntity, SourceItemEntity],
    synchronize: false,
  });
  await (metadata as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  const captured: Array<{ sql: string; parameters: unknown[] }> = [];
  const now = new Date('2026-09-04T00:30:00.000Z');
  const news = {
    id: 'news',
    title: '보존된 제목',
    url: 'https://example.com/news',
    companyId: 'company',
    companyName: '기업',
    source: 'IR',
    sourceName: '뉴스 제공자',
    rightsMode: RightsMode.STORE_METADATA_ONLY,
    publishedAt: now,
    firstObservedAt: now,
    rceptDate: null,
    rawHash: 'a'.repeat(64),
    sourcePolicyJson: { aiAllowed: true },
    translationJson: {
      version: 1,
      status: 'COMPLETED',
      inputHash: 'a'.repeat(64),
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      provider: 'LOCAL',
      model: 'test-local-model',
      title: '별도로 번역한 제목',
      description: '권리에 따라 제외할 번역 설명',
      translatedAt: now.toISOString(),
      attemptedAt: now.toISOString(),
      attempts: 1,
      nextAttemptAt: null,
      prompt: '공개하면 안 되는 내부 값',
    },
    description: '노출되면 안 되는 본문',
    rawMetadataJson: { private: 'raw' },
    rawObjectUri: '/private/document',
  };
  const source = {
    getRepository(entity: EntityTarget<CompanyEntity | FilingEntity | SourceItemEntity>) {
      return {
        createQueryBuilder(alias: string) {
          const query = metadata.getRepository(entity).createQueryBuilder(alias);
          query.getRawMany = async <T>() => {
            const [sql, parameters] = query.getQueryAndParameters();
            captured.push({ sql, parameters });
            const rows =
              entity === CompanyEntity
                ? [
                    {
                      id: 'company',
                      nameKo: '엔비디아',
                      nameEn: 'NVIDIA',
                      market: 'NASDAQ',
                      ticker: 'NVDA',
                      stockCode: null,
                    },
                  ]
                : entity === FilingEntity
                  ? [
                      {
                        id: 'filing',
                        companyId: 'company',
                        companyName: '기업',
                        reportName: '공시 제목',
                        source: 'OPENDART',
                        rceptNo: '20260904000001',
                        rceptDate: '2026-09-04',
                        detailType: 'D002',
                        firstObservedAt: now,
                        rawListJson: { private: true },
                      },
                    ]
                  : sql.includes("= 'SEC'")
                    ? [
                        {
                          ...news,
                          id: 'sec',
                          source: 'SEC',
                          sourceName: 'SEC EDGAR',
                          rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
                          url: 'https://www.sec.gov/Archives/example.htm',
                          publishedAt: null,
                          rceptDate: '2026-09-03',
                        },
                      ]
                    : [
                        news,
                        { ...news, id: 'legacy-naver', source: 'NAVER' },
                        { ...news, id: 'restricted', rightsMode: RightsMode.NO_REDISTRIBUTION },
                        { ...news, id: 'unsafe', url: 'javascript:alert(1)' },
                      ];
            return rows as T[];
          };
          return query;
        },
      };
    },
  } as unknown as DataSource;
  const service = new SearchService(
    loadAppConfig({ NODE_ENV: 'test' }),
    { requireDataSource: () => source } as DatabaseRuntimeService,
    new FixtureStoreService(),
  );
  const q = "NVDA%' OR 1=1 --_!";
  const result = await service.search({ q, limit: 5 });
  assert.equal(captured.length, 4);
  for (const query of captured) {
    assert.ok(!query.sql.includes(q));
    assert.ok(query.parameters.includes(searchPattern(q)));
    assert.match(query.sql, /LIMIT 6$/u);
    assert.ok(!query.sql.includes('raw_object_uri'));
    assert.ok(!query.sql.includes('raw_list_json'));
    if (query.sql.includes('FROM `filings`')) {
      assert.match(
        query.sql,
        /COALESCE\(`filing`\.`canonical_type`, `filing`\.`detail_type`\) AS detailType/u,
      );
      assert.match(
        query.sql,
        /canonical_type` IS NULL OR `filing`\.`canonical_type` IN \('D001','D002','D005'\)/u,
      );
      assert.ok(query.sql.indexOf('canonical_type` IN') < query.sql.indexOf('ORDER BY'));
    }
    if (query.sql.includes('source_items')) {
      assert.match(query.sql, /translation_json/u);
      assert.match(query.sql, /\$\.inputHash/u);
      assert.match(query.sql, /BINARY 'COMPLETED'/u);
      assert.match(query.sql, /'GDELT', 'IR'/u);
      assert.match(query.sql, /source_policy_json/u);
      assert.match(query.sql, /LIKE \? ESCAPE '!'/u);
    }
  }
  assert.equal(result.news.length, 1);
  assert.equal(result.news[0]?.source, 'IR');
  assert.equal(result.news[0]?.rightsMode, RightsMode.STORE_METADATA_ONLY);
  assert.equal(result.news[0]?.title, '보존된 제목');
  assert.equal(result.news[0]?.translation?.title, '별도로 번역한 제목');
  assert.equal(result.news[0]?.translation?.description, null);
  assert.equal(result.filings.length, 2);
  const sec = result.filings.find((item) => item.source === 'SEC');
  assert.equal(sec?.rceptDate, '2026-09-03');
  assert.equal(sec?.publishedAt, null);
  assert.equal(sec?.firstObservedAt, now.toISOString());
  assert.equal(sec?.translation, null);
  for (const item of [...result.news, ...result.filings]) {
    assert.ok(!('description' in item));
    assert.ok(!('rawMetadataJson' in item));
    assert.ok(!('rawObjectUri' in item));
    assert.ok(!('rawListJson' in item));
    assert.ok(!('rawHash' in item));
    assert.ok(!('translationJson' in item));
    assert.ok(!item.translation || !('prompt' in item.translation));
  }
});

test('실제 검색 컨트롤러는 승인 VIEWER만 읽을 수 있고 비로그인·승인 대기·거절은 차단한다', async () => {
  let status: 'APPROVED' | 'PENDING' | 'REJECTED' = 'APPROVED';
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => ({ id: 'admin' }) } as unknown as AuthService,
    { getMember: async () => ({ role: 'VIEWER', status }) } as unknown as MemberService,
  );
  const context = (identity: Record<string, string> = {}) =>
    ({
      getClass: () => SearchController,
      getHandler: () => SearchController.prototype.search,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          session: { ...identity, sessionStartedAt: new Date().toISOString() },
        }),
      }),
    }) as unknown as ExecutionContext;
  assert.equal(await guard.canActivate(context({ memberId: 'member' })), true);
  assert.equal(await guard.canActivate(context({ adminId: 'admin' })), true);
  await assert.rejects(
    () => guard.canActivate(context()),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 401,
  );
  for (const nextStatus of ['PENDING', 'REJECTED'] as const) {
    status = nextStatus;
    await assert.rejects(
      () => guard.canActivate(context({ memberId: 'member' })),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
    );
  }
});
