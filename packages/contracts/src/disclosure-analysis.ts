import { z } from 'zod';

export const ANALYSIS_METRICS = [
  'revenue',
  'operatingIncome',
  'netIncome',
  'assets',
  'liabilities',
  'equity',
  'operatingCashFlow',
] as const;
export type AnalysisMetric = (typeof ANALYSIS_METRICS)[number];
export const analysisMetricSchema = z.enum(ANALYSIS_METRICS);
export const analysisPeriodSchema = z
  .object({
    year: z.number().int().min(2015).max(2100),
    reportCode: z.enum(['11011', '11012', '11013', '11014']),
  })
  .strict();
export type AnalysisPeriod = z.infer<typeof analysisPeriodSchema>;
export const analysisSelectionSchema = z
  .object({
    companyIds: z.array(z.uuid()).max(20).default([]),
    groupId: z.union([z.uuid(), z.literal('operational')]).optional(),
    periods: z.array(analysisPeriodSchema).max(20).default([]),
    rolling: z
      .object({ kind: z.enum(['ANNUAL', 'QUARTER']), count: z.number().int().min(1).max(20) })
      .strict()
      .optional(),
    scope: z.enum(['CFS', 'OFS']).default('CFS'),
    basis: z.enum(['ANNUAL', 'YTD', 'SINGLE_QUARTER']).default('ANNUAL'),
    metrics: z
      .array(analysisMetricSchema)
      .min(1)
      .max(7)
      .default([...ANALYSIS_METRICS]),
    versionPolicy: z
      .enum(['LATEST_OBSERVED', 'FIRST_OBSERVED', 'SPECIFIC'])
      .default('LATEST_OBSERVED'),
    reportIds: z.array(z.uuid()).max(400).optional(),
  })
  .strict()
  .superRefine((selection, ctx) => {
    if (!selection.companyIds.length && !selection.groupId)
      ctx.addIssue({ code: 'custom', message: '기업 또는 관심그룹을 선택하세요.' });
    if (!selection.periods.length && !selection.rolling)
      ctx.addIssue({ code: 'custom', message: '조회 기간을 선택하세요.' });
    if (selection.periods.length && selection.rolling)
      ctx.addIssue({ code: 'custom', message: '고정 기간과 최근 기간 중 하나를 선택하세요.' });
    if (selection.versionPolicy === 'SPECIFIC' && !selection.reportIds?.length)
      ctx.addIssue({ code: 'custom', message: '보존된 제출본을 선택하세요.' });
    if (
      new Set(selection.companyIds).size !== selection.companyIds.length ||
      new Set(selection.metrics).size !== selection.metrics.length
    )
      ctx.addIssue({ code: 'custom', message: '중복 선택은 허용하지 않습니다.' });
    if (
      new Set(selection.periods.map((p) => `${p.year}:${p.reportCode}`)).size !==
      selection.periods.length
    )
      ctx.addIssue({ code: 'custom', message: '중복 기간은 허용하지 않습니다.' });
  });
export type AnalysisSelection = z.infer<typeof analysisSelectionSchema>;
export const saveAnalysisQuerySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    selection: analysisSelectionSchema,
    autoRefresh: z.boolean().default(false),
  })
  .strict();
export const analysisExportRequestSchema = z
  .object({
    documentIds: z.array(z.uuid()).max(20).default([]),
    tableIds: z.array(z.string().min(1).max(160)).max(100).default([]),
    diffIds: z.array(z.uuid()).max(20).default([]),
    includeNotes: z.boolean().default(false),
    includeValidation: z.boolean().default(true),
    includeOwnership: z.boolean().default(false),
  })
  .strict();
export type AnalysisExportRequest = z.infer<typeof analysisExportRequestSchema>;
export type AnalysisStatus = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'WAITING' | 'FAILED';
export type FactStatus =
  'AVAILABLE' | 'NO_DATA' | 'AMBIGUOUS' | 'UNSUPPORTED' | 'WAITING' | 'FAILED';
