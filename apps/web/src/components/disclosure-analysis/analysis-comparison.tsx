import type { AnalysisRun, FinancialFact } from '@orsem/contracts';
import { useQueries } from '@tanstack/react-query';
import { companyQuery } from '../../lib/company-query';
import {
  analysisBasisLabels,
  analysisMetricLabels,
  analysisPeriodLabels,
} from '../../lib/disclosure-analysis-api';
import {
  analysisNumber,
  analysisSourceUrl,
  analysisStatus,
} from '../../lib/disclosure-analysis-display';
import { formatKst } from '../../lib/format';
import { Badge, Button, Card, CardContent, CardHeader, EmptyState } from '../ui';

export function AnalysisComparison({
  run,
  onSelect,
}: {
  run: AnalysisRun;
  onSelect: (fact: FinancialFact) => void;
}) {
  const facts = run.result?.facts ?? [];
  const quarterOrder = { '11013': 1, '11012': 2, '11014': 3, '11011': 4 };
  const columns = [
    ...new Map(facts.map((fact) => [`${fact.companyId}:${fact.reportId}`, fact])).entries(),
  ].sort(
    ([, left], [, right]) =>
      run.companyIds.indexOf(left.companyId) - run.companyIds.indexOf(right.companyId) ||
      left.reportYear - right.reportYear ||
      quarterOrder[left.reportCode] - quarterOrder[right.reportCode] ||
      left.evidence.observedAt.localeCompare(right.evidence.observedAt),
  );
  if (!facts.length)
    return (
      <EmptyState
        title="아직 비교할 수치가 없습니다"
        description="자료 확인 상태와 미확보 항목을 확인해 주세요."
      />
    );
  return (
    <div className="analysis-table-wrap">
      <table className="analysis-table">
        <caption className="sr-only">
          기업·보고기간별 재무 비교. 숫자를 선택하면 원문 근거를 확인할 수 있습니다.
        </caption>
        <thead>
          <tr>
            <th scope="col">재무 항목</th>
            {columns.map(([key, fact]) => (
              <th scope="col" key={key}>
                {fact.companyName ?? '선택한 기업'}
                <br />
                {fact.reportYear} {analysisPeriodLabels[fact.reportCode]}
                <br />
                {fact.scope === 'CFS'
                  ? '연결'
                  : fact.scope === 'OFS'
                    ? '별도'
                    : '범위 확인 전'} · {analysisBasisLabels[run.selection.basis]}
                <small>
                  {fact.periodStart ? `${fact.periodStart} ~ ` : ''}
                  {fact.periodEnd}
                </small>
                <small>
                  공시 {fact.evidence.publicationDate ?? '날짜 확인 전'} · {fact.evidence.filingId}
                </small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.selection.metrics.map((metric) => (
            <tr key={metric}>
              <th scope="row">{analysisMetricLabels[metric]}</th>
              {columns.map(([key]) => {
                const matches = facts.filter(
                  (fact) => `${fact.companyId}:${fact.reportId}` === key && fact.metric === metric,
                );
                return (
                  <td className="analysis-numeric" key={key}>
                    {matches.length ? (
                      matches.map((fact) => (
                        <div key={fact.id}>
                          <button
                            type="button"
                            className="analysis-number"
                            aria-label={`${fact.companyName ?? '기업'} ${fact.reportYear} ${analysisMetricLabels[metric]} 근거 ${analysisNumber(fact.value)}`}
                            onClick={() => onSelect(fact)}
                          >
                            {fact.status === 'AVAILABLE' ? analysisNumber(fact.value) : '—'}
                          </button>
                          <small>
                            {fact.status === 'AVAILABLE'
                              ? `${fact.currency ?? ''} ${fact.unit} · ${analysisBasisLabels[fact.basis]}`
                              : (fact.reason ?? analysisStatus(fact.status))}
                          </small>
                          {fact.comparison ? (
                            <small>
                              증감 {analysisNumber(fact.comparison.difference)}
                              {fact.comparison.percent !== null
                                ? ` (${analysisNumber(fact.comparison.percent)}%)`
                                : ''}
                              {fact.comparison.transition === 'PROFIT'
                                ? ' · 흑자 전환'
                                : fact.comparison.transition === 'LOSS'
                                  ? ' · 적자 전환'
                                  : ''}
                            </small>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <span>
                        —<small>해당 기준 자료 없음</small>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalysisEvidence({
  fact,
  onClose,
  onDocument,
}: {
  fact: FinancialFact;
  onClose: () => void;
  onDocument: (id: string) => void;
}) {
  const evidence = fact.evidence,
    url = analysisSourceUrl(evidence.sourceUrl);
  const entries = [
    ['원문 계정', fact.accountName],
    ['계정 식별자', fact.accountId],
    ['원문 표시값', fact.rawValue],
    ['비교 값', fact.value],
    ['통화·단위', `${fact.currency ?? '확인 전'} · ${fact.unit} · 배율 ${fact.scale}`],
    [
      '보고기간',
      `${fact.periodStart ? `${fact.periodStart} ~ ` : ''}${fact.periodEnd ?? '확인 전'} · ${analysisBasisLabels[fact.basis]}`,
    ],
    ['재무제표', fact.scope === 'CFS' ? '연결' : fact.scope === 'OFS' ? '별도' : '확인 전'],
    ['제출본', evidence.filingId],
    ['공시일', evidence.publicationDate],
    ['관측 시각', formatKst(evidence.observedAt)],
    ['출처', evidence.source === 'OPENDART' ? 'OpenDART' : 'SEC'],
    [
      '원문 위치',
      [
        evidence.tableId,
        evidence.row != null ? `행 ${evidence.row + 1}` : null,
        evidence.column != null ? `열 ${evidence.column + 1}` : null,
        evidence.sourceField,
      ]
        .filter(Boolean)
        .join(' · ') || '공식 재무 API 계정',
    ],
  ];
  return (
    <Card className="analysis-evidence" aria-label="선택한 숫자의 근거">
      <CardHeader>
        <h3>{analysisMetricLabels[fact.metric]} 근거</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          닫기
        </Button>
      </CardHeader>
      <CardContent>
        <Badge>{analysisStatus(fact.status)}</Badge>
        {fact.reason ? <p className="analysis-warning">{fact.reason}</p> : null}
        <dl>
          {entries.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value ?? '—'}</dd>
            </div>
          ))}
        </dl>
        <div className="analysis-toolbar">
          {url ? (
            <a
              className="button button--secondary button--sm"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              공식 원문 열기
            </a>
          ) : null}
          {evidence.documentId ? (
            <Button size="sm" onClick={() => onDocument(evidence.documentId!)}>
              원문 표 확인
            </Button>
          ) : null}
        </div>
        <details>
          <summary>추출·매핑 정보</summary>
          <dl>
            <dt>매핑 버전</dt>
            <dd>{fact.mappingVersion ?? '—'}</dd>
            <dt>추출 버전</dt>
            <dd>{evidence.parserVersion ?? '—'}</dd>
            <dt>원문 해시</dt>
            <dd>{evidence.rawSha256}</dd>
            <dt>이용 범위</dt>
            <dd>{evidence.rightsMode}</dd>
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}

export function AnalysisIssues({ run }: { run: AnalysisRun }) {
  const companyIds = [...new Set(run.result?.issues.map((issue) => issue.companyId) ?? [])];
  const companies = useQueries({ queries: companyIds.map(companyQuery) });
  const names = new Map(
    companies.flatMap((query) => (query.data ? [[query.data.id, query.data.nameKo] as const] : [])),
  );
  return run.result?.issues.length ? (
    <details className="analysis-warning" open>
      <summary>미확보·확인 필요 항목 {run.result.issues.length}개</summary>
      <ul>
        {run.result.issues.map((issue, index) => (
          <li key={`${issue.companyId}:${issue.code}:${index}`}>
            {names.get(issue.companyId) ??
              `선택 기업 ${run.companyIds.indexOf(issue.companyId) + 1}`}{' '}
            ·{' '}
            {issue.period
              ? `${issue.period.year} ${analysisPeriodLabels[issue.period.reportCode]} · `
              : ''}
            {issue.message}
            {issue.retryable ? ' · 재시도 가능' : ''}
          </li>
        ))}
      </ul>
    </details>
  ) : null;
}
