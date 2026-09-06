import type { ConnectorHealthEntity } from '@orsem/database';

function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Never expose provider bodies, query strings, SQL errors, credentials or raw stored messages. */
export function publicDiscoveryStatus(
  row: Pick<ConnectorHealthEntity, 'connector' | 'status' | 'metadataJson'>,
): {
  message: string;
  httpStatus: number | null;
  requestAttempted: boolean | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  incomplete: boolean;
  lastWindowStart: string | null;
  lastWindowEnd: string | null;
  latestObservedAt: string | null;
} {
  const metadata = row.metadataJson ?? {};
  const httpStatus =
    typeof metadata.httpStatus === 'number' &&
    Number.isInteger(metadata.httpStatus) &&
    metadata.httpStatus >= 0 &&
    metadata.httpStatus <= 599
      ? metadata.httpStatus
      : null;
  const requestAttempted =
    typeof metadata.requestAttempted === 'boolean'
      ? metadata.requestAttempted
      : typeof metadata.requestsAttempted === 'number'
        ? metadata.requestsAttempted > 0
        : null;
  const nextRetryAt = instant(metadata.retryAt);
  const prefix =
    row.connector.toLowerCase() === 'sec'
      ? 'SEC'
      : row.connector.toLowerCase() === 'alpaca_news'
        ? 'Alpaca News'
        : 'GDELT';
  const reason =
    row.status === 'UNCONFIGURED'
      ? '설정 또는 이용 권리 확인이 필요해 요청하지 않았습니다.'
      : metadata.incomplete === true
        ? '미완료 구간의 복구가 필요합니다.'
        : httpStatus === 403
          ? '접근이 거부되었습니다(403).'
          : httpStatus === 429
            ? '요청 빈도 제한입니다(429).'
            : metadata.truncated === true
              ? '조회 상한에 도달해 일부 결과가 누락되었을 수 있습니다.'
              : row.status === 'HEALTHY'
                ? '수집 요청이 정상 완료되었습니다.'
                : metadata.emptyScope === true || metadata.requestsPlanned === false
                  ? '수집 대상이 없어 요청하지 않았습니다.'
                  : '수집 결과를 확인하지 못했습니다.';
  const attempt =
    httpStatus === 403 || httpStatus === 429
      ? requestAttempted === false
        ? ' 대기 중이므로 새 요청을 보내지 않았습니다.'
        : requestAttempted === true
          ? ' 실제 공급자 응답입니다.'
          : ''
      : '';
  const secGuidance =
    prefix === 'SEC' && httpStatus === 403
      ? metadata.providerCode === 'SEC_UNDECLARED_AUTOMATION'
        ? ' SEC가 미신고 자동화 도구로 분류했습니다. 운영자는 앱·연락처 User-Agent가 실제 전달되는지 확인하고, 정상이라면 SEC Webmaster에 접근 검토를 요청해야 합니다.'
        : metadata.providerCode === 'SEC_RATE_LIMIT'
          ? ' SEC 요청 빈도 제한 응답입니다. 같은 송신망의 다른 수집 요청도 확인해야 합니다.'
          : metadata.providerCode === 'SEC_ACCESS_DENIED'
            ? ' SEC 접근 정책에 따른 거부입니다. 반복되면 운영자는 SEC Webmaster에 접근 검토를 요청해야 합니다.'
            : ' 403만으로 원인을 확정할 수 없습니다. 운영자는 앱·연락처 User-Agent와 송신망을 확인해야 합니다.'
      : '';
  const retryGuidance =
    prefix === 'SEC' && (httpStatus === 403 || httpStatus === 429)
      ? ' 다음 요청 가능 시각은 앱의 재시도 대기 종료이며, 접근 복구를 보장하지 않습니다.'
      : '';
  return {
    message: `${prefix} ${reason}${attempt}${secGuidance}${retryGuidance}`,
    httpStatus,
    requestAttempted,
    lastAttemptAt: instant(metadata.lastAttemptAt),
    nextRetryAt,
    incomplete: metadata.incomplete === true,
    lastWindowStart: instant(metadata.lastWindowStart),
    lastWindowEnd: instant(metadata.lastWindowEnd),
    latestObservedAt: instant(metadata.latestObservedAt),
  };
}
