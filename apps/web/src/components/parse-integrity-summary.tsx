import type { ParseIntegrityMetrics } from '../types';
import { formatKst, formatNumber } from '../lib/format';
import './parse-integrity-summary.css';

export function ParseIntegritySummary({ data }: { data: ParseIntegrityMetrics }) {
  const items = [
    ['전체 파싱 실행', data.totalParseRuns],
    ['열린 검토 이력', data.openReviewRows],
    ['현재 검토 대상', data.currentReviewSubjects],
    ['미복구 공시', data.currentUnrecoveredFilings],
    ['현재 파서 실패 공시', data.currentFailedFilings],
    ['이전 실행의 열린 검토', data.staleOpenParseReviews],
    ['원문 미제공', data.documentUnavailableReviews],
    ['정정·원공시 연결 확인', data.relationReviews],
  ] as const;
  return (
    <div className="parse-integrity-summary">
      <dl aria-label="파싱 실행 이력과 현재 검토 대상">
        {items.map(([label, count]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{formatNumber(count)}</dd>
          </div>
        ))}
      </dl>
      <p>실행 이력과 현재 처리 대상을 구분합니다. 파서 실패는 검토 대기에도 포함됩니다.</p>
      <small>
        기준 {formatKst(data.asOf)} · 후속 검토로 연결된 이력 {formatNumber(data.supersededReviews)}
        건
      </small>
      {data.currentTypeMismatches > 0 ? (
        <p role="status">
          공시 유형과 파싱 결과가 다른 항목 {formatNumber(data.currentTypeMismatches)}건은 재검증이
          필요합니다.
        </p>
      ) : null}
      {data.futureCreatedRows > 0 ? (
        <p role="status">
          기준 시각보다 생성 시각이 늦은 이력 {formatNumber(data.futureCreatedRows)}건이 있어
          시간대를 점검해야 합니다.
        </p>
      ) : null}
    </div>
  );
}
