import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { OperationRun } from '../types';
import { mockMediaQuery } from '../test/media-query';
import { OperationsPage } from './operations-page';

const mocks = vi.hoisted(() => ({
  parseIntegrity: vi.fn(),
  operationSources: vi.fn(),
  operationRuns: vi.fn(),
  operationQueues: vi.fn(),
}));
vi.mock('../lib/api', () => ({ api: mocks }));
vi.mock('../components/member-approval', () => ({ MemberApproval: () => null }));
const run: OperationRun = {
  id: 'run-1',
  source: 'NEWS_RSS',
  job: 'news-rss',
  status: 'FAILED',
  startedAt: '2026-09-05T00:00:00Z',
  finishedAt: null,
  processed: 12,
  failed: 1,
  message: 'Connection failed',
};
const clients: QueryClient[] = [];
function show(items = [run]) {
  mocks.parseIntegrity.mockResolvedValue(null);
  mocks.operationSources.mockResolvedValue({ items: [] });
  mocks.operationQueues.mockResolvedValue({ items: [] });
  mocks.operationRuns.mockResolvedValue({ items });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <OperationsPage />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('mounts labeled run cards on compact screens and switches to only the table when expanded', async () => {
  const { resize } = mockMediaQuery(true);
  const { container } = show();
  expect(await screen.findByText(run.job)).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByText('시작')).toBeVisible();
  expect(screen.getByText('완료')).toBeVisible();
  expect(screen.getByText('메시지')).toBeVisible();
  expect(screen.getByText('실패 1')).toBeVisible();
  expect(screen.getByText('Connection failed')).toBeVisible();
  expect(container.querySelector('.operation-run')).toHaveTextContent('KST');
  act(() => resize(false));
  expect(screen.getByRole('table')).toHaveClass('data-table--operations');
  expect(container.querySelector('.operation-run')).toBeNull();
  expect(screen.getAllByText(run.job)).toHaveLength(1);
  expect(mocks.operationRuns).toHaveBeenCalledTimes(1);
});

it('shows an empty state for compact run history', async () => {
  mockMediaQuery(true);
  show([]);
  expect(await screen.findByText('표시할 데이터가 없습니다.')).toBeVisible();
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
