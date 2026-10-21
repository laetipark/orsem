import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisDiff, AnalysisDocument, AnalysisRun, FinancialFact } from '@orsem/contracts';
import { api } from '../lib/api';
import { analysisApi, defaultAnalysisSelection } from '../lib/disclosure-analysis-api';
import { DisclosureAnalysisPage } from './disclosure-analysis-page';
import {
  AnalysisTableView,
  OwnershipFacts,
} from '../components/disclosure-analysis/analysis-documents';
import { AnalysisVerification } from '../components/disclosure-analysis/analysis-research';
import { AnalysisDiffConfirmation } from '../components/disclosure-analysis/analysis-diff-confirmation';

const companyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const reportId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const documentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const time = '2026-10-10T01:00:00.000Z';
const fact: FinancialFact = {
  id: 'fact-1',
  companyId,
  companyName: '테스트기업',
  reportId,
  metric: 'revenue',
  accountId: 'ifrs-full_Revenue',
  accountName: '매출액',
  reportYear: 2025,
  reportCode: '11011',
  periodStart: '2025-01-01',
  periodEnd: '2025-12-31',
  basis: 'ANNUAL',
  scope: 'CFS',
  value: '12345678901234567890.10',
  rawValue: '12345678901234567890.10',
  currency: 'KRW',
  unit: '원',
  scale: 1,
  status: 'AVAILABLE',
  evidence: {
    reportId,
    source: 'OPENDART',
    filingId: '202600000001',
    sourceUrl: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=202600000001',
    observedAt: time,
    publicationDate: '2026-03-20',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    rawSha256: 'abc',
    documentId,
  },
};
const run: AnalysisRun = {
  id: runId,
  savedQueryId: null,
  parentRunId: null,
  status: 'COMPLETE',
  selection: defaultAnalysisSelection([companyId]),
  companyIds: [companyId],
  result: {
    facts: [fact],
    issues: [],
    reportIds: [reportId],
    documentIds: [documentId],
    diffIds: [],
    validations: [],
    mappingVersion: 'v1',
  },
  progress: { completed: 1, total: 1 },
  errorMessage: null,
  nextAttemptAt: null,
  createdAt: time,
  updatedAt: time,
  completedAt: time,
};
const document: AnalysisDocument = {
  id: documentId,
  reportId,
  sourceItemId: null,
  sourceUrl: fact.evidence.sourceUrl,
  rightsMode: 'OFFICIAL_PUBLIC_DATA',
  sha256: 'abc',
  parserVersion: 'v1',
  status: 'COMPLETE',
  tables: [
    {
      id: 'table-1',
      title: '재무상태표',
      rowCount: 1,
      columnCount: 2,
      cells: [
        { row: 0, column: 0, text: '<script>bad()</script>' },
        { row: 0, column: 1, text: '1,234', value: '1234' },
      ],
    },
  ],
  notes: [],
  ownership: null,
  errorMessage: null,
};
let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(analysisApi, 'capabilities').mockResolvedValue({
    enabled: true,
    documents: true,
    notes: true,
  });
  vi.spyOn(analysisApi, 'periods').mockResolvedValue({ items: [] });
  vi.spyOn(api, 'watchlistGroups').mockResolvedValue({
    items: [],
    revision: 0,
    permissions: { canManageGroups: true, canManageStocks: true, canManageMembers: false },
  });
  vi.spyOn(api, 'company').mockResolvedValue({ id: companyId, nameKo: '테스트기업' } as Awaited<
    ReturnType<typeof api.company>
  >);
  vi.spyOn(analysisApi, 'run').mockResolvedValue(run);
  vi.spyOn(analysisApi, 'createRun').mockResolvedValue(run);
  vi.spyOn(analysisApi, 'document').mockResolvedValue(document);
  vi.spyOn(analysisApi, 'runs').mockResolvedValue({ items: [run] });
  vi.spyOn(analysisApi, 'saved').mockResolvedValue({ items: [] });
  vi.spyOn(analysisApi, 'mappings').mockResolvedValue({ items: [] });
  vi.spyOn(analysisApi, 'notes').mockResolvedValue({ items: [] });
  vi.spyOn(analysisApi, 'bookmarks').mockResolvedValue({ items: [] });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
