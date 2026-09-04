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
    message: 'D001 · D002 · D005 폴링 정상',
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
    todayCounts: { D001: 6, D002: 23, D005: 2 },
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

  if (pathname === '/search') {
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
    const documents: SearchItem[] = eventSeeds
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
        type: event.detailType === 'NEWS' ? 'NEWS' : 'FILING',
        title: event.title,
        translation: event.detailType === 'NEWS' ? (event.translation ?? null) : null,
        subtitle: `${event.companyName} · ${event.detailType}`,
        url: details.get(event.id)?.officialUrl ?? '',
        external: true,
        companyId: event.companyId,
        source:
          event.id === 'evt-msft-news-translation-01'
            ? 'IR'
            : event.detailType === 'NEWS'
              ? 'NAVER'
              : event.detailType === 'SEC'
                ? 'SEC'
                : 'OPENDART',
        rightsMode: event.rightsMode,
        publishedAt: event.publishedAt,
        rceptDate: event.rceptDate,
        firstObservedAt: event.firstObservedAt,
      }))
      .filter((item) => item.url.startsWith('https://')) as SearchItem[];
    const news = documents.filter((item) => item.type === 'NEWS');
    const filings = documents.filter((item) => item.type === 'FILING');
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
      .map(asSummary);
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
    return {
      companyId: livePriceMatch[1],
      provider: 'toss',
      status: 'NOT_CONFIGURED',
      quote: null,
      asOf: now,
    } as T;
  }

  const companyMatch = pathname.match(/^\/companies\/([^/]+)$/);
  if (companyMatch) {
    const company = companies.find((item) => item.id === companyMatch[1]);
    if (!company) throw new Error('해당 기업을 찾을 수 없습니다.');
    return { ...company, isWatchlisted: watchlist.some((item) => item.id === company.id) } as T;
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
