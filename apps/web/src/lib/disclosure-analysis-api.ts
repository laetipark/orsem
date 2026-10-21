import type {
  AnalysisBookmark,
  AnalysisCapabilities,
  AnalysisDiff,
  AnalysisDocument,
  AnalysisExportRequest,
  AnalysisMapping,
  AnalysisNote,
  AnalysisReport,
  AnalysisRun,
  AnalysisSelection,
  EvidenceRef,
  ExportManifest,
  SavedAnalysisQuery,
} from '@orsem/contracts';
import { API_BASE_URL, request } from './api';

const pathId = (id: string) => encodeURIComponent(id);
const query = (values: Record<string, string | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value);
  return params.size ? `?${params}` : '';
};
const body = (value: unknown) => ({ method: 'POST', body: JSON.stringify(value) });
export type AnalysisMappingInput = Pick<
  AnalysisMapping,
  'source' | 'taxonomy' | 'accountId' | 'metric' | 'scope' | 'status' | 'sourceUrl'
> & { details: { rationale: string } };
export const analysisApi = {
  capabilities: (signal?: AbortSignal) =>
    request<AnalysisCapabilities>('/analysis/capabilities', { signal }),
  periods: (companyId: string, signal?: AbortSignal) =>
    request<{ items: AnalysisReport[] }>(`/analysis/periods${query({ companyId })}`, { signal }),
  runs: (savedQueryId?: string, signal?: AbortSignal) =>
    request<{ items: AnalysisRun[] }>(`/analysis/runs${query({ savedQueryId })}`, { signal }),
  createRun: (selection: AnalysisSelection) =>
    request<AnalysisRun>('/analysis/runs', body(selection)),
  run: (id: string, signal?: AbortSignal) =>
    request<AnalysisRun>(`/analysis/runs/${pathId(id)}`, { signal }),
  retry: (id: string) => request<AnalysisRun>(`/analysis/runs/${pathId(id)}/retry`, body({})),
  export: (id: string, selection: Partial<AnalysisExportRequest> = {}) =>
    request<ExportManifest>(`/analysis/runs/${pathId(id)}/exports`, body(selection)),
  exportStatus: (id: string, signal?: AbortSignal) =>
    request<ExportManifest>(`/analysis/exports/${pathId(id)}`, { signal }),
  exportUrl: (id: string) => `${API_BASE_URL}/analysis/exports/${pathId(id)}/download`,
  saved: (signal?: AbortSignal) =>
    request<{ items: SavedAnalysisQuery[] }>('/analysis/saved-queries', { signal }),
  save: (value: Pick<SavedAnalysisQuery, 'name' | 'selection' | 'autoRefresh'>) =>
    request<SavedAnalysisQuery>('/analysis/saved-queries', body(value)),
  updateSaved: (
    id: string,
    value: Pick<SavedAnalysisQuery, 'name' | 'selection' | 'autoRefresh'>,
  ) =>
    request<SavedAnalysisQuery>(`/analysis/saved-queries/${pathId(id)}`, {
      method: 'PUT',
      body: JSON.stringify(value),
    }),
  deleteSaved: (id: string) =>
    request<void>(`/analysis/saved-queries/${pathId(id)}`, { method: 'DELETE' }),
  runSaved: (id: string) =>
    request<AnalysisRun>(`/analysis/saved-queries/${pathId(id)}/run`, body({})),
  document: (id: string, signal?: AbortSignal) =>
    request<AnalysisDocument>(`/analysis/documents/${pathId(id)}`, { signal }),
  createDocument: (value: {
    runId: string;
    reportId?: string;
    sourceItemId?: string;
    eventId?: string;
    filingId?: string;
  }) => request<AnalysisDocument>('/analysis/documents', body(value)),
  diff: (id: string, signal?: AbortSignal) =>
    request<AnalysisDiff>(`/analysis/diffs/${pathId(id)}`, { signal }),
  createDiff: (runId: string, beforeDocumentId: string, afterDocumentId: string) =>
    request<AnalysisDiff>('/analysis/diffs', body({ runId, beforeDocumentId, afterDocumentId })),
  confirmDiff: (id: string, value: { runId: string; sourceUrl: string; note: string }) =>
    request<AnalysisDiff>(`/analysis/diffs/${pathId(id)}/confirm`, body(value)),
  notes: (runId: string, q: string, signal?: AbortSignal) =>
    request<{ items: AnalysisNote[] }>(`/analysis/notes${query({ runId, q })}`, { signal }),
  bookmarks: (signal?: AbortSignal) =>
    request<{ items: AnalysisBookmark[] }>('/analysis/bookmarks', { signal }),
  bookmark: (value: Pick<AnalysisBookmark, 'documentId' | 'noteId' | 'label' | 'anchor'>) =>
    request<AnalysisBookmark>('/analysis/bookmarks', body(value)),
  deleteBookmark: (id: string) =>
    request<void>(`/analysis/bookmarks/${pathId(id)}`, { method: 'DELETE' }),
  mappings: (signal?: AbortSignal) =>
    request<{ items: AnalysisMapping[] }>('/analysis/mappings', { signal }),
  saveMapping: (value: AnalysisMappingInput) =>
    request<AnalysisMapping>('/analysis/mappings', body(value)),
  evidence: (id: string, runId: string, signal?: AbortSignal) =>
    request<EvidenceRef>(`/analysis/evidence/${pathId(id)}${query({ runId })}`, { signal }),
};

export const analysisMetricLabels = {
  revenue: '매출액',
  operatingIncome: '영업이익',
  netIncome: '당기순이익',
  assets: '자산',
  liabilities: '부채',
  equity: '자본',
  operatingCashFlow: '영업현금흐름',
} as const;
export const analysisPeriodLabels = {
  '11011': '사업연도',
  '11013': '1분기',
  '11012': '반기',
  '11014': '3분기',
} as const;
export const analysisBasisLabels = {
  ANNUAL: '연간',
  YTD: '누적',
  SINGLE_QUARTER: '분기 단독',
  INSTANT: '기말',
} as const;
export function defaultAnalysisSelection(
  companyIds: string[] = [],
  groupId?: string,
): AnalysisSelection {
  return {
    companyIds,
    ...(groupId ? { groupId } : {}),
    periods: [],
    rolling: { kind: 'ANNUAL', count: 3 },
    scope: 'CFS',
    basis: 'ANNUAL',
    metrics: Object.keys(analysisMetricLabels) as AnalysisSelection['metrics'],
    versionPolicy: 'LATEST_OBSERVED',
  };
}
export const analysisPending = (status?: string) =>
  status === 'QUEUED' || status === 'RUNNING' || status === 'WAITING';