function show(url = `/analysis?companyId=${companyId}`) {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <DisclosureAnalysisPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('disclosure analysis', () => {
  it('submits the three annual periods default and switches quarterly defaults to eight', async () => {
    show();
    await screen.findByRole('button', { name: '재무 비교 시작' });
    expect(screen.getByLabelText('조회 기간')).toHaveDisplayValue('최근 3개 사업연도');
    fireEvent.change(screen.getByLabelText('기간 기준'), { target: { value: 'SINGLE_QUARTER' } });
    expect(screen.getByLabelText('조회 기간')).toHaveDisplayValue('최근 8개 분기');
    fireEvent.click(screen.getByRole('button', { name: '재무 비교 시작' }));
    await waitFor(() =>
      expect(analysisApi.createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          companyIds: [companyId],
          scope: 'CFS',
          basis: 'SINGLE_QUARTER',
          rolling: { kind: 'QUARTER', count: 8 },
        }),
        expect.anything(),
      ),
    );
  });
  it('blocks a request with no company and preserves precise numbers in evidence', async () => {
    show('/analysis');
    fireEvent.click(await screen.findByRole('button', { name: '재무 비교 시작' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('기업 또는 관심그룹');
    expect(analysisApi.createRun).not.toHaveBeenCalled();
  });
  it('opens source evidence without rounding and exports the immutable run', async () => {
    vi.spyOn(analysisApi, 'export').mockResolvedValue({
      id: 'export-1',
      runId,
      status: 'COMPLETE',
      sha256: 'abc',
      errorMessage: null,
      createdAt: time,
      updatedAt: time,
    });
    vi.spyOn(analysisApi, 'exportStatus').mockResolvedValue({
      id: 'export-1',
      runId,
      status: 'COMPLETE',
      sha256: 'abc',
      errorMessage: null,
      createdAt: time,
      updatedAt: time,
    });
    show(`/analysis?run=${runId}`);
    fireEvent.click(await screen.findByRole('button', { name: /테스트기업 2025 매출액 근거/ }));
    expect(screen.getByLabelText('선택한 숫자의 근거')).toHaveTextContent(
      '12345678901234567890.10',
    );
    expect(screen.getByRole('link', { name: '공식 원문 열기' })).toHaveAttribute(
      'href',
      fact.evidence.sourceUrl,
    );
    fireEvent.click(screen.getByRole('button', { name: '비교 결과 XLSX' }));
    expect(await screen.findByRole('link', { name: '준비된 XLSX 내려받기' })).toHaveAttribute(
      'href',
      '/api/v1/analysis/exports/export-1/download',
    );
    expect(analysisApi.export).toHaveBeenCalledWith(runId, { includeValidation: true });
  });
  it('treats source HTML as text and never creates active content', async () => {
    const { container } = show(`/analysis?run=${runId}&tab=documents`);
    expect(await screen.findByText('<script>bad()</script>')).toBeInTheDocument();
    expect(container.querySelector('script,iframe')).toBeNull();
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });
  it('makes saved queries personal and requires explicit opt-in for automatic refresh', async () => {
    vi.spyOn(analysisApi, 'save').mockResolvedValue({
      id: 'saved-1',
      name: '내 재무',
      selection: run.selection,
      autoRefresh: false,
      createdAt: time,
      updatedAt: time,
    });
    show(`/analysis?companyId=${companyId}&tab=saved`);
    const checkbox = await screen.findByLabelText('새 자료 자동 갱신');
    expect(checkbox).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('조회 이름'), { target: { value: '내 재무' } });
    fireEvent.click(screen.getByRole('button', { name: '현재 조건 저장' }));
    await waitFor(() =>
      expect(analysisApi.save).toHaveBeenCalledWith(
        expect.objectContaining({ name: '내 재무', autoRefresh: false }),
      ),
    );
  });
  it('shows missing data distinctly from a source zero', async () => {
    vi.mocked(analysisApi.run).mockResolvedValue({
      ...run,
      result: {
        ...run.result!,
        facts: [
          { ...fact, value: '0' },
          {
            ...fact,
            id: 'fact-2',
            metric: 'netIncome',
            value: null,
            status: 'NO_DATA',
            reason: '공식 수치 없음',
          },
        ],
      },
    });
    show(`/analysis?run=${runId}`);
    expect(await screen.findByRole('button', { name: /매출액 근거 0/ })).toHaveTextContent('0');
    expect(screen.getByRole('button', { name: /당기순이익 근거 —/ })).toHaveTextContent('—');
    expect(screen.getByText('공식 수치 없음')).toBeInTheDocument();
  });
  it('keeps incomplete results visible with retry and missing coverage', async () => {
    vi.mocked(analysisApi.run).mockResolvedValue({
      ...run,
      status: 'PARTIAL',
      result: {
        ...run.result!,
        issues: [{ companyId, code: 'WAITING', message: '자료 확인 대기', retryable: true }],
      },
    });
    vi.spyOn(analysisApi, 'retry').mockResolvedValue({
      ...run,
      id: 'retry-run',
      parentRunId: runId,
    });
    show(`/analysis?run=${runId}`);
    fireEvent.click(await screen.findByRole('button', { name: '미완료 자료 재시도' }));
    await waitFor(() => expect(analysisApi.retry).toHaveBeenCalledWith(runId));
  });
  it('connects original table selection to a scoped export request', async () => {
    vi.spyOn(analysisApi, 'export').mockResolvedValue({
      id: 'export-2',
      runId,
      status: 'QUEUED',
      sha256: null,
      errorMessage: null,
      createdAt: time,
      updatedAt: time,
    });
    vi.spyOn(analysisApi, 'exportStatus').mockResolvedValue({
      id: 'export-2',
      runId,
      status: 'QUEUED',
      sha256: null,
      errorMessage: null,
      createdAt: time,
      updatedAt: time,
    });
    show(`/analysis?run=${runId}&tab=documents`);
    fireEvent.click(await screen.findByRole('checkbox', { name: '재무상태표' }));
    fireEvent.click(screen.getByRole('button', { name: '선택한 표 XLSX' }));
    await waitFor(() =>
      expect(analysisApi.export).toHaveBeenCalledWith(runId, {
        documentIds: [documentId],
        tableIds: ['table-1'],
      }),
    );
    expect(screen.queryByRole('link', { name: '준비된 XLSX 내려받기' })).toBeNull();
  });
  it('searches source notes, compares two periods and bookmarks without sharing', async () => {
    const first = {
      id: 'note-1',
      documentId,
      key: 'inventory',
      title: '재고 2024',
      text: '재고자산 100',
      tableIds: [],
      sourceUrl: fact.evidence.sourceUrl,
    };
    vi.mocked(analysisApi.notes).mockResolvedValue({
      items: [first, { ...first, id: 'note-2', title: '재고 2025', text: '재고자산 200' }],
    });
    vi.spyOn(analysisApi, 'bookmark').mockResolvedValue({
      id: 'bookmark-1',
      documentId,
      noteId: first.id,
      label: first.title,
      anchor: {},
      needsRelink: false,
      createdAt: time,
    });
    show(`/analysis?run=${runId}&tab=notes`);
    fireEvent.click(await screen.findByRole('checkbox', { name: '재고 2024' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '재고 2025' }));
    expect(screen.getByLabelText('주석 나란히 비교')).toHaveTextContent('재고자산 100');
    expect(screen.getByLabelText('주석 나란히 비교')).toHaveTextContent('재고자산 200');
    fireEvent.click(screen.getAllByRole('button', { name: '북마크' })[0]!);
    await waitFor(() =>
      expect(analysisApi.bookmark).toHaveBeenCalledWith(
        { documentId, noteId: first.id, label: first.title, anchor: { text: first.text } },
        expect.anything(),
      ),
    );
    fireEvent.change(screen.getByLabelText('주석 검색'), { target: { value: '차입금' } });
    fireEvent.click(screen.getByRole('button', { name: '검색' }));
    await waitFor(() =>
      expect(analysisApi.notes).toHaveBeenCalledWith(runId, '차입금', expect.any(AbortSignal)),
    );
  });
  it('traces a validation to the exact fact and shows reviewed mapping evidence', async () => {
    vi.mocked(analysisApi.run).mockResolvedValue({
      ...run,
      result: {
        ...run.result!,
        validations: [
          {
            id: 'check',
            rule: 'identity',
            ruleVersion: 'v1',
            status: 'REVIEW',
            message: '합계 확인 필요',
            formula: '자산 = 부채 + 자본',
            factIds: [fact.id],
            values: [fact.value!],
            tolerance: '0',
          },
        ],
      },
    });
    vi.mocked(analysisApi.mappings).mockResolvedValue({
      items: [
        {
          id: 'map',
          source: 'OPENDART',
          taxonomy: 'ifrs-full',
          accountId: 'Revenue',
          metric: 'revenue',
          scope: 'CFS',
          status: 'CONFIRMED',
          version: 1,
          sourceUrl: fact.evidence.sourceUrl,
          details: { rationale: '공식 계정 태그와 일치' },
        },
      ],
    });
    show(`/analysis?run=${runId}&tab=verification`);
    fireEvent.click(await screen.findByRole('button', { name: '매출액 근거' }));
    expect(screen.getByLabelText('선택한 숫자의 근거')).toHaveTextContent(fact.value!);
    expect(screen.getByText('공식 계정 태그와 일치')).toBeInTheDocument();
    await screen.findByRole('button', { name: '테스트기업 선택 해제' });
  });
  it('does not expose unavailable tools as a blank page through a direct URL', async () => {
    vi.mocked(analysisApi.capabilities).mockResolvedValue({
      enabled: true,
      documents: false,
      notes: false,
    });
    show(`/analysis?run=${runId}&tab=documents`);
    expect(await screen.findByText('이 분석 도구의 연결을 준비하고 있습니다')).toBeInTheDocument();
    expect(analysisApi.document).not.toHaveBeenCalled();
  });
});

it('preserves merged source cells as safe text', () => {
  const { container } = render(
    <AnalysisTableView
      table={{
        ...document.tables[0]!,
        cells: [{ row: 0, column: 0, colSpan: 2, text: '<img src=x onerror=bad()>' }],
      }}
    />,
  );
  expect(screen.getByText('<img src=x onerror=bad()>')).toHaveAttribute('colspan', '2');
  expect(container.querySelector('img')).toBeNull();
});

it('shows SEC codes, exact numbers and footnotes without asserting an open-market trade', () => {
  render(
    <OwnershipFacts
      ownership={{
        form: '4',
        reportingOwners: [{ name: '신고자', isDirector: true }],
        transactions: [
          {
            transactionDate: '2026-10-01',
            securityTitle: 'Common',
            transactionCode: 'P',
            acquiredDisposedCode: 'A',
            transactionShares: '9007199254740993',
            transactionPrice: '2.00',
            sharesOwnedAfter: '9007199254740994',
            directIndirectOwnership: 'D',
            footnoteReferences: ['F1'],
          },
        ],
        holdings: [],
        footnotes: { F1: '사적 거래 설명' },
      }}
    />,
  );
  expect(screen.getByText('9,007,199,254,740,993')).toBeInTheDocument();
  expect(screen.getByText(/공개시장 또는 사적 거래/)).toBeInTheDocument();
  expect(screen.getByText(/사적 거래 설명/)).toBeInTheDocument();
});

it('never exposes mapping mutation controls to a viewing member', async () => {
  render(
    <QueryClientProvider client={client}>
      <AnalysisVerification actor="MEMBER:test" run={run} onSelect={() => undefined} />
    </QueryClientProvider>,
  );
  await screen.findByText('계정 매핑 근거');
  expect(screen.queryByText('관리자 계정 매핑 검토')).toBeNull();
  expect(screen.queryByRole('button', { name: '매핑 검토 저장' })).toBeNull();
});

it('lets an admin confirm a candidate as a new version without rewriting the run', async () => {
  const candidate = {
    id: 'mapping-1',
    source: 'OPENDART' as const,
    taxonomy: 'ifrs-full',
    accountId: 'Revenue',
    metric: 'revenue' as const,
    scope: 'CFS' as const,
    status: 'CANDIDATE' as const,
    version: 1,
    sourceUrl: fact.evidence.sourceUrl,
    details: { rationale: '공식 계정 확인' },
  };
  vi.mocked(analysisApi.mappings).mockResolvedValue({ items: [candidate] });
  vi.spyOn(analysisApi, 'saveMapping').mockResolvedValue({
    ...candidate,
    status: 'CONFIRMED',
    version: 2,
  });
  render(
    <QueryClientProvider client={client}>
      <AnalysisVerification actor="ADMIN:test" run={run} isAdmin onSelect={() => undefined} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('관리자 계정 매핑 검토'));
  fireEvent.click(await screen.findByRole('button', { name: '매핑 확인' }));
  await waitFor(() =>
    expect(analysisApi.saveMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'Revenue',
        status: 'CONFIRMED',
        details: { rationale: '공식 계정 확인' },
      }),
      expect.anything(),
    ),
  );
  expect(await screen.findByRole('status')).toHaveTextContent('버전 2');
  expect(screen.getByText(/이 실행의 매핑 기준: v1/)).toBeInTheDocument();
});

