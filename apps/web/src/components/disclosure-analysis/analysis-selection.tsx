import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AnalysisPeriod, AnalysisSelection } from '@orsem/contracts';
import { api } from '../../lib/api';
import {
  analysisApi,
  analysisBasisLabels,
  analysisMetricLabels,
  analysisPeriodLabels,
} from '../../lib/disclosure-analysis-api';
import { formatKst } from '../../lib/format';
import { Button, Input, Select } from '../ui';

export function AnalysisSelectionForm({
  value,
  onChange,
  actor,
  pending,
  onSubmit,
}: {
  value: AnalysisSelection;
  onChange: (value: AnalysisSelection) => void;
  actor: string;
  pending: boolean;
  onSubmit: () => void;
}) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [reportCode, setReportCode] = useState<AnalysisPeriod['reportCode']>('11011');
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const companies = useQuery({
    queryKey: ['analysis-company-search', actor, term],
    queryFn: ({ signal }) => api.companies(term, 'all', null, signal),
    enabled: term.length > 0,
  });
  const groups = useQuery({
    queryKey: ['analysis-personal-groups', actor],
    queryFn: ({ signal }) => api.watchlistGroups(signal),
  });
  const periodQueries = useQueries({
    queries: value.companyIds.map((id) => ({
      queryKey: ['analysis-periods', actor, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => analysisApi.periods(id, signal),
    })),
  });
  const reports = periodQueries.flatMap((query) => query.data?.items ?? []);
  useEffect(() => {
    let active = true;
    const missing = value.companyIds.filter((id) => !names[id]);
    if (!missing.length) return;
    void Promise.all(
      missing.map(async (id) => {
        try {
          const company = await api.company(id);
          return [id, company.nameKo] as const;
        } catch {
          return [id, '선택한 기업'] as const;
        }
      }),
    ).then((entries) => {
      if (active) setNames((old) => ({ ...old, ...Object.fromEntries(entries) }));
    });
    return () => {
      active = false;
    };
  }, [value.companyIds, names]);
  const update = (next: Partial<AnalysisSelection>) => onChange({ ...value, ...next });
  return (
    <form
      className="analysis-filters"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="analysis-wide">
        <label className="analysis-field">
          기업 검색
          <Input
            value={search}
            placeholder="기업명 또는 종목코드 검색"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {companies.isError ? <p role="alert">기업 목록을 불러오지 못했습니다.</p> : null}
        {companies.data ? (
          <div className="analysis-company-results" aria-label="기업 검색 결과">
            {companies.data.items.map((company) => (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                key={company.id}
                disabled={value.companyIds.includes(company.id) || value.companyIds.length >= 20}
                onClick={() => {
                  setNames((old) => ({ ...old, [company.id]: company.nameKo }));
                  update({ companyIds: [...value.companyIds, company.id], groupId: undefined });
                }}
              >
                {company.nameKo} · {company.stockCode ?? company.ticker}
              </Button>
            ))}
            {!companies.data.items.length ? <span>검색 결과가 없습니다.</span> : null}
          </div>
        ) : null}
        <div className="analysis-chips" aria-label="선택한 기업">
          {value.companyIds.map((id) => (
            <span className="analysis-chip" key={id}>
              {names[id] ?? '기업 확인 중'}
              <button
                type="button"
                aria-label={`${names[id] ?? '기업'} 선택 해제`}
                onClick={() =>
                  update({
                    companyIds: value.companyIds.filter((item) => item !== id),
                    groupId: undefined,
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
      <label>
        관심그룹
        <Select
          value={value.groupId ?? ''}
          onChange={(e) => update({ groupId: e.target.value || undefined, companyIds: [] })}
        >
          <option value="">직접 선택한 기업</option>
          {value.groupId && !groups.data?.items.some((group) => group.id === value.groupId) ? (
            <option value={value.groupId}>선택한 관심그룹</option>
          ) : null}
          {groups.data?.items.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name} ({group.itemCount})
            </option>
          ))}
        </Select>
      </label>
      <label>
        재무제표
        <Select
          value={value.scope}
          onChange={(e) => update({ scope: e.target.value as AnalysisSelection['scope'] })}
        >
          <option value="CFS">연결</option>
          <option value="OFS">별도</option>
        </Select>
      </label>
      <label>
        기간 기준
        <Select
          value={value.basis}
          onChange={(e) => {
            const basis = e.target.value as AnalysisSelection['basis'];
            update({
              basis,
              periods: [],
              rolling:
                basis === 'ANNUAL' ? { kind: 'ANNUAL', count: 3 } : { kind: 'QUARTER', count: 8 },
            });
          }}
        >
          {Object.entries(analysisBasisLabels)
            .filter(([key]) => key !== 'INSTANT')
            .map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
        </Select>
      </label>
      <label>
        조회 기간
        <Select
          value={value.rolling ? 'rolling' : 'fixed'}
          onChange={(e) =>
            update(
              e.target.value === 'rolling'
                ? {
                    periods: [],
                    rolling: {
                      kind: value.basis === 'ANNUAL' ? 'ANNUAL' : 'QUARTER',
                      count: value.basis === 'ANNUAL' ? 3 : 8,
                    },
                  }
                : { rolling: undefined, periods: [] },
            )
          }
        >
          <option value="rolling">
            {value.basis === 'ANNUAL' ? '최근 3개 사업연도' : '최근 8개 분기'}
          </option>
          <option value="fixed">기간 직접 선택</option>
        </Select>
      </label>
      {!value.rolling ? (
        <div className="analysis-wide analysis-toolbar">
          <label className="analysis-field">
            사업연도
            <Input
              aria-label="사업연도"
              type="number"
              min={2015}
              max={2100}
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            />
          </label>
          <label className="analysis-field">
            보고기간
            <Select
              value={reportCode}
              onChange={(e) => setReportCode(e.target.value as AnalysisPeriod['reportCode'])}
            >
              {Object.entries(analysisPeriodLabels).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              value.periods.length >= 20 ||
              value.periods.some((p) => p.year === year && p.reportCode === reportCode)
            }
            onClick={() => update({ periods: [...value.periods, { year, reportCode }] })}
          >
            기간 추가
          </Button>
          <div className="analysis-chips">
            {value.periods.map((period) => (
              <span className="analysis-chip" key={`${period.year}:${period.reportCode}`}>
                {period.year} {analysisPeriodLabels[period.reportCode]}
                <button
                  type="button"
                  aria-label={`${period.year} ${analysisPeriodLabels[period.reportCode]} 제거`}
                  onClick={() => update({ periods: value.periods.filter((p) => p !== period) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <label>
        제출본 기준
        <Select
          value={value.versionPolicy}
          onChange={(e) =>
            update({
              versionPolicy: e.target.value as AnalysisSelection['versionPolicy'],
              reportIds: [],
            })
          }
        >
          <option value="LATEST_OBSERVED">최신 관측 제출본</option>
          <option value="FIRST_OBSERVED">최초 관측 제출본</option>
          <option value="SPECIFIC">보존된 제출본 선택</option>
        </Select>
      </label>
      {value.versionPolicy === 'SPECIFIC' ? (
        <label className="analysis-wide">
          보존된 제출본
          <Select
            multiple
            size={4}
            aria-label="보존된 제출본"
            value={value.reportIds ?? []}
            onChange={(e) =>
              update({ reportIds: Array.from(e.target.selectedOptions, (option) => option.value) })
            }
          >
            {reports.map((report) => (
              <option key={report.id} value={report.id}>
                {names[report.companyId] ?? '기업'} · {report.reportYear}{' '}
                {analysisPeriodLabels[report.reportCode]} · {report.scope} · {report.filingId} ·
                관측 {formatKst(report.firstObservedAt)}
              </option>
            ))}
          </Select>
          {periodQueries.some((query) => query.isPending) && value.companyIds.length
            ? '제출본 확인 중'
            : !reports.length
              ? '먼저 기업을 선택해 자료를 수집하세요.'
              : '여러 제출본을 선택할 수 있습니다.'}
        </label>
      ) : null}
      <fieldset className="analysis-wide analysis-metrics">
        <legend>비교 항목</legend>
        {Object.entries(analysisMetricLabels).map(([key, label]) => (
          <label className="analysis-checkbox" key={key}>
            <input
              type="checkbox"
              checked={value.metrics.includes(key as AnalysisSelection['metrics'][number])}
              onChange={(e) =>
                update({
                  metrics: e.target.checked
                    ? [...value.metrics, key as AnalysisSelection['metrics'][number]]
                    : value.metrics.filter((metric) => metric !== key),
                })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="analysis-wide analysis-toolbar">
        <Button type="submit" disabled={pending}>
          {pending ? '조회 요청 중…' : '재무 비교 시작'}
        </Button>
        <span className="analysis-muted">
          원문 기준 통화와 기간을 유지합니다. 미확보 자료는 0으로 계산하지 않습니다.
        </span>
      </div>
    </form>
  );
}
