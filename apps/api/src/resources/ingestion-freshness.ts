import { ConnectorStatus } from '@orsem/contracts';
import type { ConnectorHealthEntity } from '@orsem/database';

const staleAfterMinutes: Record<string, number> = {
  sec: 30,
  ir: 45,
  news_rss: 45,
  gdelt: 90,
  marketaux: 180,
  finnhub: 180,
  alphavantage: 36 * 60,
};

/** A successful poll (including 304) is different from a newly published article. */
export function ingestionFreshness(
  row: Pick<ConnectorHealthEntity, 'connector' | 'status' | 'lastSuccessAt' | 'metadataJson'>,
  now = Date.now(),
) {
  const minutes = staleAfterMinutes[row.connector.toLowerCase()];
  if (!minutes) return { status: row.status, message: null, freshnessState: null };
  const metadata = row.metadataJson ?? {};
  const lastSuccess = row.lastSuccessAt ? new Date(row.lastSuccessAt).getTime() : NaN;
  const stale = !Number.isFinite(lastSuccess) || now - lastSuccess > minutes * 60_000;
  if (row.status === ConnectorStatus.HEALTHY && stale) {
    return {
      status: ConnectorStatus.DEGRADED,
      message: '예정된 수집 주기를 지나 최신 확인이 지연되고 있습니다.',
      freshnessState: 'STALE',
    };
  }
  const failed = Math.max(
    Number(metadata.issuerFailureCount ?? 0),
    Number(metadata.failedIssuerCount ?? 0),
    Number(metadata.failedFeedCount ?? 0),
    Number(metadata.partialFailureCount ?? 0),
  );
  if (
    (row.status === ConnectorStatus.HEALTHY || row.status === ConnectorStatus.DEGRADED) &&
    (metadata.incomplete === true || metadata.truncated === true || failed > 0)
  ) {
    return {
      status: ConnectorStatus.DEGRADED,
      message: '일부 자료 수집이 완료되지 않았습니다.',
      freshnessState: 'PARTIAL',
    };
  }
  if (row.status === ConnectorStatus.HEALTHY) {
    const unchanged =
      metadata.requestAttempted !== false &&
      (metadata.discoveryCreated === 0 || metadata.created === 0 || metadata.httpStatus === 304);
    return {
      status: row.status,
      message: unchanged
        ? '정상 확인했으며 새로 수집된 자료가 없습니다.'
        : '최근 수집이 정상 완료되었습니다.',
      freshnessState: unchanged ? 'NO_NEW_ITEMS' : 'CURRENT',
    };
  }
  return { status: row.status, message: null, freshnessState: 'UNAVAILABLE' };
}
