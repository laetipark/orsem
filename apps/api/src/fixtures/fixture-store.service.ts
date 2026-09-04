import { Injectable } from '@nestjs/common';
import {
  ClassificationReviewResult,
  ConnectorStatus,
  Direction,
  DisclosureDetailType,
  EffectiveFilingState,
  EventState,
  EventType,
  EvidenceGrade,
  Market,
  ParseStatus,
  ReviewTaskStatus,
  RightsMode,
  SubmissionKind,
  TransactionNature,
  WatchPriority,
  type Company,
  type ConnectorHealth,
  type Event,
  type FilingDetail,
  type IrSource,
  type Review,
  type SourceItem,
  type WatchlistItem,
} from '@orsem/contracts';

const observedAt = '2026-09-03T00:12:00.000Z';
const updatedAt = '2026-09-03T00:20:00.000Z';

@Injectable()
export class FixtureStoreService {
  readonly companies: Company[] = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      market: Market.KOSPI,
      corpCode: '00126380',
      stockCode: '005930',
      ticker: null,
      cik: null,
      nameKo: '삼성전자',
      nameEn: 'Samsung Electronics',
      isListed: true,
      updatedAt,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      market: Market.KOSPI,
      corpCode: '00164779',
      stockCode: '000660',
      ticker: null,
      cik: null,
      nameKo: 'SK하이닉스',
      nameEn: 'SK hynix',
      isListed: true,
      updatedAt,
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      market: Market.NASDAQ,
      corpCode: null,
      stockCode: null,
      ticker: 'NVDA',
      cik: '0001045810',
      nameKo: '엔비디아',
      nameEn: 'NVIDIA Corporation',
      isListed: true,
      updatedAt,
    },
  ];

  readonly sourceItems: SourceItem[] = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      source: 'NAVER_NEWS',
      externalId: 'fixture-news-1',
      url: 'https://example.com/news/fixture-1',
      title: '반도체 공급망 투자 확대 관련 기사 후보',
      sourceName: 'Fixture News',
      author: null,
      publishedAt: '2026-09-03T00:05:00.000Z',
      firstObservedAt: observedAt,
      processedAt: observedAt,
      rightsMode: RightsMode.LINK_ONLY,
      provenanceUrl: 'https://example.com/news/fixture-1',
      tickers: ['005930', '000660'],
      tags: ['반도체', '공급망'],
    },
  ];

  readonly filings: FilingDetail[] = [
    {
      id: '20000000-0000-4000-8000-000000000001',
      rceptNo: '20260903000001',
      detailType: DisclosureDetailType.D002,
      reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
      filerName: '홍길동',
      rceptDate: '2026-09-03',
      submissionKind: SubmissionKind.INITIAL,
      effectiveState: EffectiveFilingState.ACTIVE,
      firstObservedAt: observedAt,
      lastSeenAt: observedAt,
      processedAt: updatedAt,
      parseStatus: ParseStatus.SUCCEEDED,
      parserConfidence: 0.99,
      company: this.companies[0]!,
      officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000001',
      parserVersion: 'opendart-parser@0.1.0',
      rm: null,
      reporter: {
        name: '홍길동',
        relationship: '대표이사',
        position: '대표이사',
        isRegisteredExecutive: true,
        isMajorShareholder: false,
        ownershipBefore: '110000.000000',
        ownershipAfter: '120000.000000',
        ownershipChange: '10000.000000',
        ownershipRateAfter: '0.010000',
      },
      transactions: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          eventDate: '2026-09-01',
          securityTypeRaw: '보통주',
          methodRaw: '장내매수(+)',
          nature: TransactionNature.MARKET_BUY,
          direction: Direction.INCREASE,
          quantity: '10000.000000',
          unitPrice: '32500.000000',
          amount: '325000000.000000',
          currency: 'KRW',
          sharesAfter: '120000.000000',
          parserConfidence: 0.99,
        },
      ],
      tradePlan: null,
      parserWarnings: [],
      relations: [],
    },
    {
      id: '20000000-0000-4000-8000-000000000002',
      rceptNo: '20260903000002',
      detailType: DisclosureDetailType.D005,
      reportName: '임원ㆍ주요주주 거래계획보고서',
      filerName: '김계획',
      rceptDate: '2026-09-03',
      submissionKind: SubmissionKind.INITIAL,
      effectiveState: EffectiveFilingState.ACTIVE,
      firstObservedAt: '2026-09-03T00:14:00.000Z',
      lastSeenAt: '2026-09-03T00:14:00.000Z',
      processedAt: updatedAt,
      parseStatus: ParseStatus.PARTIAL,
      parserConfidence: 0.78,
      company: this.companies[1]!,
      officialUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260903000002',
      parserVersion: 'opendart-parser@0.1.0',
      rm: null,
      reporter: null,
      transactions: [],
      tradePlan: {
        plannedStartDate: '2026-09-10',
        plannedEndDate: '2026-10-10',
        plannedQuantity: '5000.000000',
        plannedAmount: null,
        methodRaw: '장내매수 예정',
        planStatus: 'PLANNED',
      },
      parserWarnings: ['계획 거래는 실제 거래 완료가 아닙니다.'],
      relations: [],
    },
  ];

  readonly events: Event[] = this.filings.map((filing, index) => ({
    id: `40000000-0000-4000-8000-00000000000${index + 1}`,
    canonicalEventType:
      filing.detailType === DisclosureDetailType.D005
        ? EventType.TRADE_PLAN
        : EventType.INSIDER_OWNERSHIP,
    // OpenDART는 거래 날짜만 제공하므로 존재하지 않는 시각을 만들어 넣지 않습니다.
    occurredAt: null,
    publishedAt: null,
    firstObservedAt: filing.firstObservedAt,
    processedAt: filing.processedAt,
    state: filing.parserWarnings.length > 0 ? EventState.REVIEW_REQUIRED : EventState.VERIFIED,
    evidenceGrade: EvidenceGrade.A,
    classificationResult:
      filing.parserWarnings.length > 0
        ? ClassificationReviewResult.REVIEW_REQUIRED
        : ClassificationReviewResult.RULE_CONFIRMED,
    summary:
      filing.detailType === DisclosureDetailType.D005
        ? '임원 거래계획 공시가 감지되었습니다. 실제 거래와 구분해 확인해야 합니다.'
        : '대표이사 장내매수 10,000주가 공식 D002 원문에서 확인되었습니다.',
    company: filing.company,
    filing,
    sourceItems: [],
  }));

  readonly watchlist: WatchlistItem[] = [
    {
      id: '50000000-0000-4000-8000-000000000001',
      company: this.companies[0]!,
      priority: WatchPriority.P1,
      realtimeAlerts: true,
      digestAlerts: false,
      notes: '국내 반도체 핵심 관찰',
      createdAt: observedAt,
      updatedAt,
    },
    {
      id: '50000000-0000-4000-8000-000000000002',
      company: this.companies[1]!,
      priority: WatchPriority.P2,
      realtimeAlerts: true,
      digestAlerts: false,
      notes: null,
      createdAt: observedAt,
      updatedAt,
    },
  ];

  readonly reviews: Review[] = [
    {
      id: '60000000-0000-4000-8000-000000000001',
      subjectType: 'FILING',
      subjectId: this.filings[1]!.id,
      reason: 'D005 계획과 후속 D002 실행 여부를 아직 확인할 수 없습니다.',
      status: ReviewTaskStatus.OPEN,
      classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
      resolution: null,
      createdAt: observedAt,
      resolvedAt: null,
    },
  ];

  readonly connectors: ConnectorHealth[] = [
    {
      connector: 'opendart',
      status: ConnectorStatus.DEGRADED,
      message: 'fixture mode: 네트워크 호출 없이 예제 데이터를 제공합니다.',
      lastSuccessAt: observedAt,
      lastFailureAt: null,
      checkedAt: updatedAt,
    },
  ];

  readonly irSources: IrSource[] = [
    {
      id: '70000000-0000-4000-8000-000000000001',
      companyId: this.companies[0]!.id,
      url: 'https://www.samsung.com/global/ir/rss/',
      sourceType: 'RSS',
      rightsMode: RightsMode.OFFICIAL_PUBLIC_DATA,
      isActive: false,
      lastCheckedAt: null,
      createdAt: observedAt,
      updatedAt,
    },
  ];

  readonly pairingCodes = new Map<string, { adminId: string; expiresAt: Date }>();
  readonly devices = new Map<
    string,
    {
      id: string;
      tokenHash: string;
      room: string;
      authorHash: string;
      packageName: string;
      botVersion: string;
      lastSeenAt: Date;
    }
  >();
  readonly deliveries: Array<{
    id: string;
    consumer: 'DISCORD' | 'MESSENGERBOTR';
    deviceId: string | null;
    payload: Record<string, unknown>;
    status: string;
    availableAt: Date;
    leaseUntil: Date | null;
    externalMessageId: string | null;
    attempts: number;
    lastError: string | null;
  }> = [];
}
