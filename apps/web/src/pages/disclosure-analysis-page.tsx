import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import {
  analysisSelectionSchema,
  type AnalysisExportRequest,
  type AnalysisRun,
  type FinancialFact,
} from '@orsem/contracts';
import { AnalysisSelectionForm } from '../components/disclosure-analysis/analysis-selection';
import {
  AnalysisComparison,
  AnalysisEvidence,
  AnalysisIssues,
} from '../components/disclosure-analysis/analysis-comparison';
import {
  AnalysisChanges,
  AnalysisDocuments,
  AnalysisOwnership,
} from '../components/disclosure-analysis/analysis-documents';
import {
  AnalysisNotes,
  AnalysisSavedQueries,
  AnalysisVerification,
} from '../components/disclosure-analysis/analysis-research';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  Progress,
} from '../components/ui';
import {
  analysisApi,
  analysisPending,
  defaultAnalysisSelection,
} from '../lib/disclosure-analysis-api';
import { analysisError, analysisStatus } from '../lib/disclosure-analysis-display';
import { formatKst } from '../lib/format';
import type { Session } from '../types';
import './disclosure-analysis.css';

const tabs = [
  ['compare', '재무 비교'],
  ['documents', '원문과 표'],
  ['changes', '변경 내역'],
  ['notes', '주석·북마크'],
  ['verification', '검증·계정 근거'],
  ['ownership', '미국 내부자 지분'],
  ['saved', '내 조회·이력'],
] as const;
type Tab = (typeof tabs)[number][0];

