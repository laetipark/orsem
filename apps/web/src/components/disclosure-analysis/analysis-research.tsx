import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  AnalysisRun,
  AnalysisExportRequest,
  AnalysisSelection,
  FinancialFact,
  SavedAnalysisQuery,
} from '@orsem/contracts';
import { analysisApi, analysisMetricLabels } from '../../lib/disclosure-analysis-api';
import {
  analysisError,
  analysisNumber,
  analysisSourceUrl,
  analysisStatus,
} from '../../lib/disclosure-analysis-display';
import { formatKst } from '../../lib/format';
import { Badge, Button, EmptyState, ErrorState, Input, LoadingState } from '../ui';
import { AnalysisMappingEditor } from './analysis-mapping-editor';

export function AnalysisSavedQueries({
  actor,
  selection,
  onRun,
  onSelection,
}: {
  actor: string;
  selection: AnalysisSelection;
  onRun: (run: AnalysisRun) => void;
  onSelection: (selection: AnalysisSelection) => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(''),
    [autoRefresh, setAutoRefresh] = useState(false),
    [historyId, setHistoryId] = useState('');
  const saved = useQuery({
    queryKey: ['analysis-saved', actor],
    queryFn: ({ signal }) => analysisApi.saved(signal),
  });
  const history = useQuery({
    queryKey: ['analysis-runs', actor, historyId],
    queryFn: ({ signal }) => analysisApi.runs(historyId || undefined, signal),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['analysis-saved', actor] });
  };
  const save = useMutation({
    mutationFn: () => analysisApi.save({ name: name.trim(), selection, autoRefresh }),
    onSuccess: () => {
      setName('');
      setAutoRefresh(false);
      refresh();
    },
  });
  const edit = useMutation({
    mutationFn: (query: SavedAnalysisQuery) =>
      analysisApi.updateSaved(query.id, {
        name: query.name,
        selection: query.selection,
        autoRefresh: !query.autoRefresh,
      }),
    onSuccess: refresh,
  });
  const updateSelection = useMutation({
    mutationFn: (query: SavedAnalysisQuery) =>
      analysisApi.updateSaved(query.id, {
        name: query.name,
        selection,
        autoRefresh: query.autoRefresh,
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: analysisApi.deleteSaved, onSuccess: refresh });
  const execute = useMutation({
    mutationFn: analysisApi.runSaved,
    onSuccess: (run) => {
      onRun(run);
      void client.invalidateQueries({ queryKey: ['analysis-runs', actor] });
    },
  });
  const error = save.error ?? edit.error ?? updateSelection.error ?? remove.error ?? execute.error;
  return (
    <div className="page-stack">
      <h3>내 조회 조건</h3>
      <p className="analysis-muted">
        저장한 조건과 갱신 이력은 본인만 볼 수 있습니다. 그룹을 선택한 조건은 갱신할 때 접근 권한을
        다시 확인합니다.
      </p>
      <form
        className="analysis-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="analysis-field">
          조회 이름
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 반도체 3개년 재무"
            required
          />
        </label>
        <label className="analysis-checkbox">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          새 자료 자동 갱신
        </label>
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          현재 조건 저장
        </Button>
      </form>
      {error ? <ErrorState message={analysisError(error)} /> : null}
      {saved.isPending ? (
        <LoadingState label="저장한 조건을 불러오는 중입니다." />
      ) : saved.isError ? (
        <ErrorState message={analysisError(saved.error)} onRetry={() => void saved.refetch()} />
      ) : (
        <ul className="analysis-list">
          {saved.data.items.map((query) => (
            <li key={query.id}>
              <header>
                <strong>{query.name}</strong>
                <Badge>{query.autoRefresh ? '자동 갱신 켜짐' : '수동 갱신'}</Badge>
              </header>
              <div className="analysis-toolbar">
                <Button size="sm" variant="secondary" onClick={() => onSelection(query.selection)}>
                  조건 불러오기
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={updateSelection.isPending}
                  onClick={() => updateSelection.mutate(query)}
                >
                  현재 비교 조건으로 변경
                </Button>
                <Button
                  size="sm"
                  disabled={execute.isPending}
                  onClick={() => execute.mutate(query.id)}
                >
                  지금 갱신
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={edit.isPending}
                  onClick={() => edit.mutate(query)}
                >
                  {query.autoRefresh ? '자동 갱신 끄기' : '자동 갱신 켜기'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setHistoryId(query.id)}>
                  갱신 이력
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(query.id)}
                >
                  조건 삭제
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="analysis-toolbar">
        <h3>{historyId ? '선택한 조건의 갱신 이력' : '내 분석 이력'}</h3>
        {historyId ? (
          <Button size="sm" variant="ghost" onClick={() => setHistoryId('')}>
            전체 이력
          </Button>
        ) : null}
      </div>
      {history.isPending ? (
        <LoadingState label="분석 이력을 불러오는 중입니다." />
      ) : history.isError ? (
        <ErrorState message={analysisError(history.error)} />
      ) : history.data.items.length ? (
        <ul className="analysis-list">
          {history.data.items.map((run) => (
            <li key={run.id}>
              <header>
                <span>{formatKst(run.createdAt)}</span>
                <Badge>{analysisStatus(run.status)}</Badge>
              </header>
              <div className="analysis-toolbar">
                <span>
                  기업 {run.companyIds.length}개 · {run.selection.scope === 'CFS' ? '연결' : '별도'}{' '}
                  · {run.selection.metrics.length}개 항목
                </span>
                <Button variant="secondary" size="sm" onClick={() => onRun(run)}>
                  당시 결과 열기
                </Button>
              </div>
              {run.errorMessage ? <p>{run.errorMessage}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="저장된 분석 이력이 없습니다" />
      )}
    </div>
  );
}

export function AnalysisNotes({
  run,
  actor,
  onDocument,
  onExport,
}: {
  run: AnalysisRun;
  actor: string;
  onDocument: (id: string) => void;
  onExport: (options: Partial<AnalysisExportRequest>) => void;
}) {
  const client = useQueryClient();
  const [text, setText] = useState(''),
    [search, setSearch] = useState(''),
    [comparison, setComparison] = useState<string[]>([]);
  const notes = useQuery({
    queryKey: ['analysis-notes', actor, run.id, search],
    queryFn: ({ signal }) => analysisApi.notes(run.id, search, signal),
  });
  const bookmarks = useQuery({
    queryKey: ['analysis-bookmarks', actor],
    queryFn: ({ signal }) => analysisApi.bookmarks(signal),
  });
  const save = useMutation({
    mutationFn: analysisApi.bookmark,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['analysis-bookmarks', actor] });
    },
  });
  const remove = useMutation({
    mutationFn: analysisApi.deleteBookmark,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['analysis-bookmarks', actor] });
    },
  });
  const selected = notes.data?.items.filter((note) => comparison.includes(note.id)) ?? [];
  const exportDocumentIds = [
    ...new Set(
      (selected.length ? selected : (notes.data?.items ?? [])).map((note) => note.documentId),
    ),
  ];
  return (
    <div className="page-stack">
      <form
        className="analysis-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(text.trim());
          setComparison([]);
        }}
      >
        <label className="analysis-field">
          주석 검색
          <Input
            placeholder="재고자산, 차입금, 사업부 매출 등"
            value={text}
            maxLength={200}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <Button type="submit">검색</Button>
      </form>
      <p className="analysis-muted">
        이번 분석에서 추출한 원문 주석을 검색합니다. 두 주석을 선택하면 나란히 비교할 수 있습니다.
      </p>
      {notes.data?.items.length ? (
        <div className="analysis-toolbar">
          <Button
            size="sm"
            variant="secondary"
            disabled={exportDocumentIds.length > 20}
            onClick={() => onExport({ documentIds: exportDocumentIds, includeNotes: true })}
          >
            {selected.length ? '선택한 주석의 원문 XLSX' : '조회한 주석의 원문 XLSX'}
          </Button>
          {exportDocumentIds.length > 20 ? (
            <span className="analysis-muted">
              내려받을 주석을 선택해 원문을 20개 이하로 줄여 주세요.
            </span>
          ) : null}
        </div>
      ) : null}
      {save.isError || remove.isError ? (
        <ErrorState message={analysisError(save.error ?? remove.error)} />
      ) : null}
      {notes.isPending ? (
        <LoadingState label="주석을 검색하는 중입니다." />
      ) : notes.isError ? (
        <ErrorState message={analysisError(notes.error)} onRetry={() => void notes.refetch()} />
      ) : notes.data.items.length ? (
        <ul className="analysis-list">
          {notes.data.items.map((note) => {
            const url = analysisSourceUrl(note.sourceUrl);
            const saved = bookmarks.data?.items.find((item) => item.noteId === note.id);
            return (
              <li key={note.id}>
                <header>
                  <label className="analysis-checkbox">
                    <input
                      type="checkbox"
                      checked={comparison.includes(note.id)}
                      disabled={comparison.length >= 2 && !comparison.includes(note.id)}
                      onChange={(e) =>
                        setComparison((old) =>
                          e.target.checked ? [...old, note.id] : old.filter((id) => id !== note.id),
                        )
                      }
                    />
                    {note.title}
                  </label>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={save.isPending || remove.isPending}
                    onClick={() =>
                      saved
                        ? remove.mutate(saved.id)
                        : save.mutate({
                            documentId: note.documentId,
                            noteId: note.id,
                            label: note.title.slice(0, 160),
                            anchor: { text: note.text.slice(0, 1000) },
                          })
                    }
                  >
                    {saved ? '북마크 해제' : '북마크'}
                  </Button>
                </header>
                <details>
                  <summary>주석 내용 보기</summary>
                  <p className="analysis-note">{note.text}</p>
                </details>
                <div className="analysis-toolbar">
                  <Button size="sm" variant="secondary" onClick={() => onDocument(note.documentId)}>
                    원문 표로 이동
                  </Button>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      공식 원문
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState
          title="검색된 주석이 없습니다"
          description="원문과 표 탭에서 원문을 가져오거나 검색어를 바꿔 주세요."
        />
      )}
      {selected.length === 2 ? (
        <section aria-label="주석 나란히 비교">
          <h3>선택한 주석 비교</h3>
          <div className="analysis-split">
            {selected.map((note) => (
              <article className="analysis-note" key={note.id}>
                <h4>{note.title}</h4>
                <p>{note.text}</p>
                <Button size="sm" variant="secondary" onClick={() => onDocument(note.documentId)}>
                  이 주석의 원문
                </Button>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <h3>내 북마크</h3>
      {bookmarks.isError ? (
        <ErrorState message={analysisError(bookmarks.error)} />
      ) : (
        <ul className="analysis-list">
          {bookmarks.data?.items.map((bookmark) => (
            <li key={bookmark.id}>
              <header>
                <strong>{bookmark.label}</strong>
                {bookmark.needsRelink ? (
                  <Badge tone="orange">새 제출본 연결 확인 필요</Badge>
                ) : null}
              </header>
              <div className="analysis-toolbar">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onDocument(bookmark.documentId)}
                >
                  저장한 원문 열기
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(bookmark.id)}
                >
                  북마크 삭제
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AnalysisVerification({
  run,
  actor,
  onSelect,
  isAdmin = false,
}: {
  run: AnalysisRun;
  actor: string;
  onSelect: (fact: FinancialFact) => void;
  isAdmin?: boolean;
}) {
  const [search, setSearch] = useState('');
  const mappings = useQuery({
    queryKey: ['analysis-mappings', actor],
    queryFn: ({ signal }) => analysisApi.mappings(signal),
  });
  const validations = run.result?.validations ?? [];
  const relevant =
    mappings.data?.items.filter(
      (mapping) =>
        !search.trim() ||
        `${mapping.accountId} ${analysisMetricLabels[mapping.metric]} ${mapping.taxonomy}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    ) ?? [];
  return (
    <div className="page-stack">
      <h3>재무 정합성 검사</h3>
      <p className="analysis-muted">
        불일치는 원문의 오류를 확정하는 판정이 아닙니다. 적용한 공식·단위·허용오차와 원문을 함께
        확인하세요.
      </p>
      {validations.length ? (
        <ul className="analysis-list">
          {validations.map((check) => (
            <li key={check.id}>
              <header>
                <strong>{check.message}</strong>
                <Badge
                  tone={
                    check.status === 'PASS'
                      ? 'teal'
                      : check.status === 'REVIEW'
                        ? 'orange'
                        : 'neutral'
                  }
                >
                  {
                    {
                      PASS: '일치',
                      ROUNDING: '반올림 범위',
                      REVIEW: '확인 필요',
                      UNAVAILABLE: '자료 부족',
                    }[check.status]
                  }
                </Badge>
              </header>
              <p>{check.formula}</p>
              <p className="analysis-muted">
                입력값 {check.values.map(analysisNumber).join(' · ')} · 허용오차{' '}
                {analysisNumber(check.tolerance)} · 규칙 {check.rule} / {check.ruleVersion}
              </p>
              <div className="analysis-toolbar">
                {check.factIds.map((id) => {
                  const fact = run.result?.facts.find((item) => item.id === id);
                  return fact ? (
                    <Button key={id} variant="secondary" size="sm" onClick={() => onSelect(fact)}>
                      {analysisMetricLabels[fact.metric]} 근거
                    </Button>
                  ) : null;
                })}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="아직 검증 결과가 없습니다"
          description="검증에 필요한 같은 범위·기간·단위의 수치가 확보되면 결과가 표시됩니다."
        />
      )}
      <h3>계정 매핑 근거</h3>
      <p className="analysis-muted">
        이 실행의 매핑 기준: {run.result?.mappingVersion ?? '확인 전'}. 아래 목록은 현재 검토된 계정
        사전입니다. 개별 숫자의 당시 매핑 버전은 근거에서 확인할 수 있습니다.
      </p>
      {isAdmin ? (
        <AnalysisMappingEditor
          actor={actor}
          candidates={(mappings.data?.items ?? []).filter(
            (mapping) => mapping.status === 'CANDIDATE',
          )}
        />
      ) : null}
      <label className="analysis-field">
        계정 검색
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="원문 계정 또는 비교 지표"
        />
      </label>
      {mappings.isPending ? (
        <LoadingState label="계정 매핑을 확인하는 중입니다." />
      ) : mappings.isError ? (
        <ErrorState message={analysisError(mappings.error)} />
      ) : (
        <ul className="analysis-list">
          {relevant.map((mapping) => {
            const url = analysisSourceUrl(mapping.sourceUrl);
            return (
              <li key={mapping.id}>
                <header>
                  <strong>
                    {mapping.accountId} → {analysisMetricLabels[mapping.metric]}
                  </strong>
                  <Badge>
                    {
                      { CANDIDATE: '검토 후보', CONFIRMED: '확인됨', REJECTED: '미적용' }[
                        mapping.status
                      ]
                    }
                  </Badge>
                </header>
                <p className="analysis-muted">
                  {mapping.source} · {mapping.taxonomy} · {mapping.scope} · 버전 {mapping.version}
                </p>
                {typeof mapping.details.rationale === 'string' ? (
                  <p>{mapping.details.rationale}</p>
                ) : null}
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    매핑 원문 근거
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