export interface EvidenceRef {
  reportId: string;
  source: 'OPENDART' | 'SEC';
  filingId: string;
  sourceUrl: string;
  observedAt: string;
  publicationDate: string | null;
  rightsMode: string;
  rawSha256: string;
  documentId?: string;
  tableId?: string;
  row?: number;
  column?: number;
  sourceField?: string;
  parserVersion?: string;
  matched?: boolean;
}
export interface FinancialFact {
  id: string;
  companyId: string;
  companyName?: string;
  reportId: string;
  metric: AnalysisMetric;
  accountId: string | null;
  accountName: string;
  accountDetail?: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reportYear: number;
  reportCode: AnalysisPeriod['reportCode'];
  basis: 'INSTANT' | 'ANNUAL' | 'YTD' | 'SINGLE_QUARTER';
  scope: 'CFS' | 'OFS' | 'UNKNOWN';
  value: string | null;
  rawValue: string | null;
  currency: string | null;
  unit: string;
  scale: number;
  status: FactStatus;
  reason?: string | null;
  taxonomy?: string;
  mappingVersion?: string;
  precision?: string | null;
  evidence: EvidenceRef;
  comparison?: {
    previousFactId: string;
    difference: string;
    percent: string | null;
    transition: 'PROFIT' | 'LOSS' | null;
  };
}
export interface AnalysisIssue {
  companyId: string;
  period?: AnalysisPeriod;
  code: string;
  message: string;
  retryable: boolean;
}
export interface AnalysisResult {
  facts: FinancialFact[];
  issues: AnalysisIssue[];
  reportIds: string[];
  documentIds: string[];
  diffIds: string[];
  validations: AnalysisValidation[];
  mappingVersion: string;
}
export interface AnalysisRun {
  id: string;
  savedQueryId: string | null;
  parentRunId: string | null;
  status: AnalysisStatus;
  selection: AnalysisSelection;
  companyIds: string[];
  result: AnalysisResult | null;
  progress: { completed: number; total: number; message?: string };
  errorMessage: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
export interface SavedAnalysisQuery {
  id: string;
  name: string;
  selection: AnalysisSelection;
  autoRefresh: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface ExportManifest {
  id: string;
  runId: string;
  status: AnalysisStatus;
  sha256: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  downloadUrl?: string;
}
export interface AnalysisCapabilities {
  enabled: boolean;
  documents: boolean;
  notes: boolean;
}
export interface AnalysisReport {
  id: string;
  companyId: string;
  source: 'OPENDART' | 'SEC';
  filingId: string;
  reportYear: number;
  reportCode: AnalysisPeriod['reportCode'];
  scope: 'CFS' | 'OFS' | 'UNKNOWN';
  periodStart: string | null;
  periodEnd: string | null;
  publicationDate: string | null;
  firstObservedAt: string;
  sourceUrl: string;
}
export interface AnalysisCell {
  row: number;
  column: number;
  text: string;
  rowSpan?: number;
  colSpan?: number;
  value?: string | null;
  factId?: string;
}
export interface AnalysisTable {
  id: string;
  title: string;
  section?: string;
  cells: AnalysisCell[];
  rowCount: number;
  columnCount: number;
}
export interface AnalysisNote {
  id: string;
  documentId: string;
  key: string;
  title: string;
  text: string;
  tableIds: string[];
  sourceUrl: string;
}
export interface SecOwnershipDetail {
  form: string;
  issuer?: Record<string, unknown>;
  reportingOwners: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
  footnotes: Record<string, string>;
  [key: string]: unknown;
}
export interface AnalysisDocument {
  id: string;
  reportId: string | null;
  filingId?: string | null;
  sourceItemId: string | null;
  sourceUrl: string;
  rightsMode: string;
  sha256: string;
  parserVersion: string;
  status: AnalysisStatus;
  tables: AnalysisTable[];
  notes: AnalysisNote[];
  ownership: SecOwnershipDetail | null;
  errorMessage: string | null;
}
export interface AnalysisDifference {
  kind: 'ADDED' | 'REMOVED' | 'VALUE' | 'TEXT' | 'DATE' | 'UNIT' | 'CLASSIFICATION' | 'REVIEW';
  label: string;
  before: string | null;
  after: string | null;
  beforeTableId?: string;
  afterTableId?: string;
  beforeNoteKey?: string;
  afterNoteKey?: string;
  row?: number;
  column?: number;
  difference?: string | null;
  percent?: string | null;
}
export interface AnalysisDiff {
  id: string;
  beforeDocumentId: string;
  afterDocumentId: string;
  status: AnalysisStatus;
  confirmed: boolean;
  confirmation?: {
    status: 'CONFIRMED';
    sourceUrl: string;
    note: string;
    reviewedAt: string;
  };
  differences: AnalysisDifference[];
  errorMessage: string | null;
}
export interface AnalysisValidation {
  id: string;
  rule: string;
  ruleVersion: string;
  status: 'PASS' | 'ROUNDING' | 'REVIEW' | 'UNAVAILABLE';
  message: string;
  formula: string;
  factIds: string[];
  values: string[];
  tolerance: string | null;
}
export interface AnalysisBookmark {
  id: string;
  documentId: string;
  noteId: string | null;
  label: string;
  anchor: Record<string, unknown>;
  needsRelink: boolean;
  createdAt: string;
}
export interface AnalysisMapping {
  id: string;
  source: 'OPENDART' | 'SEC';
  taxonomy: string;
  accountId: string;
  metric: AnalysisMetric;
  scope: 'CFS' | 'OFS' | 'UNKNOWN';
  status: 'CANDIDATE' | 'CONFIRMED' | 'REJECTED';
  version: number;
  sourceUrl: string;
  details: Record<string, unknown>;
}
export const analysisBookmarkSchema = z
  .object({
    documentId: z.uuid(),
    noteId: z.uuid().nullable().default(null),
    label: z.string().trim().min(1).max(160),
    anchor: z
      .object({
        tableId: z.string().max(160).optional(),
        row: z.number().int().nonnegative().optional(),
        column: z.number().int().nonnegative().optional(),
        text: z.string().max(1000).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const analysisMappingSchema = z
  .object({
    source: z.enum(['OPENDART', 'SEC']),
    taxonomy: z.string().min(1).max(80),
    accountId: z.string().min(1).max(255),
    metric: analysisMetricSchema,
    scope: z.enum(['CFS', 'OFS', 'UNKNOWN']),
    status: z.enum(['CANDIDATE', 'CONFIRMED', 'REJECTED']),
    sourceUrl: z.url().max(2048),
    details: z
      .object({ rationale: z.string().max(2000).default('') })
      .strict()
      .default({ rationale: '' }),
  })
  .strict();
