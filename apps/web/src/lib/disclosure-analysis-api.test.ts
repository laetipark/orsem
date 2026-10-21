import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./api', () => ({ API_BASE_URL: '/api/v1', request: vi.fn() }));
import { request } from './api';
import { analysisApi, defaultAnalysisSelection } from './disclosure-analysis-api';

beforeEach(() => vi.mocked(request).mockReset());
it('uses the shared authenticated transport and sends exact selections', async () => {
  const selection = defaultAnalysisSelection(['company']);
  await analysisApi.createRun(selection);
  expect(request).toHaveBeenCalledWith('/analysis/runs', {
    method: 'POST',
    body: JSON.stringify(selection),
  });
  await analysisApi.updateSaved('saved', { name: '조회', selection, autoRefresh: false });
  expect(request).toHaveBeenLastCalledWith(
    '/analysis/saved-queries/saved',
    expect.objectContaining({ method: 'PUT' }),
  );
});
it('binds document, differences, evidence and export to the selected run', async () => {
  await analysisApi.createDocument({ runId: 'run', eventId: 'event' });
  expect(request).toHaveBeenLastCalledWith('/analysis/documents', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run', eventId: 'event' }),
  });
  await analysisApi.createDiff('run', 'before', 'after');
  expect(request).toHaveBeenLastCalledWith('/analysis/diffs', {
    method: 'POST',
    body: JSON.stringify({ runId: 'run', beforeDocumentId: 'before', afterDocumentId: 'after' }),
  });
  await analysisApi.confirmDiff('diff', {
    runId: 'run',
    sourceUrl: 'https://www.sec.gov/Archives/proof',
    note: '공식 정정 계보 확인',
  });
  expect(request).toHaveBeenLastCalledWith('/analysis/diffs/diff/confirm', {
    method: 'POST',
    body: JSON.stringify({
      runId: 'run',
      sourceUrl: 'https://www.sec.gov/Archives/proof',
      note: '공식 정정 계보 확인',
    }),
  });
  await analysisApi.evidence('fact', 'run');
  expect(request).toHaveBeenLastCalledWith('/analysis/evidence/fact?runId=run', {
    signal: undefined,
  });
  await analysisApi.export('run', { documentIds: ['doc'], tableIds: ['table'] });
  expect(request).toHaveBeenLastCalledWith('/analysis/runs/run/exports', {
    method: 'POST',
    body: JSON.stringify({ documentIds: ['doc'], tableIds: ['table'] }),
  });
});
it('encodes untrusted path and query values, and never accepts a provider download URL', async () => {
  await analysisApi.notes('run', 'A&B + C');
  expect(request).toHaveBeenLastCalledWith('/analysis/notes?runId=run&q=A%26B+%2B+C', {
    signal: undefined,
  });
  expect(analysisApi.exportUrl('../private')).toBe(
    '/api/v1/analysis/exports/..%2Fprivate/download',
  );
});
