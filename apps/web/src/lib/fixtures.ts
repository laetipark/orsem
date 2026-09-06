import { companyMembershipFixture, fixtureGroups } from './company-membership-fixtures';
import { watchlistWorkspaceFixture } from './watchlist-workspace-fixtures';
import {
  marketFixtures,
  marketFixtureTime,
  marketHistoryFixture,
  watchlistQuoteFixtures,
} from './market-fixtures';
import type {
  CompanyDetail,
  CompanySummary,
  CompanyTimeline,
  CursorPage,
  DashboardData,
  EventDetail,
  EventSummary,
  OperationRun,
  Priority,
  PricePoint,
  QueueMetric,
  ReviewItem,
  ReviewResolution,
  Session,
  SourceFreshness,
  WatchlistItem,
  SearchItem,
  NotificationSettings,
  NotificationPreferences,
  NewsDetail,
  SourceItem,
} from '../types';

const now = '2026-09-03T08:42:00.000Z';

const eventSeeds: EventSummary[] = [
  {
    id: 'evt-samsung-d002-01',
    companyId: 'company-samsung',
    companyName: '삼성전자',
    stockCode: '005930',
    market: 'KOSPI',
    priority: 'P1',
    detailType: 'D002',
    title: '임원·주요주주 특정증권등 소유상황보고서',
    summary: '대표이사가 장내에서 보통주 10,000주를 취득한 사실이 원문에서 확인되었습니다.',
    nature: 'MARKET_BUY',
    direction: 'INCREASE',
    eventAt: '2026-09-01',
    rceptDate: '2026-09-03',
    publishedAt: null,
    firstObservedAt: '2026-09-03T06:12:18.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000001',
  },
  {
    id: 'evt-rainbow-d005-01',
    companyId: 'company-rainbow',
    companyName: '레인보우로보틱스',
    stockCode: '277810',
    market: 'KOSDAQ',
    priority: 'P1',
    detailType: 'D005',
    title: '임원·주요주주 거래계획보고서',
    summary: '최대주주 관계인의 향후 거래계획입니다. 실제 체결 여부는 후속 공시 확인이 필요합니다.',
    nature: 'UNKNOWN',
    direction: 'UNKNOWN',
    eventAt: '2026-09-11',
    rceptDate: '2026-09-03',
    publishedAt: null,
    firstObservedAt: '2026-09-03T05:21:07.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000002',
  },
  {
    id: 'evt-hynix-d001-01',
    companyId: 'company-hynix',
    companyName: 'SK하이닉스',
    stockCode: '000660',
    market: 'KOSPI',
    priority: 'P2',
    detailType: 'D001',
    title: '주식등의 대량보유상황보고서',
    summary: '5% 이상 보유자의 보유 비율 변동이 보고되었습니다. 경영 참여 목적 변경은 없습니다.',
    nature: null,
    direction: 'DECREASE',
    eventAt: '2026-09-02',
    rceptDate: '2026-09-03',
    publishedAt: null,
    firstObservedAt: '2026-09-03T04:35:44.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000003',
  },
  {
    id: 'evt-naver-d002-02',
    companyId: 'company-naver',
    companyName: 'NAVER',
    stockCode: '035420',
    market: 'KOSPI',
    priority: 'P2',
    detailType: 'D002',
    title: '[정정] 임원·주요주주 특정증권등 소유상황보고서',
    summary: '보유 증가는 주식매수선택권 행사로 분류되었습니다. 시장 매수는 아닙니다.',
    nature: 'OPTION_EXERCISE',
    direction: 'INCREASE',
    eventAt: '2026-08-29',
    rceptDate: '2026-09-03',
    publishedAt: null,
    firstObservedAt: '2026-09-03T02:10:56.000Z',
    submissionKind: 'CORRECTION',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000004',
  },
  {
    id: 'evt-naver-d003-01',
    companyId: 'company-naver',
    companyName: 'NAVER',
    stockCode: '035420',
    market: 'KOSPI',
    priority: 'P3',
    detailType: 'D003',
    title: '의결권대리행사권유참고서류',
    summary: '정기주주총회 의결권 대리행사 권유의 일정과 안건이 원문 대조 후 확인되었습니다.',
    nature: null,
    direction: 'NEUTRAL',
    eventAt: null,
    rceptDate: '2026-09-02',
    publishedAt: null,
    firstObservedAt: '2026-09-02T05:00:00.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260902000005',
  },
  {
    id: 'evt-samsung-d004-01',
    companyId: 'company-samsung',
    companyName: '삼성전자',
    stockCode: '005930',
    market: 'KOSPI',
    priority: 'P3',
    detailType: 'D004',
    title: '공개매수결과보고서',
    summary: '공개매수 응모 수량과 실제 취득 수량이 원문 대조 후 확인되었습니다.',
    nature: null,
    direction: 'NEUTRAL',
    eventAt: null,
    rceptDate: '2026-09-01',
    publishedAt: null,
    firstObservedAt: '2026-09-01T08:00:00.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260901000006',
  },
  {
    id: 'evt-msft-sec-01',
    companyId: 'company-msft',
    companyName: 'Microsoft',
    stockCode: null,
    market: 'NASDAQ',
    priority: 'P1',
    detailType: 'SEC',
    title: 'Form 8-K',
    summary: '기업 IR과 SEC 원문이 연결된 해외 공시입니다. 핵심 숫자는 원문 검증을 완료했습니다.',
    nature: null,
    direction: 'NEUTRAL',
    eventAt: '2026-09-02',
    rceptDate: null,
    publishedAt: '2026-09-02T22:31:00.000Z',
    firstObservedAt: '2026-09-02T22:32:05.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'SEC EDGAR',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://www.sec.gov/edgar/search/',
  },
  {
    id: 'evt-kosdaq-news-01',
    companyId: 'company-rainbow',
    companyName: '레인보우로보틱스',
    stockCode: '277810',
    market: 'KOSDAQ',
    priority: 'P3',
    detailType: 'NEWS',
    title: '산업용 로봇 공급계약 관련 기사 후보',
    summary: '뉴스 후보가 발견되었으며 계약 금액은 공식 공시와 교차확인 대기 중입니다.',
    nature: null,
    direction: 'NEUTRAL',
    eventAt: null,
    rceptDate: null,
    publishedAt: '2026-09-03T01:05:00.000Z',
    firstObservedAt: '2026-09-03T01:06:12.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'UNVERIFIED',
    classificationStatus: 'REVIEW_REQUIRED',
    sourceName: 'NAVER 뉴스검색',
    rightsMode: 'STORE_METADATA_ONLY',
    officialUrl: 'https://search.naver.com/search.naver?where=news',
  },
  {
    id: 'evt-msft-news-translation-01',
    companyId: 'company-msft',
    companyName: 'Microsoft',
    stockCode: null,
    ticker: 'MSFT',
    market: 'NASDAQ',
    priority: 'P1',
    detailType: 'NEWS',
    title: 'Fixture news: Microsoft publishes a cloud business update',
    summary: 'This is sample metadata for testing the translation display.',
    translation: {
      language: 'ko',
      title: '예시 뉴스: 마이크로소프트, 클라우드 사업 현황 발표',
      description: '자동 번역 표시를 검증하기 위한 예시 메타데이터입니다.',
      translatedAt: '2026-09-03T01:07:00.000Z',
      provider: 'LOCAL',
      model: 'fixture',
    },
    nature: null,
    direction: 'NEUTRAL',
    eventAt: null,
    rceptDate: null,
    publishedAt: '2026-09-03T01:05:00.000Z',
    firstObservedAt: '2026-09-03T01:06:12.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'UNVERIFIED',
    classificationStatus: 'REVIEW_REQUIRED',
    sourceName: 'Microsoft IR · 예시',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://www.microsoft.com/en-us/investor',
  },
];

interface FixtureNewsSeed {
  companyId: string | null;
  item: SourceItem;
}

