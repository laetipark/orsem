import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AnalysisDiff } from '@orsem/contracts';
import { analysisApi } from '../../lib/disclosure-analysis-api';
import { analysisError, analysisSourceUrl } from '../../lib/disclosure-analysis-display';
import { formatKst } from '../../lib/format';
import { Button, ErrorState, Input } from '../ui';

export function AnalysisDiffConfirmation({
  diff,
  actor,
  runId,
  isAdmin,
}: {
  diff: AnalysisDiff;
  actor: string;
  runId: string;
  isAdmin: boolean;
}) {
  const client = useQueryClient();
  const [sourceUrl, setSourceUrl] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const confirm = useMutation({
    mutationFn: () =>
      analysisApi.confirmDiff(diff.id, { runId, sourceUrl: sourceUrl.trim(), note: note.trim() }),
    onSuccess: (next) => {
      client.setQueryData(['analysis-diff', actor, diff.id], next);
      void client.invalidateQueries({ queryKey: ['analysis-run', actor, runId] });
    },
  });
  if (diff.confirmation) {
    const url = analysisSourceUrl(diff.confirmation.sourceUrl);
    return (
      <div className="analysis-warning">
        <strong>관리자가 공식 근거로 정정 관계를 확인했습니다.</strong>
        <p>{diff.confirmation.note}</p>
        <small>{formatKst(diff.confirmation.reviewedAt)}</small>
        {url ? (
          <p>
            <a href={url} target="_blank" rel="noopener noreferrer">
              정정 관계 확인 근거
            </a>
          </p>
        ) : null}
      </div>
    );
  }
  if (!isAdmin || diff.confirmed || !['WAITING', 'PARTIAL', 'QUEUED'].includes(diff.status))
    return null;
  return (
    <details className="analysis-warning">
      <summary>관리자 정정 관계 확인</summary>
      <p>
        이전·이후 문서의 정정 관계를 공식 공시에서 확인한 경우에만 근거를 기록하세요. 확인 후 변경
        비교를 다시 계산합니다.
      </p>
      <form
        className="analysis-filters"
        onSubmit={(event) => {
          event.preventDefault();
          const url = analysisSourceUrl(sourceUrl.trim());
          if (!url?.startsWith('https://') || !note.trim()) {
            setError('HTTPS 공식 공시 주소와 정정 관계를 확인한 이유를 입력하세요.');
            return;
          }
          setError('');
          confirm.mutate();
        }}
      >
        <label className="analysis-wide">
          정정 관계 공식 근거 주소
          <Input
            required
            type="url"
            value={sourceUrl}
            maxLength={2048}
            placeholder="https://www.sec.gov/Archives/..."
            onChange={(event) => setSourceUrl(event.target.value)}
          />
        </label>
        <label className="analysis-wide">
          정정 관계 확인 이유
          <Input
            required
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="analysis-wide">
          <Button type="submit" disabled={confirm.isPending}>
            정정 관계 확인 후 다시 비교
          </Button>
        </div>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {confirm.isError ? <ErrorState message={analysisError(confirm.error)} /> : null}
    </details>
  );
}
