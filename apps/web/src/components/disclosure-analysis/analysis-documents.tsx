import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type {
  AnalysisDocument,
  AnalysisExportRequest,
  AnalysisRun,
  AnalysisTable,
  SecOwnershipDetail,
} from '@orsem/contracts';
import {
  analysisApi,
  analysisPending,
  analysisPeriodLabels,
} from '../../lib/disclosure-analysis-api';
import {
  analysisError,
  analysisNumber,
  analysisSourceUrl,
  analysisStatus,
} from '../../lib/disclosure-analysis-display';
import { Badge, Button, EmptyState, ErrorState, LoadingState, Select } from '../ui';
import { AnalysisDiffConfirmation } from './analysis-diff-confirmation';

export function AnalysisTableView({ table }: { table: AnalysisTable }) {
  const rows = new Map<number, AnalysisTable['cells']>();
  for (const cell of table.cells) rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell]);
  return (
    <div className="analysis-table-wrap">
      <table className="analysis-table analysis-table--document">
        <caption>{table.title}</caption>
        <tbody>
          {[...rows]
            .sort(([a], [b]) => a - b)
            .map(([row, cells]) => (
              <tr key={row}>
                {cells
                  .sort((a, b) => a.column - b.column)
                  .map((cell) => (
                    <td
                      key={cell.column}
                      rowSpan={Math.max(1, Math.min(cell.rowSpan ?? 1, table.rowCount))}
                      colSpan={Math.max(1, Math.min(cell.colSpan ?? 1, table.columnCount))}
                      data-row={row}
                      data-column={cell.column}
                    >
                      {cell.text}
                    </td>
                  ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function AnalysisDocuments({
  run,
  actor,
  selectedId,
  onSelect,
  onExport,
  entryEventId,
}: {
  run: AnalysisRun;
  actor: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onExport: (options: Partial<AnalysisExportRequest>) => void;
  entryEventId?: string;
}) {
  const client = useQueryClient();
  const [reportId, setReportId] = useState(run.result?.reportIds[0] ?? '');
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const [tableIds, setTableIds] = useState<string[]>([]);
  const ids = [
    ...new Set([
      ...(run.result?.documentIds ?? []),
      ...createdIds,
      ...(selectedId ? [selectedId] : []),
    ]),
  ];
  const documentId = selectedId || ids[0] || '';
  const query = useQuery({
    queryKey: ['analysis-document', actor, documentId],
    queryFn: ({ signal }) => analysisApi.document(documentId, signal),
    enabled: Boolean(documentId),
    refetchInterval: (query) => (analysisPending(query.state.data?.status) ? 3000 : false),
  });
  useEffect(() => {
    if (query.data && !analysisPending(query.data.status))
      void client.invalidateQueries({ queryKey: ['analysis-run', actor, run.id] });
  }, [query.data?.id, query.data?.status, actor, run.id, client]);
  const create = useMutation({
    mutationFn: (value: { reportId?: string; eventId?: string }) =>
      analysisApi.createDocument({ runId: run.id, ...value }),
    onSuccess: (document) => {
      setCreatedIds((old) => [...old, document.id]);
      onSelect(document.id);
      setTableIds([]);
      client.setQueryData(['analysis-document', actor, document.id], document);
      void client.invalidateQueries({ queryKey: ['analysis-run', actor, run.id] });
    },
  });
  const reports = run.result?.reportIds ?? [];
  const reportLabel = (id: string) => {
    const fact = run.result?.facts.find((fact) => fact.reportId === id);
    return fact
      ? `${fact.companyName ?? '기업'} · ${fact.reportYear} ${analysisPeriodLabels[fact.reportCode]} · ${fact.evidence.filingId}`
      : `제출본 ${reports.indexOf(id) + 1}`;
  };
  const document = query.data;
  const url = analysisSourceUrl(document?.sourceUrl);
  return (
    <div className="page-stack">
      <div className="analysis-toolbar">
        <label className="analysis-field">
          제출본
          <Select value={reportId} onChange={(e) => setReportId(e.target.value)}>
            <option value="">제출본 선택</option>
            {reports.map((id) => (
              <option key={id} value={id}>
                {reportLabel(id)}
              </option>
            ))}
          </Select>
        </label>
        <Button
          size="sm"
          disabled={!reportId || create.isPending}
          onClick={() => create.mutate({ reportId })}
        >
          원문 표 가져오기
        </Button>
        {entryEventId ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={create.isPending}
            onClick={() => create.mutate({ eventId: entryEventId })}
          >
            선택한 공시 원문 가져오기
          </Button>
        ) : null}
      </div>
      {create.isError ? <ErrorState message={analysisError(create.error)} /> : null}
      {ids.length ? (
        <label className="analysis-field">
          보관된 원문
          <Select
            value={documentId}
            onChange={(e) => {
              onSelect(e.target.value);
              setTableIds([]);
            }}
          >
            {ids.map((id, index) => (
              <option key={id} value={id}>
                {id === document?.id && document.reportId
                  ? reportLabel(document.reportId)
                  : `원문 ${index + 1}`}
              </option>
            ))}
          </Select>
        </label>
      ) : (
        <EmptyState
          title="원문을 선택해 주세요"
          description="비교에 사용한 제출본을 선택하면 원문 표와 추출 결과를 함께 확인할 수 있습니다."
        />
      )}
      {query.isFetching && !document ? (
        <LoadingState label="공시 원문을 확인하는 중입니다." />
      ) : null}
      {query.isError ? (
        <ErrorState message={analysisError(query.error)} onRetry={() => void query.refetch()} />
      ) : null}
      {document ? (
        <>
          <div className="analysis-toolbar">
            <Badge>{analysisStatus(document.status)}</Badge>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer">
                공식 원문 열기
              </a>
            ) : null}
            {analysisPending(document.status) ? (
              <span role="status">표 추출이 끝나면 자동으로 표시됩니다.</span>
            ) : null}
          </div>
          {document.errorMessage ? (
            <p className="analysis-warning" role="alert">
              {document.errorMessage}
            </p>
          ) : null}
          {document.tables.length ? (
            <>
              <div className="analysis-toolbar">
                <span>내려받을 표 선택</span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!tableIds.length}
                  onClick={() => onExport({ documentIds: [document.id], tableIds })}
                >
                  선택한 표 XLSX
                </Button>
              </div>
              {document.tables.map((table) => (
                <section key={table.id}>
                  <label className="analysis-checkbox">
                    <input
                      type="checkbox"
                      checked={tableIds.includes(table.id)}
                      disabled={tableIds.length >= 100 && !tableIds.includes(table.id)}
                      onChange={(e) =>
                        setTableIds((ids) =>
                          e.target.checked
                            ? [...ids, table.id]
                            : ids.filter((id) => id !== table.id),
                        )
                      }
                    />
                    {table.title}
                    {table.section ? ` · ${table.section}` : ''}
                  </label>
                  <AnalysisTableView table={table} />
                </section>
              ))}
            </>
          ) : !analysisPending(document.status) ? (
            <p className="analysis-warning">추출된 표가 없습니다. 공식 원문에서 확인해 주세요.</p>
          ) : null}
          <details>
            <summary>원문 확인 정보</summary>
            <p className="analysis-muted">
              추출 버전 {document.parserVersion} · {document.rightsMode}
            </p>
            <p className="analysis-mapping">{document.sha256}</p>
          </details>
        </>
      ) : null}
    </div>
  );
}

export function AnalysisChanges({
  run,
  actor,
  onExport,
  isAdmin = false,
}: {
  run: AnalysisRun;
  actor: string;
  onExport: (options: Partial<AnalysisExportRequest>) => void;
  isAdmin?: boolean;
}) {
  const client = useQueryClient();
  const [before, setBefore] = useState(''),
    [after, setAfter] = useState(''),
    [diffId, setDiffId] = useState(run.result?.diffIds[0] ?? '');
  const create = useMutation({
    mutationFn: () => analysisApi.createDiff(run.id, before, after),
    onSuccess: (diff) => {
      setDiffId(diff.id);
      void client.invalidateQueries({ queryKey: ['analysis-run', actor, run.id] });
    },
  });
  const diff = useQuery({
    queryKey: ['analysis-diff', actor, diffId],
    queryFn: ({ signal }) => analysisApi.diff(diffId, signal),
    enabled: Boolean(diffId),
    refetchInterval: (query) => (analysisPending(query.state.data?.status) ? 3000 : false),
  });
  useEffect(() => {
    if (diff.data && !analysisPending(diff.data.status))
      void client.invalidateQueries({ queryKey: ['analysis-run', actor, run.id] });
  }, [diff.data?.id, diff.data?.status, actor, run.id, client]);
  const documents = run.result?.documentIds ?? [];
  return (
    <div className="page-stack">
      <p className="analysis-muted">
        확인된 정정 계보만 변경 비교를 제공합니다. 서로 다른 기간은 기간 비교로 구분됩니다.
      </p>
      <div className="analysis-toolbar">
        <label className="analysis-field">
          이전 원문
          <Select value={before} onChange={(e) => setBefore(e.target.value)}>
            <option value="">선택</option>
            {documents.map((id, i) => (
              <option key={id} value={id}>
                원문 {i + 1}
              </option>
            ))}
          </Select>
        </label>
        <label className="analysis-field">
          이후 원문
          <Select value={after} onChange={(e) => setAfter(e.target.value)}>
            <option value="">선택</option>
            {documents.map((id, i) => (
              <option key={id} value={id}>
                원문 {i + 1}
              </option>
            ))}
          </Select>
        </label>
        <Button
          disabled={!before || !after || before === after || create.isPending}
          onClick={() => create.mutate()}
        >
          변경점 확인
        </Button>
      </div>
      {create.isError ? <ErrorState message={analysisError(create.error)} /> : null}
      {(run.result?.diffIds.length ?? 0) > 0 ? (
        <label className="analysis-field">
          이전 비교 결과
          <Select value={diffId} onChange={(e) => setDiffId(e.target.value)}>
            {[...new Set([...(run.result?.diffIds ?? []), ...(diffId ? [diffId] : [])])].map(
              (id, i) => (
                <option key={id} value={id}>
                  변경 비교 {i + 1}
                </option>
              ),
            )}
          </Select>
        </label>
      ) : null}
      {diff.isFetching && !diff.data ? <LoadingState label="변경점을 확인하는 중입니다." /> : null}
      {diff.isError ? (
        <ErrorState message={analysisError(diff.error)} onRetry={() => void diff.refetch()} />
      ) : null}
      {diff.data ? (
        <>
          <Badge>{analysisStatus(diff.data.status)}</Badge>
          {!analysisPending(diff.data.status) && diff.data.status !== 'FAILED' ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                onExport({
                  diffIds: [diff.data!.id],
                  documentIds: [diff.data!.beforeDocumentId, diff.data!.afterDocumentId],
                })
              }
            >
              변경 비교 XLSX
            </Button>
          ) : null}
          {!diff.data.confirmed && !diff.data.confirmation ? (
            <p className="analysis-warning">
              정정 관계가 확인되지 않았습니다. 자동으로 정정 전후 차이로 해석하지 않습니다.
            </p>
          ) : null}
          <AnalysisDiffConfirmation
            key={diff.data.id}
            diff={diff.data}
            actor={actor}
            runId={run.id}
            isAdmin={isAdmin}
          />
          {diff.data.errorMessage ? <p role="alert">{diff.data.errorMessage}</p> : null}
          <div className="analysis-table-wrap">
            <table className="analysis-table">
              <thead>
                <tr>
                  <th>항목</th>
                  <th>이전</th>
                  <th>이후</th>
                  <th>증감</th>
                </tr>
              </thead>
              <tbody>
                {diff.data.differences.map((change, i) => (
                  <tr key={i}>
                    <th>
                      {change.label}
                      <small>
                        {
                          {
                            ADDED: '추가',
                            REMOVED: '삭제',
                            VALUE: '수치',
                            TEXT: '문구',
                            DATE: '날짜',
                            UNIT: '단위',
                            CLASSIFICATION: '분류',
                            REVIEW: '확인 필요',
                          }[change.kind]
                        }
                      </small>
                    </th>
                    <td>{change.before ?? '—'}</td>
                    <td>{change.after ?? '—'}</td>
                    <td>
                      {analysisNumber(change.difference)}
                      {change.percent != null ? ` (${analysisNumber(change.percent)}%)` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!diff.data.differences.length && !analysisPending(diff.data.status) ? (
            <p>확인 가능한 변경 항목이 없습니다.</p>
          ) : null}
        </>
      ) : !documents.length ? (
        <EmptyState
          title="원문 표를 먼저 가져오세요"
          description="비교할 원문 두 개가 준비되면 변경점을 확인할 수 있습니다."
        />
      ) : null}
    </div>
  );
}

const rawText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '해당' : '해당 없음';
  if (value && typeof value === 'object' && 'value' in value) return rawText(value.value);
  return '—';
};
function ownerField(row: Record<string, unknown>, key: string) {
  const direct = row[key];
  if (direct != null) return rawText(direct);
  const raw = row.rawFields;
  return raw && typeof raw === 'object' ? rawText((raw as Record<string, unknown>)[key]) : '—';
}
function ownershipPath(row: Record<string, unknown>, path: string[]): string {
  let value: unknown = row.rawFields ?? row;
  for (const key of path) {
    if (!value || typeof value !== 'object') return '—';
    value = (value as Record<string, unknown>)[key];
  }
  return rawText(value);
}
export function OwnershipFacts({ ownership }: { ownership: SecOwnershipDetail }) {
  const footnotes = Array.isArray(ownership.footnotes)
    ? ownership.footnotes.map((row: Record<string, unknown>) => [
        rawText(row.id),
        rawText(row.text),
      ])
    : Object.entries(ownership.footnotes);
  return (
    <div className="page-stack">
      <h3>SEC Form {ownership.form || rawText(ownership.documentType)}</h3>
      <p className="analysis-warning">
        거래 코드와 각주를 함께 확인하세요. P·S는 공개시장 또는 사적 거래를 포함하며 장내 거래만을
        의미하지 않습니다.
      </p>
      <h4>신고자</h4>
      <ul className="analysis-list">
        {ownership.reportingOwners.map((owner, i) => (
          <li key={i}>
            <strong>{ownerField(owner, 'name')}</strong>
            <p>
              직책 {ownerField(owner, 'officerTitle')} · 이사 {ownerField(owner, 'isDirector')} ·
              임원 {ownerField(owner, 'isOfficer')} · 10% 보유자{' '}
              {ownerField(owner, 'isTenPercentOwner')}
            </p>
          </li>
        ))}
      </ul>
      <h4>거래 내역</h4>
      <div className="analysis-table-wrap">
        <table className="analysis-table">
          <thead>
            <tr>
              <th>거래일</th>
              <th>증권</th>
              <th>코드</th>
              <th>취득·처분</th>
              <th>수량</th>
              <th>가격</th>
              <th>거래 후 보유</th>
              <th>소유 형태</th>
              <th>각주</th>
            </tr>
          </thead>
          <tbody>
            {ownership.transactions.map((transaction, i) => (
              <tr key={i}>
                <td>{ownerField(transaction, 'transactionDate')}</td>
                <td>
                  {ownerField(transaction, 'securityTitle')}
                  <small>{transaction.derivative === true ? '파생증권' : '비파생증권'}</small>
                </td>
                <td>{ownerField(transaction, 'transactionCode')}</td>
                <td>{ownerField(transaction, 'acquiredDisposedCode')}</td>
                <td>{analysisNumber(ownerField(transaction, 'transactionShares'))}</td>
                <td>{analysisNumber(ownerField(transaction, 'transactionPrice'))}</td>
                <td>{analysisNumber(ownerField(transaction, 'sharesOwnedAfter'))}</td>
                <td>{ownerField(transaction, 'directIndirectOwnership')}</td>
                <td>
                  {Array.isArray(transaction.footnoteReferences)
                    ? transaction.footnoteReferences.map(rawText).join(', ')
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!ownership.transactions.length ? (
        <p>추출된 거래 행이 없습니다. 보유 내역과 공식 원문을 함께 확인하세요.</p>
      ) : null}
      <h4>보유 내역 {ownership.holdings.length}건</h4>
      <ul className="analysis-list">
        {ownership.holdings.map((holding, i) => (
          <li key={i}>
            {ownerField(holding, 'securityTitle')} ·{' '}
            {holding.derivative === true ? '파생증권' : '비파생증권'}
            <dl>
              <div>
                <dt>보유 수량</dt>
                <dd>
                  {analysisNumber(
                    ownershipPath(holding, [
                      'postTransactionAmounts',
                      'sharesOwnedFollowingTransaction',
                    ]),
                  )}
                </dd>
              </div>
              <div>
                <dt>직접·간접 소유</dt>
                <dd>{ownershipPath(holding, ['ownershipNature', 'directOrIndirectOwnership'])}</dd>
              </div>
              <div>
                <dt>간접 소유 설명</dt>
                <dd>{ownershipPath(holding, ['ownershipNature', 'natureOfOwnership'])}</dd>
              </div>
              {holding.derivative === true ? (
                <>
                  <div>
                    <dt>기초 증권</dt>
                    <dd>
                      {ownershipPath(holding, ['underlyingSecurity', 'underlyingSecurityTitle'])}
                    </dd>
                  </div>
                  <div>
                    <dt>기초 증권 수량</dt>
                    <dd>
                      {analysisNumber(
                        ownershipPath(holding, ['underlyingSecurity', 'underlyingSecurityShares']),
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>행사 가격</dt>
                    <dd>{ownershipPath(holding, ['conversionOrExercisePrice'])}</dd>
                  </div>
                  <div>
                    <dt>행사 가능일</dt>
                    <dd>{ownershipPath(holding, ['exerciseDate'])}</dd>
                  </div>
                  <div>
                    <dt>만기일</dt>
                    <dd>{ownershipPath(holding, ['expirationDate'])}</dd>
                  </div>
                </>
              ) : null}
              <div>
                <dt>각주</dt>
                <dd>
                  {Array.isArray(holding.footnoteReferences)
                    ? holding.footnoteReferences.map(rawText).join(', ') || '—'
                    : '—'}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <h4>각주</h4>
      {footnotes.map(([id, text]) => (
        <p className="analysis-note" key={id}>
          <strong>{id}</strong> {text}
        </p>
      ))}
      {Array.isArray(ownership.unresolvedFootnoteReferences) &&
      ownership.unresolvedFootnoteReferences.length ? (
        <p className="analysis-warning">
          연결되지 않은 각주: {ownership.unresolvedFootnoteReferences.map(rawText).join(', ')}
        </p>
      ) : null}
    </div>
  );
}

export function AnalysisOwnership({ document }: { document: AnalysisDocument | undefined }) {
  if (!document?.ownership)
    return (
      <EmptyState
        title="내부자 지분 상세 자료가 없습니다"
        description="Form 3·4·5 공시에서 분석실로 진입한 뒤 원문을 가져오면 신고자·거래·보유·각주를 확인할 수 있습니다."
      />
    );
  return <OwnershipFacts ownership={document.ownership} />;
}