const fixtureNewsSeeds: FixtureNewsSeed[] = [
  {
    companyId: 'company-samsung',
    item: {
      id: 'fixture-news-samsung-global-01',
      articleId: 'fixture-article-samsung-global-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: 'en',
      translated: true,
      sourceKind: 'COMPANY_IR',
      publisherId: 'samsung-global-newsroom',
      marketRegion: 'global',
      sources: [
        {
          id: 'fixture-news-samsung-global-01',
          source: 'IR',
          sourceName: 'Samsung Global Newsroom · 개발 표본',
          url: 'https://example.test/orsem/news/samsung-global-01',
        },
      ],
      source: 'IR',
      externalId: 'fixture-samsung-global-01',
      url: 'https://example.test/orsem/news/samsung-global-01',
      title: '[Development fixture] Samsung announces a semiconductor update',
      description: 'This is a deterministic provider summary for the external news link.',
      translation: {
        language: 'ko',
        title: '[개발 표본] 삼성전자, 반도체 사업 현황 발표',
        description: '제목과 제공 요약, 원문 링크를 검증하기 위한 고정 표본입니다.',
        translatedAt: '2026-09-03T08:37:00.000Z',
        provider: 'LOCAL',
        model: 'fixture',
      },
      sourceName: 'Samsung Global Newsroom · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T08:35:00.000Z',
      firstObservedAt: '2026-09-03T08:36:00.000Z',
      processedAt: '2026-09-03T08:37:00.000Z',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      provenanceUrl: 'https://example.test/orsem/news/samsung-global-01',
      tickers: ['005930'],
      tags: ['개발 fixture', '반도체'],
    },
  },
  {
    companyId: null,
    item: {
      id: 'fixture-news-fed-release-01',
      articleId: 'fixture-article-fed-release-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: 'en',
      translated: true,
      sourceKind: 'OFFICIAL_RELEASE',
      publisherId: 'federal-reserve',
      marketRegion: 'us',
      sources: [
        {
          id: 'fixture-news-fed-release-01',
          source: 'NEWS_RSS',
          sourceName: 'Federal Reserve · 개발 표본',
          url: 'https://example.test/orsem/news/fed-release-01',
        },
      ],
      source: 'NEWS_RSS',
      externalId: 'fixture-fed-release-01',
      url: 'https://example.test/orsem/news/fed-release-01',
      title: '[개발 표본] Federal Reserve policy release',
      description: '개발 화면 검증을 위한 가상의 공식 기관 발표 메타데이터입니다.',
      translation: {
        language: 'ko',
        title: '[개발 표본] 연방준비제도 정책 발표',
        description: '개발 화면 검증을 위한 공식 기관 발표 표본입니다.',
        translatedAt: '2026-09-03T08:27:00.000Z',
        provider: 'LOCAL',
        model: 'fixture',
      },
      sourceName: 'Federal Reserve · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T08:25:00.000Z',
      firstObservedAt: '2026-09-03T08:26:00.000Z',
      processedAt: '2026-09-03T08:27:00.000Z',
      rightsMode: 'OFFICIAL_PUBLIC_DATA',
      provenanceUrl: 'https://example.test/orsem/news/fed-release-01',
      tickers: [],
      tags: ['개발 fixture', '통화정책'],
    },
  },
  {
    companyId: 'company-msft',
    item: {
      id: 'fixture-news-msft-ir-01',
      articleId: 'fixture-article-msft-ir-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
      sourceKind: 'COMPANY_IR',
      publisherId: 'microsoft-ir-fixture',
      marketRegion: 'us',
      sources: [
        {
          id: 'fixture-news-msft-ir-01',
          source: 'IR',
          sourceName: 'Microsoft IR · 개발 표본',
          url: 'https://example.test/orsem/news/msft-ir-01',
        },
      ],
      source: 'IR',
      externalId: 'fixture-msft-ir-01',
      url: 'https://example.test/orsem/news/msft-ir-01',
      title: '[Development fixture] Microsoft publishes a cloud business update',
      description: 'This is deterministic test metadata, not a real company announcement.',
      translation: {
        language: 'ko',
        title: '[개발 표본] 마이크로소프트, 클라우드 사업 현황 발표',
        description: '개발 화면의 번역 표시를 검증하기 위한 가상 메타데이터입니다.',
        translatedAt: '2026-09-03T08:17:00.000Z',
        provider: 'LOCAL',
        model: 'fixture',
      },
      sourceName: 'Microsoft IR · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T08:15:00.000Z',
      firstObservedAt: '2026-09-03T08:16:00.000Z',
      processedAt: '2026-09-03T08:17:00.000Z',
      rightsMode: 'OFFICIAL_PUBLIC_DATA',
      provenanceUrl: 'https://example.test/orsem/news/msft-ir-01',
      tickers: ['MSFT'],
      tags: ['개발 fixture', '클라우드'],
    },
  },
  {
    companyId: 'company-rainbow',
    item: {
      id: 'fixture-news-opendart-01',
      articleId: null,
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
      sourceKind: 'OFFICIAL_DISCLOSURE',
      publisherId: 'opendart-fixture',
      marketRegion: 'kr',
      sources: [
        {
          id: 'fixture-news-opendart-01',
          source: 'OPENDART',
          sourceName: 'OpenDART · 개발 표본',
          url: 'https://example.test/orsem/news/opendart-01',
        },
      ],
      source: 'OPENDART',
      externalId: 'fixture-opendart-01',
      url: 'https://example.test/orsem/news/opendart-01',
      title: '[개발 표본] 코스닥 기업 공시 접수 알림',
      description: '실제 공시가 아닌 개발 화면 검증용 메타데이터입니다.',
      translation: null,
      sourceName: 'OpenDART · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T08:05:00.000Z',
      firstObservedAt: '2026-09-03T08:06:00.000Z',
      processedAt: '2026-09-03T08:07:00.000Z',
      rightsMode: 'OFFICIAL_PUBLIC_DATA',
      provenanceUrl: 'https://example.test/orsem/news/opendart-01',
      tickers: ['277810'],
      tags: ['개발 fixture', '공시'],
    },
  },
  {
    companyId: null,
    item: {
      id: 'fixture-news-bls-release-01',
      articleId: 'fixture-article-bls-release-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: 'en',
      translated: true,
      sourceKind: 'OFFICIAL_RELEASE',
      publisherId: 'bls',
      marketRegion: 'us',
      sources: [
        {
          id: 'fixture-news-bls-release-01',
          source: 'NEWS_RSS',
          sourceName: 'Bureau of Labor Statistics · 개발 표본',
          url: 'https://example.test/orsem/news/bls-release-01',
        },
      ],
      source: 'NEWS_RSS',
      externalId: 'fixture-bls-release-01',
      url: 'https://example.test/orsem/news/bls-release-01',
      title: '[개발 표본] U.S. labor statistics release',
      description: '개발 화면 검증을 위한 가상의 통계 발표 메타데이터입니다.',
      translation: {
        language: 'ko',
        title: '[개발 표본] 미국 노동통계 발표',
        description: '개발 화면 검증을 위한 노동통계 발표 표본입니다.',
        translatedAt: '2026-09-03T07:57:00.000Z',
        provider: 'LOCAL',
        model: 'fixture',
      },
      sourceName: 'Bureau of Labor Statistics · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T07:55:00.000Z',
      firstObservedAt: '2026-09-03T07:56:00.000Z',
      processedAt: '2026-09-03T07:57:00.000Z',
      rightsMode: 'OFFICIAL_PUBLIC_DATA',
      provenanceUrl: 'https://example.test/orsem/news/bls-release-01',
      tickers: [],
      tags: ['개발 fixture', '고용'],
    },
  },
  {
    companyId: null,
    item: {
      id: 'fixture-news-global-release-01',
      articleId: 'fixture-article-global-release-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
      sourceKind: 'PRESS_RELEASE',
      publisherId: 'fixture-global',
      marketRegion: 'global',
      sources: [
        {
          id: 'fixture-news-global-release-01',
          source: 'NEWS_RSS',
          sourceName: 'Global Fixture Wire',
          url: 'https://example.test/orsem/news/global-release-01',
        },
      ],
      source: 'NEWS_RSS',
      externalId: 'fixture-global-release-01',
      url: 'https://example.test/orsem/news/global-release-01',
      title: '[개발 표본] 글로벌 원자재 시장 보도자료',
      description: null,
      translation: null,
      sourceName: 'Global Fixture Wire',
      author: null,
      publishedAt: '2026-09-03T07:45:00.000Z',
      firstObservedAt: '2026-09-03T07:46:00.000Z',
      processedAt: '2026-09-03T07:47:00.000Z',
      rightsMode: 'LINK_ONLY',
      provenanceUrl: 'https://example.test/orsem/news/global-release-01',
      tickers: [],
      tags: ['개발 fixture', '원자재'],
    },
  },
  {
    companyId: 'company-hynix',
    item: {
      id: 'fixture-news-etoday-finance-01',
      articleId: 'fixture-article-memory-01',
      sourceCount: 1,
      contentState: 'UNAVAILABLE',
      contentSourceId: null,
      contentLanguage: null,
      translated: false,
      sourceKind: 'INDEPENDENT_MEDIA',
      publisherId: 'etoday',
      marketRegion: 'kr',
      sources: [
        {
          id: 'fixture-news-etoday-finance-01',
          source: 'NEWS_RSS',
          sourceName: '이투데이 · 개발 표본',
          url: 'https://example.test/orsem/news/memory-01',
        },
      ],
      source: 'NEWS_RSS',
      externalId: 'fixture-etoday-finance-01',
      url: 'https://example.test/orsem/news/memory-01',
      title: '[개발 표본] 메모리 업종 금융시장 동향',
      description: null,
      translation: null,
      sourceName: '이투데이 · 개발 표본',
      author: null,
      publishedAt: '2026-09-03T07:35:00.000Z',
      firstObservedAt: '2026-09-03T07:36:00.000Z',
      processedAt: '2026-09-03T07:37:00.000Z',
      rightsMode: 'STORE_METADATA_ONLY',
      provenanceUrl: 'https://example.test/orsem/news/memory-01',
      tickers: ['000660'],
      tags: ['개발 fixture', '메모리'],
    },
  },
];