it('requires HTTPS evidence and rationale before accepting a manual mapping', async () => {
  const save = vi.spyOn(analysisApi, 'saveMapping');
  render(
    <QueryClientProvider client={client}>
      <AnalysisVerification actor="ADMIN:test" run={run} isAdmin onSelect={() => undefined} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('관리자 계정 매핑 검토'));
  fireEvent.change(screen.getByLabelText('원문 계정 태그'), {
    target: { value: 'UnknownRevenue' },
  });
  fireEvent.change(screen.getByLabelText('공식 근거 주소'), {
    target: { value: 'http://example.com' },
  });
  fireEvent.change(screen.getByLabelText('판단 이유'), { target: { value: '계정 범위 검토' } });
  fireEvent.click(screen.getByRole('button', { name: '매핑 검토 저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTPS');
  expect(save).not.toHaveBeenCalled();
});

const unconfirmedDiff: AnalysisDiff = {
  id: 'diff-1',
  beforeDocumentId: documentId,
  afterDocumentId: 'document-2',
  status: 'WAITING',
  confirmed: false,
  differences: [],
  errorMessage: null,
};

it('keeps unconfirmed correction review unavailable to members', () => {
  render(
    <QueryClientProvider client={client}>
      <AnalysisDiffConfirmation
        actor="MEMBER:test"
        runId={runId}
        diff={unconfirmedDiff}
        isAdmin={false}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByText('관리자 정정 관계 확인')).toBeNull();
});

it('requires explicit official proof before the admin requeues a correction comparison', async () => {
  const sourceUrl = 'https://www.sec.gov/Archives/edgar/data/1/amendment.htm';
  const note = '정정 제출본에서 이전 접수번호를 명시한 문구 확인';
  const confirm = vi.spyOn(analysisApi, 'confirmDiff').mockResolvedValue({
    ...unconfirmedDiff,
    status: 'QUEUED',
    confirmation: { status: 'CONFIRMED', sourceUrl, note, reviewedAt: time },
  });
  render(
    <QueryClientProvider client={client}>
      <AnalysisDiffConfirmation actor="ADMIN:test" runId={runId} diff={unconfirmedDiff} isAdmin />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText('관리자 정정 관계 확인'));
  fireEvent.change(screen.getByLabelText('정정 관계 공식 근거 주소'), {
    target: { value: 'http://www.sec.gov/Archives/test' },
  });
  fireEvent.change(screen.getByLabelText('정정 관계 확인 이유'), { target: { value: note } });
  fireEvent.click(screen.getByRole('button', { name: '정정 관계 확인 후 다시 비교' }));
  expect(screen.getByRole('alert')).toHaveTextContent('HTTPS');
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('정정 관계 공식 근거 주소'), {
    target: { value: sourceUrl },
  });
  fireEvent.click(screen.getByRole('button', { name: '정정 관계 확인 후 다시 비교' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith('diff-1', { runId, sourceUrl, note }));
  await waitFor(() =>
    expect(client.getQueryData(['analysis-diff', 'ADMIN:test', 'diff-1'])).toMatchObject({
      status: 'QUEUED',
      confirmation: { sourceUrl, note },
    }),
  );
});

it('shows the recorded correction proof to all viewers without review controls', () => {
  render(
    <QueryClientProvider client={client}>
      <AnalysisDiffConfirmation
        actor="MEMBER:test"
        runId={runId}
        diff={{
          ...unconfirmedDiff,
          confirmation: {
            status: 'CONFIRMED',
            sourceUrl: fact.evidence.sourceUrl,
            note: '공식 근거 확인',
            reviewedAt: time,
          },
        }}
        isAdmin={false}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText('공식 근거 확인')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '정정 관계 확인 근거' })).toHaveAttribute(
    'href',
    fact.evidence.sourceUrl,
  );
  expect(screen.queryByRole('button', { name: '정정 관계 확인 후 다시 비교' })).toBeNull();
});
