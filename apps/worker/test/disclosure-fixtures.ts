import {
  OPENDART_PARSER_VERSION,
  type ParsedD003Report,
  type ParsedD004Report,
} from '@orsem/opendart-parser';

const source = {
  archiveSha256: 'a'.repeat(64),
  archiveByteLength: 4,
  selectedEntryName: 'report.xml',
  candidateEntries: ['report.xml'],
};

export const proxyParsed: ParsedD003Report = {
  detailType: 'D003',
  parserVersion: OPENDART_PARSER_VERSION,
  source,
  solicitorName: '합성 권유자',
  targetCompanyName: '합성 회사',
  relationshipRaw: null,
  meetingDate: '2026-09-14',
  meetingTimeRaw: '오후 2시',
  meetingAt: '2026-09-14T05:00:00.000Z',
  meetingLocation: '서울',
  solicitationStartDate: '2026-09-07',
  solicitationEndDate: '2026-09-13',
  purposeRaw: '의결권 대리행사 권유',
  electronicVoting: true,
  agendas: [{ ordinal: 1, title: '이사 선임', provenance: {} }],
  confidence: 0.95,
  provenance: {},
  warnings: [],
  tablesScanned: 2,
};

export const tenderParsed: ParsedD004Report = {
  detailType: 'D004',
  parserVersion: OPENDART_PARSER_VERSION,
  source,
  documentKind: 'REPORT',
  offerorName: '합성 공개매수자',
  targetCompanyName: '합성 회사',
  purposeRaw: '공개매수',
  conditionsRaw: '공시 조건 참조',
  subscriptionStartDate: '2026-09-07',
  subscriptionEndDate: '2026-09-28',
  settlementDate: '2026-10-02',
  securities: [
    {
      rowIndex: 1,
      securityTypeRaw: '보통주',
      unitPrice: '10000',
      currency: 'KRW',
      minQuantity: '100',
      maxQuantity: '200',
      heldQuantity: '1000',
      expectedHoldingsMin: '1100',
      expectedHoldingsMax: '1200',
      offeredQuantity: null,
      acquiredQuantity: null,
      actualAmount: null,
      provenance: {},
    },
  ],
  confidence: 0.95,
  provenance: {},
  warnings: [],
  tablesScanned: 2,
};