const details = new Map<string, EventDetail>();

for (const event of eventSeeds) {
  details.set(event.id, {
    ...event,
    filerName: event.detailType === 'SEC' ? 'Microsoft Corporation' : event.companyName,
    reporterName:
      event.detailType === 'D002'
        ? event.companyId === 'company-samsung'
          ? '홍길동'
          : '김임원'
        : null,
    relationship: event.detailType === 'D002' ? '등기임원' : null,
    position: event.detailType === 'D002' ? '대표이사' : null,
    ownershipBefore: event.detailType === 'D002' ? '110000' : null,
    ownershipAfter: event.detailType === 'D002' ? '120000' : null,
    ownershipChange: event.detailType === 'D002' ? '10000' : null,
    ownershipRateAfter: event.detailType === 'D002' ? '0.02' : null,
    parserVersion: event.detailType.startsWith('D') ? 'dart-parser@0.1.0' : null,
    largeHolding:
      event.detailType === 'D001'
        ? {
            reporterName: '예시 대량보유자',
            reportReasonRaw: '주요 계약 변경',
            holdingPurposeRaw: '단순 투자',
            reportReasonKind: 'CONTRACT_CHANGE',
            sharesBefore: '12000000',
            sharesAfter: '12000000',
            ownershipRateBefore: '5.10',
            ownershipRateAfter: '5.10',
            changes: [],
          }
        : null,
    proxySolicitation:
      event.detailType === 'D003'
        ? {
            solicitorName: 'NAVER 이사회',
            targetCompanyName: 'NAVER',
            relationshipRaw: '회사',
            meetingDate: '2026-09-30',
            meetingTimeRaw: '오전 9시',
            meetingAt: null,
            meetingLocation: '경기도 성남시',
            solicitationStartDate: '2026-09-10',
            solicitationEndDate: '2026-09-29',
            purposeRaw: '정기주주총회 의결권 확보',
            electronicVoting: true,
            agendas: [
              { ordinal: 1, title: '재무제표 승인' },
              { ordinal: 2, title: '이사 선임' },
            ],
          }
        : null,
    tenderOffer:
      event.detailType === 'D004'
        ? {
            documentKind: 'RESULT',
            offerorName: '예시 공개매수자',
            targetCompanyName: '삼성전자',
            purposeRaw: '지분 취득',
            conditionsRaw: '공개매수 조건 충족 시 결제',
            subscriptionStartDate: '2026-08-01',
            subscriptionEndDate: '2026-08-31',
            settlementDate: '2026-09-03',
            securities: [
              {
                rowIndex: 0,
                securityTypeRaw: '보통주',
                unitPrice: '75000',
                currency: 'KRW',
                minQuantity: null,
                maxQuantity: '1000000',
                heldQuantity: '100000',
                expectedHoldingsMin: null,
                expectedHoldingsMax: '1100000',
                offeredQuantity: '900000',
                acquiredQuantity: '850000',
                actualAmount: '63750000000',
              },
            ],
          }
        : null,
    tradePlan:
      event.detailType === 'D005'
        ? {
            plannedStartDate: '2026-09-11',
            plannedEndDate: '2026-10-10',
            plannedQuantity: '1500',
            plannedAmount: '480000000',
            methodRaw: '장내매도 예정',
            planStatus: 'PLANNED',
          }
        : null,
    transactions:
      event.id === 'evt-samsung-d002-01'
        ? [
            {
              id: 'tx-samsung-01',
              eventDate: '2026-09-01',
              securityTypeRaw: '의결권있는 주식(보통주)',
              methodRaw: '장내매수(+)',
              nature: 'MARKET_BUY',
              direction: 'INCREASE',
              quantity: '10000',
              unitPrice: '72500',
              amount: '725000000',
              currency: 'KRW',
              sharesAfter: '120000',
              parserConfidence: 0.98,
            },
          ]
        : event.id === 'evt-naver-d002-02'
          ? [
              {
                id: 'tx-naver-01',
                eventDate: '2026-08-29',
                securityTypeRaw: '의결권있는 주식(보통주)',
                methodRaw: '주식매수선택권행사(+)',
                nature: 'OPTION_EXERCISE',
                direction: 'INCREASE',
                quantity: '2500',
                unitPrice: '181000',
                amount: '452500000',
                currency: 'KRW',
                sharesAfter: '17420',
                parserConfidence: 0.96,
              },
            ]
          : [],
    evidence: [
      {
        id: `evidence-${event.id}`,
        source:
          event.id === 'evt-msft-news-translation-01'
            ? 'IR'
            : event.detailType === 'SEC'
              ? 'SEC'
              : event.detailType === 'NEWS'
                ? 'NAVER'
                : 'OPENDART',
        sourceName: event.sourceName,
        title: event.title,
        description: event.translation ? event.summary : null,
        translation: event.detailType === 'NEWS' ? (event.translation ?? null) : null,
        url: event.officialUrl,
        publishedAt: event.publishedAt,
        firstObservedAt: event.firstObservedAt,
        grade: event.evidenceGrade,
        rightsMode: event.rightsMode,
        isOfficial: event.rightsMode === 'OFFICIAL_PUBLIC_DATA',
        excerpt:
          event.detailType === 'NEWS'
            ? event.translation
              ? '번역 전 원문 제목과 허용된 요약을 보존합니다. 자동 번역은 원문과 함께 확인하세요.'
              : '제목과 링크만 보존합니다. 기사 본문 및 숫자는 공식 원문 확인 전 인용하지 않습니다.'
            : '공식 원문에서 추출한 구조화 데이터와 원본 필드를 함께 보존합니다.',
      },
    ],
    lineage:
      event.submissionKind === 'CORRECTION'
        ? [
            {
              id: 'evt-naver-d002-01',
              label: '최초 공시',
              submissionKind: 'INITIAL',
              effectiveState: 'SUPERSEDED',
              rceptDate: '2026-09-01',
              publishedAt: null,
            },
            {
              id: event.id,
              label: '정정 공시',
              submissionKind: 'CORRECTION',
              effectiveState: 'ACTIVE',
              rceptDate: event.rceptDate,
              publishedAt: event.publishedAt,
            },
          ]
        : [
            {
              id: event.id,
              label: '최초 공시',
              submissionKind: event.submissionKind,
              effectiveState: event.effectiveState,
              rceptDate: event.rceptDate,
              publishedAt: event.publishedAt,
            },
          ],
    limitations: [
      event.detailType === 'D005'
        ? '거래계획은 실제 체결을 의미하지 않으며 D002 등 후속 공시 확인이 필요합니다.'
        : '공시 제출일과 실제 사건 발생일은 다를 수 있습니다.',
      '이 정보는 소유·지배구조 관측 자료이며 자동 매수·매도 추천이 아닙니다.',
    ],
  });
}

