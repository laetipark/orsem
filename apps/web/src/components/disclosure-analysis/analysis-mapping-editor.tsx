import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { analysisMappingSchema, type AnalysisMapping } from '@orsem/contracts';
import {
  analysisApi,
  analysisMetricLabels,
  type AnalysisMappingInput,
} from '../../lib/disclosure-analysis-api';
import { analysisError, analysisSourceUrl } from '../../lib/disclosure-analysis-display';
import { Button, ErrorState, Input, Select } from '../ui';

const emptyMapping: AnalysisMappingInput = {
  source: 'OPENDART',
  taxonomy: 'ifrs-full',
  accountId: '',
  metric: 'revenue',
  scope: 'CFS',
  status: 'CANDIDATE',
  sourceUrl: '',
  details: { rationale: '' },
};

export function AnalysisMappingEditor({
  actor,
  candidates,
}: {
  actor: string;
  candidates: AnalysisMapping[];
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<AnalysisMappingInput>(emptyMapping);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const save = useMutation({
    mutationFn: analysisApi.saveMapping,
    onSuccess: (mapping) => {
      setNotice(
        `계정 검토 결과를 버전 ${mapping.version}에 저장했습니다. 기존 실행 결과는 유지됩니다.`,
      );
      setDraft(emptyMapping);
      void client.invalidateQueries({ queryKey: ['analysis-mappings', actor] });
    },
  });
  const update = (value: Partial<AnalysisMappingInput>) =>
    setDraft((old) => ({ ...old, ...value }));
  const submit = (input: AnalysisMappingInput) => {
    const url = analysisSourceUrl(input.sourceUrl);
    if (!url?.startsWith('https://') || !input.details.rationale.trim()) {
      setError('HTTPS 공식 근거 주소와 매핑 판단 이유를 입력하세요.');
      return;
    }
    const parsed = analysisMappingSchema.safeParse(input);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setError(null);
    setNotice('');
    save.mutate(parsed.data);
  };
  const fromCandidate = (
    mapping: AnalysisMapping,
    status = mapping.status,
  ): AnalysisMappingInput => ({
    source: mapping.source,
    taxonomy: mapping.taxonomy,
    accountId: mapping.accountId,
    metric: mapping.metric,
    scope: mapping.scope,
    status,
    sourceUrl: mapping.sourceUrl,
    details: {
      rationale: typeof mapping.details.rationale === 'string' ? mapping.details.rationale : '',
    },
  });
  return (
    <details className="analysis-warning">
      <summary>관리자 계정 매핑 검토</summary>
      <p className="analysis-muted">
        근거와 검토 결과를 새 버전으로 기록합니다. 이미 완료된 분석의 숫자와 매핑 근거는 바뀌지
        않습니다.
      </p>
      {candidates.length ? (
        <ul className="analysis-list">
          {candidates.map((mapping) => (
            <li key={mapping.id}>
              <strong>
                {mapping.accountId} → {analysisMetricLabels[mapping.metric]}
              </strong>
              <p className="analysis-muted">
                {mapping.source} · {mapping.taxonomy} · {mapping.scope} · 후보 버전{' '}
                {mapping.version}
              </p>
              <div className="analysis-toolbar">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setDraft(fromCandidate(mapping));
                    setError(null);
                  }}
                >
                  근거 편집
                </Button>
                <Button
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => submit(fromCandidate(mapping, 'CONFIRMED'))}
                >
                  매핑 확인
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={save.isPending}
                  onClick={() => submit(fromCandidate(mapping, 'REJECTED'))}
                >
                  매핑 미적용
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="analysis-filters"
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
      >
        <label>
          자료 출처
          <Select
            value={draft.source}
            onChange={(e) => update({ source: e.target.value as AnalysisMappingInput['source'] })}
          >
            <option value="OPENDART">OpenDART</option>
            <option value="SEC">SEC</option>
          </Select>
        </label>
        <label>
          택사노미
          <Input
            required
            value={draft.taxonomy}
            maxLength={80}
            onChange={(e) => update({ taxonomy: e.target.value })}
          />
        </label>
        <label>
          원문 계정 태그
          <Input
            required
            value={draft.accountId}
            maxLength={255}
            onChange={(e) => update({ accountId: e.target.value })}
          />
        </label>
        <label>
          비교 지표
          <Select
            value={draft.metric}
            onChange={(e) => update({ metric: e.target.value as AnalysisMappingInput['metric'] })}
          >
            {Object.entries(analysisMetricLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <label>
          매핑 재무제표
          <Select
            value={draft.scope}
            onChange={(e) => update({ scope: e.target.value as AnalysisMappingInput['scope'] })}
          >
            <option value="CFS">연결</option>
            <option value="OFS">별도</option>
            <option value="UNKNOWN">확인 전</option>
          </Select>
        </label>
        <label>
          검토 결과
          <Select
            value={draft.status}
            onChange={(e) => update({ status: e.target.value as AnalysisMappingInput['status'] })}
          >
            <option value="CANDIDATE">검토 후보</option>
            <option value="CONFIRMED">확인됨</option>
            <option value="REJECTED">미적용</option>
          </Select>
        </label>
        <label className="analysis-wide">
          공식 근거 주소
          <Input
            required
            type="url"
            placeholder="https://"
            value={draft.sourceUrl}
            maxLength={2048}
            onChange={(e) => update({ sourceUrl: e.target.value })}
          />
        </label>
        <label className="analysis-wide">
          판단 이유
          <Input
            required
            value={draft.details.rationale}
            maxLength={2000}
            onChange={(e) => update({ details: { rationale: e.target.value } })}
          />
        </label>
        <div className="analysis-wide">
          <Button type="submit" disabled={save.isPending}>
            매핑 검토 저장
          </Button>
        </div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {save.isError ? <ErrorState message={analysisError(save.error)} /> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </details>
  );
}
