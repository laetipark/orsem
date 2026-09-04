import {
  largeHoldingSchema,
  proxySolicitationSchema,
  tenderOfferSchema,
  type FilingDetail,
} from '@orsem/contracts';
import {
  LargeHolderReportEntity,
  LargeHoldingChangeEntity,
  ProxySolicitationEntity,
  ProxyAgendaItemEntity,
  TenderOfferEntity,
  TenderOfferSecurityEntity,
  type ParseRunEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';

type Facts = Pick<FilingDetail, 'largeHolding' | 'proxySolicitation' | 'tenderOffer'>;

/** Read only the current, validated projection; candidate runs remain in admin review. */
export async function readDisclosureFacts(
  source: DataSource,
  filingId: string,
  run: ParseRunEntity | null,
): Promise<Facts> {
  const facts: Facts = { largeHolding: null, proxySolicitation: null, tenderOffer: null };
  if (run?.resultType === 'D001') {
    const report = await source
      .getRepository(LargeHolderReportEntity)
      .findOne({ where: { filingId }, order: { createdAt: 'ASC' } });
    if (report) {
      const changes = await source.getRepository(LargeHoldingChangeEntity).find({
        where: { largeHolderReportId: report.id },
        order: { eventDate: 'ASC', id: 'ASC' },
      });
      const reason = report.rawJson?.reportReasonKind;
      facts.largeHolding = largeHoldingSchema.parse({
        ...report,
        reportReasonKind:
          typeof reason === 'string' &&
          ['HOLDINGS_CHANGE', 'CONTRACT_CHANGE', 'REPORTING_STATUS_CHANGE'].includes(reason)
            ? reason
            : 'UNKNOWN',
        changes,
      });
    }
  } else if (run?.resultType === 'D003') {
    const report = await source
      .getRepository(ProxySolicitationEntity)
      .findOneBy({ filingId, parseRunId: run.id });
    if (report) {
      const agendas = await source
        .getRepository(ProxyAgendaItemEntity)
        .find({ where: { proxySolicitationId: report.id }, order: { ordinal: 'ASC' } });
      facts.proxySolicitation = proxySolicitationSchema.parse({ ...report.factsJson, agendas });
    }
  } else if (run?.resultType === 'D004') {
    const report = await source
      .getRepository(TenderOfferEntity)
      .findOneBy({ filingId, parseRunId: run.id });
    if (report) {
      const securities = await source
        .getRepository(TenderOfferSecurityEntity)
        .find({ where: { tenderOfferId: report.id }, order: { rowIndex: 'ASC' } });
      facts.tenderOffer = tenderOfferSchema.parse({
        ...report.factsJson,
        documentKind: report.documentKind,
        securities: securities.map((row) => ({ ...row.factsJson, rowIndex: row.rowIndex })),
      });
    }
  }
  return facts;
}

export function candidateDisclosureEvidence(parsed: Record<string, unknown> | undefined): string[] {
  if (!parsed || !['D001', 'D003', 'D004'].includes(String(parsed.detailType))) return [];
  const labels: Record<string, string> = {
    reporterName: '보고자',
    reportReasonRaw: '보고 사유',
    holdingPurposeRaw: '보유 목적',
    solicitorName: '권유자',
    targetCompanyName: '대상 회사',
    relationshipRaw: '관계',
    meetingDate: '주주총회 날짜',
    meetingTimeRaw: '원문 시간',
    meetingLocation: '총회 장소',
    solicitationStartDate: '권유 시작',
    solicitationEndDate: '권유 종료',
    purposeRaw: '목적',
    electronicVoting: '전자투표',
    documentKind: '문서 구분',
    offerorName: '공개매수자',
    conditionsRaw: '공개매수 조건',
    subscriptionStartDate: '청약 시작',
    subscriptionEndDate: '청약 종료',
    settlementDate: '결제일',
  };
  const facts = Object.entries(labels).flatMap(([key, label]) =>
    parsed[key] == null ? [] : [`${label}: ${String(parsed[key]).slice(0, 1500)}`],
  );
  for (const key of ['agendas', 'securities']) {
    const rows = parsed[key];
    if (!Array.isArray(rows)) continue;
    for (const value of rows.slice(0, 30)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (key === 'agendas') {
        facts.push(`안건 ${String(row.ordinal ?? '')}: ${String(row.title ?? '제목 미확인')}`);
      } else {
        const valueText = (name: string, label: string, unit = '') =>
          row[name] == null ? null : `${label} ${String(row[name])}${unit}`;
        facts.push(
          [
            String(row.securityTypeRaw ?? '증권 종류 미확인'),
            valueText('unitPrice', '가격', row.currency ? ` ${String(row.currency)}` : ''),
            valueText('minQuantity', '최소 예정', '주'),
            valueText('maxQuantity', '최대 예정', '주'),
            valueText('offeredQuantity', '응모', '주'),
            valueText('acquiredQuantity', '실제 취득', '주'),
          ]
            .filter(Boolean)
            .join(' · '),
        );
      }
    }
    if (rows.length > 30)
      facts.push(
        `목록 ${rows.length}건 중 앞의 30건을 표시합니다. 나머지는 공식 원문에서 확인하세요.`,
      );
  }
  return facts;
}