const sources: SourceFreshness[] = [
  {
    id: 'opendart',
    name: 'OpenDART',
    category: 'OFFICIAL',
    status: 'HEALTHY',
    lastSuccessAt: '2026-09-03T08:41:16.000Z',
    lagSeconds: 44,
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    message: 'D001~D005 폴링 정상',
  },
  {
    id: 'sec',
    name: 'SEC EDGAR',
    category: 'OFFICIAL',
    status: 'HEALTHY',
    lastSuccessAt: '2026-09-03T08:39:10.000Z',
    lagSeconds: 170,
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    message: 'User-Agent 및 10 req/s 제한 준수',
  },
  {
    id: 'naver',
    name: 'NAVER 뉴스검색',
    category: 'NEWS',
    status: 'DEGRADED',
    lastSuccessAt: '2026-09-03T08:31:00.000Z',
    lagSeconds: 660,
    rightsMode: 'STORE_METADATA_ONLY',
    message: '후보 링크만 저장 · 원문 확인 큐 지연',
  },
];

const companies: CompanyDetail[] = [
  {
    id: 'company-samsung',
    nameKo: '삼성전자',
    nameEn: 'Samsung Electronics',
    stockCode: '005930',
    ticker: null,
    market: 'KOSPI',
    sector: '반도체·전자',
    priority: 'P1',
    isListed: true,
    isWatchlisted: false,
    lastEventAt: '2026-09-03T06:12:18.000Z',
    corpCode: '00126380',
    cik: null,
    thesis: '공식 공시 중심으로 경영진 이해관계와 반도체 업황을 분리해 관측합니다.',
    tags: ['반도체', '대형주', 'P1'],
    recentEvents: eventSeeds.filter((event) => event.companyId === 'company-samsung'),
    provenance: [
      {
        id: 'company-source-samsung',
        source: 'OPENDART',
        sourceName: 'OpenDART 기업개황',
        title: '삼성전자 기업 고유번호 매핑',
        url: 'https://opendart.fss.or.kr/',
        publishedAt: null,
        firstObservedAt: '2026-09-01T00:10:00.000Z',
        grade: 'A',
        rightsMode: 'OFFICIAL_PUBLIC_DATA',
        isOfficial: true,
      },
    ],
  },
  {
    id: 'company-rainbow',
    nameKo: '레인보우로보틱스',
    nameEn: 'Rainbow Robotics',
    stockCode: '277810',
    ticker: null,
    market: 'KOSDAQ',
    sector: '로봇',
    priority: 'P1',
    isListed: true,
    isWatchlisted: false,
    lastEventAt: '2026-09-03T05:21:07.000Z',
    corpCode: '01259348',
    cik: null,
    thesis: null,
    tags: ['로봇', '전략산업'],
    recentEvents: eventSeeds.filter((event) => event.companyId === 'company-rainbow'),
    provenance: [],
  },
  {
    id: 'company-hynix',
    nameKo: 'SK하이닉스',
    nameEn: 'SK hynix',
    stockCode: '000660',
    ticker: null,
    market: 'KOSPI',
    sector: '반도체',
    priority: 'P2',
    isListed: true,
    isWatchlisted: false,
    lastEventAt: '2026-09-03T04:35:44.000Z',
    corpCode: '00164779',
    cik: null,
    thesis: null,
    tags: ['HBM', '반도체'],
    recentEvents: eventSeeds.filter((event) => event.companyId === 'company-hynix'),
    provenance: [],
  },
  {
    id: 'company-naver',
    nameKo: 'NAVER',
    nameEn: 'NAVER Corporation',
    stockCode: '035420',
    ticker: null,
    market: 'KOSPI',
    sector: '인터넷',
    priority: 'P2',
    isListed: true,
    isWatchlisted: false,
    lastEventAt: '2026-09-03T02:10:56.000Z',
    corpCode: '00266961',
    cik: null,
    thesis: null,
    tags: ['플랫폼', 'AI'],
    recentEvents: eventSeeds.filter((event) => event.companyId === 'company-naver'),
    provenance: [],
  },
  {
    id: 'company-msft',
    nameKo: 'Microsoft',
    nameEn: 'Microsoft Corporation',
    stockCode: null,
    ticker: 'MSFT',
    market: 'NASDAQ',
    sector: '소프트웨어·AI',
    priority: 'P1',
    isListed: true,
    isWatchlisted: false,
    lastEventAt: '2026-09-02T22:31:00.000Z',
    corpCode: null,
    cik: '0000789019',
    thesis: null,
    tags: ['AI', '클라우드'],
    recentEvents: eventSeeds.filter((event) => event.companyId === 'company-msft'),
    provenance: [],
  },
];

const fixturePriceDisclosure = '개발용 모의 데이터 · 실제 시세 아님';

// 결과가 고정된 개발용 테스트 데이터만 사용하며, 현재 시각이나 무작위·실시간 가격은 사용하지 않습니다.
function fixturePrices(
  companyId: string,
  interval: '1d' | '1m',
  currency: 'KRW' | 'USD',
): PricePoint[] {
  const minute = interval === '1m';
  const dailyDates: string[] = [];
  const date = new Date('2026-09-02T00:00:00.000Z');
  while (dailyDates.length < 180) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      dailyDates.unshift(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
  }
  const minuteStart = Date.parse(
    currency === 'KRW' ? '2026-09-03T00:00:00.000Z' : '2026-09-02T13:30:00.000Z',
  );
  const domesticBases: Record<string, number> = {
    'company-samsung': 73_000,
    'company-rainbow': 320_000,
    'company-hynix': 245_000,
    'company-naver': 214_000,
  };
  const base = currency === 'USD' ? 420 : (domesticBases[companyId] ?? 73_000);
  const round = (value: number) =>
    currency === 'USD' ? Number(value.toFixed(2)) : Math.round(value / 100) * 100;
  const level = (index: number) =>
    base *
    (1 + index * (minute ? 0.00006 : 0.0007) + Math.sin(index / 6) * (minute ? 0.007 : 0.03));
  return Array.from({ length: 180 }, (_, index) => {
    const time = minute ? new Date(minuteStart + index * 60_000).toISOString() : dailyDates[index]!;
    const open = round(level(index - 1));
    const close = round(level(index));
    const spread = base * (minute ? 0.0018 : 0.007);
    return {
      time,
      sessionDate: minute ? (currency === 'KRW' ? '2026-09-03' : '2026-09-02') : time,
      observedAt: now,
      open,
      high: round(Math.max(open, close) + spread),
      low: round(Math.min(open, close) - spread),
      close,
      volume: Math.round(
        (currency === 'USD' ? 100_000 : 8_000_000) * (minute ? 0.01 : 1) * (1 + (index % 13) / 10),
      ),
      source: 'FIXTURE',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
    };
  });
}