export function DisclosureAnalysisPage() {
  const session = useOutletContext<Session | undefined>();
  const actor = `${session?.user?.role ?? 'account'}:${session?.user?.id ?? ''}`;
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const runId = params.get('run') ?? '',
    exportId = params.get('export') ?? '';
  const requestedTab = params.get('tab');
  const tab: Tab = tabs.some(([key]) => key === requestedTab) ? (requestedTab as Tab) : 'compare';
  const [selection, setSelection] = useState(() =>
    defaultAnalysisSelection(params.getAll('companyId'), params.get('groupId') ?? undefined),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [fact, setFact] = useState<FinancialFact | null>(null);
  const [documentId, setDocumentId] = useState(params.get('document') ?? '');
  const hydratedRun = useRef('');
  const capability = useQuery({
    queryKey: ['analysis-capabilities', actor],
    queryFn: ({ signal }) => analysisApi.capabilities(signal),
  });
  const runQuery = useQuery({
    queryKey: ['analysis-run', actor, runId],
    queryFn: ({ signal }) => analysisApi.run(runId, signal),
    enabled: Boolean(runId) && capability.data?.enabled === true,
    refetchInterval: (query) =>
      query.state.data?.status === 'WAITING'
        ? 15000
        : analysisPending(query.state.data?.status)
          ? 3000
          : false,
  });
  const run = runQuery.data;
  useEffect(() => {
    if (run && hydratedRun.current !== run.id) {
      hydratedRun.current = run.id;
      setSelection(run.selection);
      setFact(null);
    }
  }, [run]);
  const setTab = (tab: Tab) =>
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.set('tab', tab);
      return next;
    });
  const openRun = (nextRun: AnalysisRun) => {
    client.setQueryData(['analysis-run', actor, nextRun.id], nextRun);
    setSelection(nextRun.selection);
    setDocumentId('');
    setFact(null);
    setFormError(null);
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.set('run', nextRun.id);
      const isEntryCompany = nextRun.companyIds.includes(old.get('companyId') ?? '');
      next.set('tab', old.has('eventId') && isEntryCompany ? 'documents' : 'compare');
      if (!isEntryCompany) next.delete('eventId');
      next.delete('export');
      next.delete('document');
      return next;
    });
    void client.invalidateQueries({ queryKey: ['analysis-runs', actor] });
  };
  const create = useMutation({ mutationFn: analysisApi.createRun, onSuccess: openRun });
  const retry = useMutation({ mutationFn: () => analysisApi.retry(runId), onSuccess: openRun });
  const createExport = useMutation({
    mutationFn: (options: Partial<AnalysisExportRequest>) => analysisApi.export(runId, options),
    onSuccess: (manifest) => {
      client.setQueryData(['analysis-export', actor, manifest.id], manifest);
      setParams((old) => {
        const next = new URLSearchParams(old);
        next.set('export', manifest.id);
        return next;
      });
    },
  });
  const manifest = useQuery({
    queryKey: ['analysis-export', actor, exportId],
    queryFn: ({ signal }) => analysisApi.exportStatus(exportId, signal),
    enabled: Boolean(exportId) && capability.data?.enabled === true,
    refetchInterval: (query) => (analysisPending(query.state.data?.status) ? 3000 : false),
  });
  const selectedDocumentId = documentId || run?.result?.documentIds[0] || '';
  const document = useQuery({
    queryKey: ['analysis-document', actor, selectedDocumentId],
    queryFn: ({ signal }) => analysisApi.document(selectedDocumentId, signal),
    enabled: tab === 'ownership' && Boolean(selectedDocumentId),
    refetchInterval: (query) => (analysisPending(query.state.data?.status) ? 3000 : false),
  });
  const selectDocument = (id: string) => {
    setDocumentId(id);
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.set('document', id);
      next.set('tab', 'documents');
      return next;
    });
  };
  const submit = () => {
    const parsed = analysisSelectionSchema.safeParse(selection);
    if (!parsed.success) {
      setFormError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setFormError(null);
    create.mutate(parsed.data);
  };
  if (capability.isPending) return <LoadingState label="공시 분석실을 준비하는 중입니다." />;
  if (capability.isError)
    return (
      <ErrorState
        message={analysisError(capability.error)}
        onRetry={() => void capability.refetch()}
      />
    );
  if (!capability.data.enabled)
    return (
      <EmptyState
        title="공시 분석실 연결을 준비하고 있습니다"
        description="공식 재무 자료와 분석 저장소가 준비되면 이 화면에서 비교할 수 있습니다."
      />
    );
  const error =
    formError ??
    (create.error ? analysisError(create.error) : null) ??
    (retry.error ? analysisError(retry.error) : null);
  return (
    <div className="analysis-page">
      <header className="analysis-heading">
        <div>
          <h1>공시 분석실</h1>
          <p>기업과 보고기간을 비교하고, 숫자의 원문 근거를 확인하세요.</p>
        </div>
        <div className="analysis-heading-actions">
          {run ? (
            <Button
              variant="secondary"
              disabled={createExport.isPending || !run.result || analysisPending(run.status)}
              onClick={() => createExport.mutate({ includeValidation: true })}
            >
              비교 결과 XLSX
            </Button>
          ) : null}
        </div>
      </header>
      <Card>
        <CardHeader>
          <h2>비교 조건</h2>
        </CardHeader>
        <CardContent>
          <AnalysisSelectionForm
            value={selection}
            onChange={setSelection}
            actor={actor}
            pending={create.isPending}
            onSubmit={submit}
          />
          {error ? (
            <p role="alert" className="analysis-warning">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {runQuery.isError ? (
        <ErrorState
          message={analysisError(runQuery.error)}
          onRetry={() => void runQuery.refetch()}
        />
      ) : null}
      {runId && runQuery.isPending ? (
        <LoadingState label="저장된 분석 결과를 불러오는 중입니다." />
      ) : null}
      {run ? (
        <Card>
          <CardContent className="analysis-progress">
            <div className="analysis-toolbar">
              <Badge
                tone={
                  run.status === 'FAILED' ? 'red' : run.status === 'COMPLETE' ? 'teal' : 'neutral'
                }
              >
                {analysisStatus(run.status)}
              </Badge>
              <span role="status">
                {run.progress.message ??
                  `자료 확인 ${run.progress.completed} / ${run.progress.total}`}
              </span>
              {['PARTIAL', 'FAILED', 'WAITING'].includes(run.status) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={retry.isPending}
                  onClick={() => retry.mutate()}
                >
                  미완료 자료 재시도
                </Button>
              ) : null}
            </div>
            {analysisPending(run.status) ? (
              <Progress
                value={run.progress.total ? (run.progress.completed / run.progress.total) * 100 : 0}
                label="분석 진행률"
              />
            ) : null}
            <small className="analysis-muted">
              실행 {formatKst(run.createdAt)}
              {run.completedAt ? ` · 완료 ${formatKst(run.completedAt)}` : ''}
              {run.nextAttemptAt ? ` · 다음 확인 ${formatKst(run.nextAttemptAt)}` : ''}
            </small>
            {run.errorMessage ? <p role="alert">{run.errorMessage}</p> : null}
            <AnalysisIssues run={run} />
          </CardContent>
        </Card>
      ) : null}
      {createExport.isError ? <ErrorState message={analysisError(createExport.error)} /> : null}
      {manifest.isError ? (
        <ErrorState
          message={analysisError(manifest.error)}
          onRetry={() => void manifest.refetch()}
        />
      ) : null}
      {manifest.data ? (
        <div className="analysis-warning analysis-toolbar" aria-live="polite">
          <span>엑셀 파일 · {analysisStatus(manifest.data.status)}</span>
          {manifest.data.status === 'COMPLETE' ? (
            <a
              className="button button--primary button--sm"
              href={analysisApi.exportUrl(manifest.data.id)}
              download
            >
              준비된 XLSX 내려받기
            </a>
          ) : null}
          {manifest.data.errorMessage ? (
            <span role="alert">{manifest.data.errorMessage}</span>
          ) : null}
          <span className="analysis-muted">조회 조건·원문값·출처를 함께 포함합니다.</span>
        </div>
      ) : null}
      <nav className="analysis-tabs" aria-label="공시 분석 메뉴">
        {tabs.map(([key, label]) => (
          <Button
            key={key}
            variant={tab === key ? 'primary' : 'ghost'}
            size="sm"
            aria-current={tab === key ? 'page' : undefined}
            onClick={() => setTab(key)}
            disabled={
              (['documents', 'changes', 'ownership'].includes(key) && !capability.data.documents) ||
              (key === 'notes' && !capability.data.notes)
            }
          >
            {label}
          </Button>
        ))}
      </nav>
      <div className={`analysis-workspace${fact ? ' has-evidence' : ''}`}>
        <Card>
          <CardContent>
            {tab === 'saved' ? (
              <AnalysisSavedQueries
                actor={actor}
                selection={selection}
                onRun={openRun}
                onSelection={(next) => {
                  setSelection(next);
                  setFormError(null);
                  setTab('compare');
                }}
              />
            ) : (['documents', 'changes', 'ownership'].includes(tab) &&
                !capability.data.documents) ||
              (tab === 'notes' && !capability.data.notes) ? (
              <EmptyState
                title="이 분석 도구의 연결을 준비하고 있습니다"
                description="재무 비교와 내 조회 이력은 계속 사용할 수 있습니다."
              />
            ) : !run ? (
              <EmptyState
                title="비교할 기업과 기간을 선택하세요"
                description="관심기업 여러 곳의 재무를 같은 조건으로 확인할 수 있습니다."
              />
            ) : (
              <>
                {tab === 'compare' ? <AnalysisComparison run={run} onSelect={setFact} /> : null}
                {tab === 'documents' && capability.data.documents ? (
                  <AnalysisDocuments
                    key={run.id}
                    run={run}
                    actor={actor}
                    selectedId={documentId}
                    onSelect={setDocumentId}
                    onExport={(options) => createExport.mutate(options)}
                    entryEventId={params.get('eventId') ?? undefined}
                  />
                ) : null}
                {tab === 'changes' && capability.data.documents ? (
                  <AnalysisChanges
                    key={run.id}
                    run={run}
                    actor={actor}
                    isAdmin={session?.user?.role === 'ADMIN'}
                    onExport={(options) => createExport.mutate(options)}
                  />
                ) : null}
                {tab === 'notes' && capability.data.notes ? (
                  <AnalysisNotes
                    key={run.id}
                    run={run}
                    actor={actor}
                    onDocument={selectDocument}
                    onExport={(options) => createExport.mutate(options)}
                  />
                ) : null}
                {tab === 'verification' ? (
                  <AnalysisVerification
                    run={run}
                    actor={actor}
                    onSelect={setFact}
                    isAdmin={session?.user?.role === 'ADMIN'}
                  />
                ) : null}
                {tab === 'ownership' && capability.data.documents ? (
                  <>
                    {document.isFetching && !document.data ? (
                      <LoadingState label="내부자 지분 자료를 불러오는 중입니다." />
                    ) : document.isError ? (
                      <ErrorState message={analysisError(document.error)} />
                    ) : (
                      <AnalysisOwnership document={document.data} />
                    )}
                    {run.result?.documentIds.length ? (
                      <div className="analysis-toolbar">
                        {run.result.documentIds.map((id, index) => (
                          <Button
                            key={id}
                            size="sm"
                            variant={id === selectedDocumentId ? 'primary' : 'secondary'}
                            onClick={() => setDocumentId(id)}
                          >
                            원문 {index + 1}
                          </Button>
                        ))}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!document.data?.ownership || createExport.isPending}
                          onClick={() =>
                            createExport.mutate({
                              documentIds: [selectedDocumentId],
                              includeOwnership: true,
                            })
                          }
                        >
                          지분 상세 XLSX
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
        {fact ? (
          <AnalysisEvidence fact={fact} onClose={() => setFact(null)} onDocument={selectDocument} />
        ) : null}
      </div>
    </div>
  );
}