const timeline: CompanyTimeline = {
  companyId: 'company-samsung',
  currency: 'KRW',
  prices: fixturePrices('company-samsung', '1d', 'KRW'),
  priceSources: [
    {
      source: 'FIXTURE',
      sourceName: '개발용 모의 시세',
      rightsMode: 'PRIVATE_DISPLAY_ONLY',
      feed: '고정 모의 OHLCV',
      adjustment: null,
      attribution: fixturePriceDisclosure,
      limitation: `${fixturePriceDisclosure}. 차트 가독성·범례·보조지표 확인을 위한 고정 표본이며 투자 판단에 사용할 수 없습니다.`,
    },
  ],
  markers: [
    {
      time: '2026-08-26',
      kind: 'NEWS',
      eventId: 'news-samsung-01',
      label: 'N · 공식 IR 확인',
      detailType: 'NEWS',
      returnWindows: { pre1d: 1.08, post1d: 0.54, post5d: 2.21, post20d: null },
    },
    {
      time: '2026-09-01',
      kind: 'TRADE',
      eventId: 'evt-samsung-d002-01',
      label: 'T · 거래일',
      detailType: 'D002',
      returnWindows: { pre1d: 1.21, post1d: 0.67, post5d: null, post20d: null },
    },
    {
      time: '2026-09-02',
      kind: 'FILING',
      eventId: 'evt-samsung-d002-01',
      label: 'F · 공시',
      detailType: 'D002',
      returnWindows: { pre1d: 0.67, post1d: null, post5d: null, post20d: null },
    },
  ],
  returns: { oneDay: 0.66, oneMonth: 4.87, sinceLatestEvent: 0.67, benchmarkOneMonth: 1.82 },
  latestCloseAt: '2026-09-02',
};

let watchlist: WatchlistItem[] = [];
let reviews: ReviewItem[] = [
  {
    id: 'review-001',
    eventId: 'evt-kosdaq-news-01',
    companyName: '레인보우로보틱스',
    detailType: 'NEWS',
    reason: '기사의 계약 금액과 공식 공시 연결을 확인하지 못했습니다.',
    methodRaw: null,
    extractedText: '공급계약 체결… 구체적인 금액은 기사 본문 참조',
    proposedNature: 'UNKNOWN',
    parserConfidence: 0.34,
    createdAt: '2026-09-03T01:06:40.000Z',
    status: 'OPEN',
  },
  {
    id: 'review-002',
    eventId: 'evt-naver-d002-02',
    companyName: 'NAVER',
    detailType: 'D002',
    reason: 'D005 거래계획과 D002 실행 공시 후보가 두 건이라 사람이 연결을 확정해야 합니다.',
    methodRaw: '장내매수(+)',
    extractedText: '변동사유: 유가증권시장 장내매수',
    proposedNature: 'MARKET_BUY',
    parserConfidence: 0.71,
    createdAt: '2026-09-03T02:11:32.000Z',
    status: 'OPEN',
    planExecutionCandidates: [
      {
        matchId: 'match-plan-001',
        transactionId: 'tx-naver-001',
        planItemId: 'plan-naver-001',
        eventDate: '2026-08-31',
        actualQuantity: '1200',
        plannedQuantity: '1200',
        actualMethodRaw: '장내매수',
        plannedMethodRaw: '유가증권시장 장내매수',
        confidence: 0.94,
        matchedFields: ['reporter', 'securityType', 'quantity', 'period'],
      },
      {
        matchId: 'match-plan-002',
        transactionId: 'tx-naver-001',
        planItemId: 'plan-naver-002',
        eventDate: '2026-08-31',
        actualQuantity: '1200',
        plannedQuantity: '1500',
        actualMethodRaw: '장내매수',
        plannedMethodRaw: '장내매수',
        confidence: 0.68,
        matchedFields: ['reporter', 'securityType', 'period'],
      },
    ],
  },
];

const runs: OperationRun[] = [
  {
    id: 'run-001',
    source: 'OpenDART',
    job: 'poll-dart:D002',
    status: 'SUCCEEDED',
    startedAt: '2026-09-03T08:40:58.000Z',
    finishedAt: '2026-09-03T08:41:16.000Z',
    processed: 38,
    failed: 0,
    message: null,
  },
  {
    id: 'run-002',
    source: 'NAVER 뉴스검색',
    job: 'verify-official-source',
    status: 'FAILED',
    startedAt: '2026-09-03T08:30:00.000Z',
    finishedAt: '2026-09-03T08:31:02.000Z',
    processed: 14,
    failed: 2,
    message: '공식 원문 후보 2건을 연결하지 못했습니다.',
  },
  {
    id: 'run-003',
    source: 'SEC EDGAR',
    job: 'fetch-submissions',
    status: 'SUCCEEDED',
    startedAt: '2026-09-03T08:38:40.000Z',
    finishedAt: '2026-09-03T08:39:10.000Z',
    processed: 12,
    failed: 0,
    message: null,
  },
];

const queues: QueueMetric[] = [
  {
    name: 'dart-enrich',
    waiting: 3,
    active: 1,
    delayed: 0,
    failed: 1,
    oldestWaitingAt: '2026-09-03T08:40:20.000Z',
  },
  {
    name: 'official-verify',
    waiting: 14,
    active: 2,
    delayed: 2,
    failed: 2,
    oldestWaitingAt: '2026-09-03T08:21:00.000Z',
  },
  { name: 'alerts', waiting: 0, active: 0, delayed: 0, failed: 1, oldestWaitingAt: null },
];

function dashboard(): DashboardData {
  return {
    asOf: now,
    todayCounts: { D001: 6, D002: 23, D003: 0, D004: 0, D005: 2 },
    totalCounts: { D001: 126, D002: 245, D003: 8, D004: 3, D005: 18 },
    priorities: {
      P1: eventSeeds.filter((event) => event.priority === 'P1').slice(0, 3),
      P2: eventSeeds.filter((event) => event.priority === 'P2').slice(0, 3),
    },
    reviewPending: reviews.filter((review) => review.status === 'OPEN').length,
    parserFailures: 1,
    alertFailures: 1,
    sources,
    recentlyVerified: eventSeeds.filter((event) => event.evidenceGrade === 'A').slice(0, 4),
  };
}

function pageEvents(url: URL): CursorPage<EventSummary> {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const detailType = url.searchParams.get('detailType');
  const priority = url.searchParams.get('priority');
  const classificationStatus = url.searchParams.get('classificationStatus');
  const cursor = Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0;
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20;
  const filtered = eventSeeds.filter(
    (event) =>
      fixtureRegionMatches(event.market, url.searchParams.get('region')) &&
      (!q ||
        `${event.companyName} ${event.stockCode ?? ''} ${event.title} ${event.translation?.title ?? ''}`
          .toLowerCase()
          .includes(q)) &&
      (!detailType || event.detailType === detailType) &&
      (!priority || event.priority === priority) &&
      (!classificationStatus || event.classificationStatus === classificationStatus),
  );
  const items = filtered.slice(cursor, cursor + limit);
  const next = cursor + limit < filtered.length ? String(cursor + limit) : null;
  return { items, nextCursor: next };
}

function fixtureNewsRegionMatches(item: SourceItem, region: string | null): boolean {
  if (!region || region === 'all') return true;
  return item.marketRegion === region || item.marketRegion === 'global';
}

const fixtureNewsPublishers = new Set(['samsung-global-newsroom', 'federal-reserve', 'bls', 'eia']);
function approvedFixtureNews(seed: FixtureNewsSeed): boolean {
  return (
    ['OFFICIAL_RELEASE', 'COMPANY_IR'].includes(seed.item.sourceKind ?? '') &&
    fixtureNewsPublishers.has(seed.item.publisherId ?? '') &&
    ['OFFICIAL_PUBLIC_DATA', 'PRIVATE_DISPLAY_ONLY'].includes(seed.item.rightsMode)
  );
}
function fixtureNewsProjection({ companyId, item }: FixtureNewsSeed): SourceItem {
  const relatedCompanies = companies
    .filter((company) => company.id === companyId)
    .map(({ id, nameKo, nameEn, stockCode, ticker, market }) => ({
      id,
      nameKo,
      nameEn,
      stockCode,
      ticker,
      market,
    }));
  return {
    ...item,
    displayMode: 'EXTERNAL_LINK',
    contentState: 'UNAVAILABLE',
    contentSourceId: null,
    translated: Boolean(item.translation),
    translationStatus: item.translation
      ? 'COMPLETED'
      : item.contentLanguage === 'en'
        ? 'PENDING'
        : 'UNAVAILABLE',
    relatedCompanies,
    summaryLine: item.translation?.description ?? item.description ?? '요약 미제공',
  };
}

function pageNews(url: URL): CursorPage<SourceItem> {
  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const sourceKind = url.searchParams.get('sourceKind');
  const source = url.searchParams.get('source');
  const scope = url.searchParams.get('scope');
  const publisher = url.searchParams.get('publisher');
  const companyId = url.searchParams.get('companyId');
  const cursor = Math.max(0, Number.parseInt(url.searchParams.get('cursor') ?? '0', 10) || 0);
  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20),
  );
  const filtered = fixtureNewsSeeds
    .filter(approvedFixtureNews)
    .filter(() => !url.searchParams.has('asset'))
    .filter((seed) =>
      scope === 'market'
        ? ['federal-reserve', 'bls'].includes(seed.item.publisherId ?? '')
        : scope === 'company'
          ? fixtureNewsProjection(seed).relatedCompanies!.length > 0
          : true,
    )
    .filter(({ item }) => !source || item.source === source)
    .filter(({ item }) => fixtureNewsRegionMatches(item, url.searchParams.get('region')))
    .filter(({ item }) => !sourceKind || item.sourceKind === sourceKind)
    .filter(({ item }) => !publisher || (item.publisherId ?? item.sourceName) === publisher)
    .filter(
      (seed) =>
        !companyId ||
        fixtureNewsProjection(seed).relatedCompanies!.some((company) => company.id === companyId),
    )
    .filter(({ item }) => {
      if (!q) return true;
      return [item.title, item.description, item.translation?.title, item.translation?.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(q));
    })
    .map(fixtureNewsProjection)
    .sort((left, right) =>
      (right.publishedAt ?? right.firstObservedAt).localeCompare(
        left.publishedAt ?? left.firstObservedAt,
      ),
    );
  const items = filtered.slice(cursor, cursor + limit);
  return {
    items,
    nextCursor: cursor + limit < filtered.length ? String(cursor + limit) : null,
  };
}

function fixtureNewsDetail(id: string): NewsDetail {
  const seed = fixtureNewsSeeds.find(
    (seed) => seed.item.id === id || seed.item.articleId === id || seed.item.externalId === id,
  );
  if (!seed || !approvedFixtureNews(seed))
    throw Object.assign(new Error('해당 뉴스 원문 링크를 찾을 수 없습니다.'), { statusCode: 404 });
  return { ...fixtureNewsProjection(seed), content: null };
}

function asSummary(company: CompanyDetail): CompanySummary {
  return {
    id: company.id,
    nameKo: company.nameKo,
    nameEn: company.nameEn,
    stockCode: company.stockCode,
    ticker: company.ticker,
    market: company.market,
    sector: company.sector,
    priority: company.priority,
    isListed: company.isListed,
    isWatchlisted: company.isWatchlisted,
    lastEventAt: company.lastEventAt,
  };
}

function asWatchlistItem(company: CompanyDetail): WatchlistItem {
  return {
    ...asSummary(company),
    isWatchlisted: true,
    addedAt: now,
    note: null,
    realtimeAlerts: true,
    digestAlerts: false,
  };
}

let fixtureNotificationSettings: NotificationSettings = {
  enabled: false,
  topics: ['FILINGS', 'ANALYSIS', 'CORRECTIONS', 'NEWS'],
  filingTypes: ['D001', 'D002', 'D005'],
  watchlistOnly: true,
  pushConfigured: false,
  publicKey: null,
  subscriptions: [],
};

let fixtureAuthenticated = true;

function fixtureRegionMatches(market: string, region: string | null) {
  if (!region || region === 'all') return true;
  return region === 'kr'
    ? ['KOSPI', 'KOSDAQ', 'KONEX'].includes(market)
    : ['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA'].includes(market);
}

export async function fixtureRequest<T>(path: string, init?: RequestInit): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 80));
  const url = new URL(path, 'http://fixture.local');
  const pathname = url.pathname.replace(/^\/api\/v1/, '');
  const method = init?.method?.toUpperCase() ?? 'GET';
  const workspace = watchlistWorkspaceFixture(
    pathname,
    method,
    init?.body ? JSON.parse(String(init.body)) : null,
    companies,
    now,
  );
  if (workspace.handled) return workspace.value as T;
  if (pathname === '/dashboard/personal-filings')
    return { asOf: now, companyCount: 2, items: [] } as T;
  if (pathname === '/dashboard/market-selection')
    return {
      asOf: now,
      regions: ['kr', 'us'].map((region) => ({
        region,
        status: 'UNCONFIGURED',
        reason: '공식 자료 연결 대기',
        basisDate: null,
        observedAt: null,
        sourceUrl: null,
        updateNote: null,
        items: [],
      })),
    } as T;
  const infoMatch = pathname.match(/^\/companies\/([^/]+)\/information$/u);
  if (infoMatch) {
    const company = companies.find((c) => c.id === infoMatch[1]);
    const currency = company?.ticker ? 'USD' : 'KRW';
    const prices = fixturePrices(company?.id ?? '', '1d', currency),
      last = prices.at(-1),
      previous = prices.at(-2);
    const fields = [
      ['close', '최근 종가', last?.close],
      ['previousClose', '전 거래일 종가', previous?.close],
      ['open', '시가', last?.open],
      ['high', '고가', last?.high],
      ['low', '저가', last?.low],
      ['volume', '거래량', last?.volume],
      ['marketCap', '시가총액', null],
      ['ceo', '대표자', null],
      ['industry', '업종 코드', null],
      ['revenue', '매출액', null],
      ['operatingProfit', '영업이익', null],
      ['eps', 'EPS', null],
      ['per', 'PER', null],
      ['pbr', 'PBR', null],
      ['dividend', '주당 현금배당', null],
    ].map(([key, label, value]) => ({
      key,
      label,
      value: value == null ? null : String(value),
      unit: key === 'volume' ? '주' : currency,
      basis: `${last?.time ?? ''} 일별 종가`,
      source: '개발용 모의 데이터',
      sourceUrl: 'https://example.test/',
      observedAt: now,
    }));
    return { asOf: now, status: 'AVAILABLE', fields } as T;
  }
  const recentMatch = pathname.match(/^\/companies\/([^/]+)\/recent-activity$/u);
  if (recentMatch)
    return {
      windowStartDate: '2026-08-31',
      windowEndDate: '2026-09-06',
      filingCount: 0,
      eventCount: 0,
      items: [],
    } as T;

  const membershipMatch = pathname.match(/^\/watchlist-groups\/company-memberships\/([^/]+)$/);
  if (membershipMatch) {
    const companyId = decodeURIComponent(membershipMatch[1]!);
    const input =
      method === 'PUT'
        ? (JSON.parse(
            String(init?.body ?? '{}'),
          ) as import('@orsem/contracts').SaveCompanyWatchlistMemberships)
        : undefined;
    const result = companyMembershipFixture(companyId, input);
    return (method === 'PUT' ? undefined : result) as T;
  }

  if (pathname === '/notifications/settings' && method === 'GET')
    return { ...fixtureNotificationSettings } as T;
  if (pathname === '/notifications/settings' && method === 'PATCH') {
    const preferences = JSON.parse(String(init?.body ?? '{}')) as NotificationPreferences;
    fixtureNotificationSettings = { ...fixtureNotificationSettings, ...preferences };
    return { ...fixtureNotificationSettings } as T;
  }
  if (pathname === '/notifications/test') return { queued: true, simulated: true } as T;

  if (pathname === '/sources/freshness') return { asOf: now, items: sources } as T;
  if (pathname === '/watchlist/quotes')
    return {
      asOf: now,
      items: watchlistQuoteFixtures(watchlist, (url.searchParams.get('ids') ?? '').split(',')),
    } as T;
  if (pathname === '/markets/overview')
    return {
      asOf: marketFixtureTime,
      histories: Object.fromEntries(
        marketFixtures
          .filter((item) => item.displayKind === 'NATIVE')
          .map((item) => {
            const history = marketHistoryFixture(item.id);
            return [item.id, { ...history, points: history.points.slice(-31) }];
          }),
      ),
      items: marketFixtures.filter(
        (item) =>
          !url.searchParams.get('region') ||
          url.searchParams.get('region') === 'all' ||
          item.region === url.searchParams.get('region'),
      ),
    } as T;
  const marketHistoryMatch = pathname.match(/^\/markets\/([^/]+)\/history$/);
  if (marketHistoryMatch) return marketHistoryFixture(marketHistoryMatch[1] ?? '') as T;

  if (pathname === '/auth/kakao/config') return { enabled: false, startUrl: null } as T;
  if (pathname === '/auth/members') return { items: [], nextCursor: null } as T;

  if (pathname === '/search' || pathname === '/search/suggestions') {
    if (pathname.endsWith('/suggestions'))
      url.searchParams.set(
        'q',
        decodeURIComponent(new Headers(init?.headers).get('X-Orsem-Search-Query') ?? ''),
      );
    const query = (url.searchParams.get('q') ?? '').trim();
    const needle = query.toLowerCase();
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 5));
    const companyResults: SearchItem[] = companies
      .filter((item) => fixtureRegionMatches(item.market, url.searchParams.get('region')))
      .filter((company) =>
        [company.nameKo, company.nameEn, company.stockCode, company.ticker].some((value) =>
          value?.toLowerCase().includes(needle),
        ),
      )
      .map((company) => ({
        id: company.id,
        type: 'COMPANY',
        company,
        title: company.nameKo,
        subtitle: [company.market, company.stockCode ?? company.ticker, company.nameEn]
          .filter(Boolean)
          .join(' · '),
        url: `/companies/${company.id}`,
        external: false,
        companyId: company.id,
        source: null,
        rightsMode: null,
        publishedAt: null,
        rceptDate: null,
        firstObservedAt: null,
      }));
    const filings: SearchItem[] = eventSeeds
      .filter((item) => item.detailType !== 'NEWS')
      .filter((item) => fixtureRegionMatches(item.market, url.searchParams.get('region')))
      .filter((event) => {
        const company = companies.find((item) => item.id === event.companyId);
        return [
          event.title,
          event.translation?.title,
          event.companyName,
          event.stockCode,
          company?.ticker,
          company?.nameEn,
        ].some((value) => value?.toLowerCase().includes(needle));
      })
      .map((event) => ({
        id: event.id,
        type: 'FILING',
        title: event.title,
        translation: null,
        subtitle: `${event.companyName} · ${event.detailType}`,
        url: details.get(event.id)?.officialUrl ?? '',
        external: true,
        companyId: event.companyId,
        source: event.detailType === 'SEC' ? 'SEC' : 'OPENDART',
        rightsMode: event.rightsMode,
        publishedAt: event.publishedAt,
        rceptDate: event.rceptDate,
        firstObservedAt: event.firstObservedAt,
      }))
      .filter((item) => item.url.startsWith('https://')) as SearchItem[];
    const news: SearchItem[] = fixtureNewsSeeds
      .filter(approvedFixtureNews)
      .filter(() => !url.searchParams.has('asset'))
      .filter((seed) =>
        url.searchParams.get('scope') === 'market'
          ? ['federal-reserve', 'bls'].includes(seed.item.publisherId ?? '')
          : url.searchParams.get('scope') === 'company'
            ? seed.companyId !== null
            : true,
      )
      .filter(
        (seed) =>
          !url.searchParams.get('companyId') ||
          seed.companyId === url.searchParams.get('companyId'),
      )
      .filter(
        ({ item }) =>
          !url.searchParams.get('source') || item.source === url.searchParams.get('source'),
      )
      .filter(
        ({ item }) =>
          !url.searchParams.get('sourceKind') ||
          item.sourceKind === url.searchParams.get('sourceKind'),
      )
      .filter(
        ({ item }) =>
          !url.searchParams.get('publisher') ||
          item.publisherId === url.searchParams.get('publisher'),
      )
      .filter(({ item }) => fixtureNewsRegionMatches(item, url.searchParams.get('region')))
      .filter(({ companyId, item }) => {
        const company = companies.find((value) => value.id === companyId);
        return [
          item.title,
          item.description,
          item.translation?.title,
          item.translation?.description,
          item.sourceName,
          company?.nameKo,
          company?.nameEn,
          company?.stockCode,
          company?.ticker,
        ].some((value) => value?.toLowerCase().includes(needle));
      })
      .map(({ companyId, item }) => ({
        id: item.id,
        type: 'NEWS',
        title: item.title,
        description: item.description ?? null,
        relatedCompanies: fixtureNewsProjection({ companyId, item }).relatedCompanies,
        translationStatus: fixtureNewsProjection({ companyId, item }).translationStatus,
        translation: item.translation ?? null,
        subtitle: [
          companies.find((company) => company.id === companyId)?.nameKo,
          item.sourceName ?? item.source,
        ]
          .filter(Boolean)
          .join(' · '),
        url: item.url,
        external: true,
        companyId,
        source: item.source,
        rightsMode: item.rightsMode,
        publishedAt: item.publishedAt,
        rceptDate: null,
        firstObservedAt: item.firstObservedAt,
      }));
    return {
      query,
      companies: companyResults.slice(0, limit),
      news: news.slice(0, limit),
      filings: filings.slice(0, limit),
      hasMore: {
        companies: companyResults.length > limit,
        news: news.length > limit,
        filings: filings.length > limit,
      },
    } as T;
  }

  if (pathname === '/auth/session')
    return {
      authenticated: fixtureAuthenticated,
      canAccess: fixtureAuthenticated,
      user: fixtureAuthenticated ? fixtureSession.user : null,
      csrfToken: 'fixture-csrf-token',
      setupRequired: false,
    } as T;
  if (pathname === '/auth/login' && method === 'POST') {
    fixtureAuthenticated = true;
    return {
      authenticated: true,
      canAccess: true,
      user: fixtureSession.user,
      csrfToken: 'fixture-csrf-token',
      setupRequired: false,
    } as T;
  }
  if (pathname === '/auth/logout' && method === 'POST') {
    fixtureAuthenticated = false;
    return {
      authenticated: false,
      canAccess: false,
      user: null,
      csrfToken: 'fixture-anonymous-csrf-token',
      setupRequired: false,
    } as T;
  }
  if (pathname === '/dashboard') return dashboard() as T;
  if (pathname === '/dashboard/personal-news') {
    const ids = new Set(
      fixtureAuthenticated
        ? fixtureGroups
            .filter((group) => group.kind === 'PERSONAL' && group.roomId === null)
            .flatMap((group) => [...group.companyIds])
        : [],
    );
    return {
      asOf: now,
      companyCount: ids.size,
      events: eventSeeds.filter((event) => ids.has(event.companyId)),
      news: fixtureNewsSeeds
        .filter(approvedFixtureNews)
        .filter((seed) => seed.companyId !== null && ids.has(seed.companyId))
        .map(fixtureNewsProjection),
    } as T;
  }
  if (pathname === '/news' && method === 'GET') return pageNews(url) as T;
  const newsEditMatch = pathname.match(/^\/news\/([^/]+)\/translation-edit$/u);
  if (newsEditMatch && ['GET', 'PATCH'].includes(method))
    throw Object.assign(
      new Error('기사 본문 편집이 종료되었습니다. 원문 페이지에서 기사를 확인해 주세요.'),
      { statusCode: 410 },
    );
  const newsMatch = pathname.match(/^\/news\/([^/]+)$/u);
  if (newsMatch && method === 'GET') return fixtureNewsDetail(newsMatch[1] ?? '') as T;
  if (pathname === '/news-search/naver/status' && method === 'GET')
    return {
      configured: true,
      automaticAllowed: true,
      mode: 'ON_DEMAND',
      freeUntil: '2099-12-31T00:00:00Z',
      dailyLimit: 100,
      monthlyLimit: 2000,
      remainingToday: 100,
      remainingMonth: 2000,
      reason: null,
    } as T;

  if (pathname === '/events') return pageEvents(url) as T;
  const eventMatch = pathname.match(/^\/events\/([^/]+)$/);
  if (eventMatch) {
    const detail = details.get(eventMatch[1] ?? '');
    if (!detail) throw new Error('해당 이벤트를 찾을 수 없습니다.');
    return detail as T;
  }

  if (pathname === '/companies') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const items = companies
      .filter((item) => fixtureRegionMatches(item.market, url.searchParams.get('region')))
      .filter(
        (company) =>
          !query ||
          `${company.nameKo} ${company.nameEn ?? ''} ${company.stockCode ?? ''} ${company.ticker ?? ''}`
            .toLowerCase()
            .includes(query),
      )
      .sort((a, b) => a.nameKo.localeCompare(b.nameKo, 'ko-KR'))
      .map((company) => {
        const currency = company.ticker ? 'USD' : 'KRW';
        const prices = fixturePrices(company.id, '1d', currency);
        const last = prices.at(-1)!,
          previous = prices.at(-2)!;
        return {
          ...asSummary(company),
          canonicalPath: `/companies/${company.stockCode ?? company.ticker ?? company.id}`,
          quote: {
            price: String(last.close),
            currency,
            changePercent: (last.close / previous.close - 1) * 100,
            volume: String(last.volume),
            basisDate: last.time,
            referenceDate: previous.time,
            observedAt: now,
            source: 'FIXTURE',
            marketCap: null,
            capBasisDate: null,
          },
        };
      });
    return { items, nextCursor: null } as T;
  }

  const timelineMatch = pathname.match(/^\/companies\/([^/]+)\/timeline$/);
  if (timelineMatch) {
    const companyId = timelineMatch[1] ?? '';
    const company = companies.find((item) => item.id === companyId);
    if (!company) throw new Error('해당 기업을 찾을 수 없습니다.');
    const currency = company.ticker ? 'USD' : 'KRW';
    const interval = url.searchParams.get('interval') === '1m' ? '1m' : '1d';
    const prices = fixturePrices(companyId, interval, currency);
    return {
      ...timeline,
      companyId,
      currency,
      provider: 'toss',
      interval,
      status: 'READY',
      prices,
      markers: interval === '1d' && companyId === timeline.companyId ? timeline.markers : [],
      latestCloseAt: prices.at(-1)?.time ?? null,
      returns: { oneDay: null, oneMonth: null, sinceLatestEvent: null, benchmarkOneMonth: null },
    } as T;
  }

  const livePriceMatch = pathname.match(/^\/companies\/([^/]+)\/live-price$/);
  if (livePriceMatch) {
    const company = companies.find((c) => c.id === livePriceMatch[1]);
    const currency = company?.ticker ? 'USD' : 'KRW';
    const prices = fixturePrices(company?.id ?? '', '1d', currency),
      last = prices.at(-1)!,
      previous = prices.at(-2)!;
    return {
      displayPrice: {
        price: String(last.close),
        currency,
        status: 'CLOSE',
        basis: 'DAILY_CLOSE',
        source: 'FIXTURE',
        sessionDate: last.time,
        providerAt: null,
        referenceClose: String(previous.close),
        referenceDate: previous.time,
        change: last.close - previous.close,
        changePercent: (last.close / previous.close - 1) * 100,
      },
      companyId: livePriceMatch[1],
      provider: 'toss',
      status: 'NOT_CONFIGURED',
      quote: null,
      asOf: now,
    } as T;
  }

  const companyMatch = pathname.match(/^\/companies\/([^/]+)$/);
  if (companyMatch) {
    const address = decodeURIComponent(companyMatch[1] ?? '').toUpperCase();
    const company = companies.find(
      (item) =>
        item.id === companyMatch[1] ||
        [item.stockCode, item.ticker, `${item.market}:${item.ticker ?? item.stockCode}`].some(
          (value) => value?.toUpperCase() === address,
        ),
    );
    if (!company) throw new Error('해당 기업을 찾을 수 없습니다.');
    return {
      ...company,
      canonicalPath: `/companies/${company.stockCode ?? company.ticker ?? company.id}`,
      isWatchlisted: watchlist.some((item) => item.id === company.id),
    } as T;
  }

  if (pathname === '/watchlist' && method === 'GET')
    return {
      items: watchlist.filter((item) =>
        fixtureRegionMatches(item.market, url.searchParams.get('region')),
      ),
      nextCursor: null,
    } as T;
  if (pathname === '/watchlist' && method === 'POST') {
    const payload = JSON.parse(String(init?.body ?? '{}')) as {
      companyId?: string;
      priority?: Priority;
      realtimeAlerts?: boolean;
      digestAlerts?: boolean;
      note?: string;
    };
    const company = companies.find((item) => item.id === payload.companyId);
    if (!company) throw new Error('추가할 기업을 찾을 수 없습니다.');
    const item = {
      ...asWatchlistItem(company),
      priority: payload.priority ?? 'P2',
      realtimeAlerts: payload.realtimeAlerts ?? true,
      digestAlerts: payload.digestAlerts ?? false,
      note: payload.note ?? null,
    };
    watchlist = [...watchlist.filter((entry) => entry.id !== item.id), item];
    return item as T;
  }

  const watchlistMatch = pathname.match(/^\/watchlist\/([^/]+)$/);
  if (watchlistMatch && method === 'PATCH') {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Partial<WatchlistItem>;
    const item = watchlist.find((entry) => entry.id === watchlistMatch[1]);
    if (!item) throw new Error('수정할 관심기업을 찾을 수 없습니다.');
    Object.assign(item, payload);
    return item as T;
  }
  if (watchlistMatch && method === 'DELETE') {
    const removed = watchlist.find((item) => item.id === watchlistMatch[1]);
    watchlist = watchlist.filter((item) => item.id !== watchlistMatch[1]);
    return (removed ?? null) as T;
  }

  if (pathname === '/reviews')
    return { items: reviews.filter((review) => review.status === 'OPEN'), nextCursor: null } as T;

  const reviewMatch = pathname.match(/^\/reviews\/([^/]+)\/resolve$/);
  if (reviewMatch && method === 'POST') {
    const payload = JSON.parse(String(init?.body ?? '{}')) as Pick<
      ReviewResolution,
      'resolution' | 'note'
    > & {
      planExecutionMatchId?: string;
    };
    reviews = reviews.map((review) =>
      review.id === reviewMatch[1] ? { ...review, status: 'RESOLVED' } : review,
    );
    return {
      id: reviewMatch[1],
      status: 'RESOLVED',
      resolution: payload.resolution,
      note: payload.note,
      resolvedAt: now,
      queued: false,
    } as T;
  }

  if (pathname === '/operations/sources') return { items: sources, nextCursor: null } as T;
  if (pathname === '/operations/runs') return { items: runs, nextCursor: null } as T;
  if (pathname === '/operations/parse-integrity')
    return {
      asOf: new Date().toISOString(),
      totalParseRuns: 0,
      failedParseRuns: 0,
      openReviewRows: reviews.filter((review) => review.status === 'OPEN').length,
      currentReviewSubjects: reviews.filter((review) => review.status === 'OPEN').length,
      currentUnrecoveredFilings: reviews.filter((review) => review.status === 'OPEN').length,
      currentFailedFilings: 0,
      staleOpenParseReviews: 0,
      supersededReviews: 0,
      documentUnavailableReviews: 0,
      relationReviews: 0,
      currentTypeMismatches: 0,
      futureCreatedRows: 0,
    } as T;
  if (pathname === '/operations/queues') return { items: queues, nextCursor: null } as T;

  throw new Error(`Fixture route가 없습니다: ${method} ${pathname}`);
}

export const fixtureSession: Session = {
  authenticated: true,
  canAccess: true,
  user: {
    id: 'admin',
    email: 'admin@fixture.local',
    totpEnabled: true,
    displayName: '관리자',
    provider: 'LOCAL',
    role: 'ADMIN',
    status: 'APPROVED',
  },
  csrfToken: 'fixture-csrf-token',
  setupRequired: false,
};
