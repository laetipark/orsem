import { groupSaveSchema, type WatchPermissions } from '@orsem/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api, isFixtureMode, setCsrfToken } from '../lib/api';
import type { WatchlistGroup } from '../types';
import { GroupManagerDialog } from './group-manager-dialog';

const actor = 'MEMBER:11111111-1111-4111-8111-111111111111';
const permissions: WatchPermissions = {
  canManageGroups: true,
  canManageStocks: true,
  canManageMembers: false,
};
const initial = {
  revision: 10,
  permissions,
  items: ['반도체', '배당주', '성장주', '해외 기업', '장기 관찰'].map(
    (name, index): WatchlistGroup => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name,
      kind: 'PERSONAL',
      roomId: null,
      revision: 2,
      isShared: false,
      isFollowing: false,
      canEdit: true,
      itemCount: index,
      ownerLabel: '나',
      updatedAt: '2026-09-07T00:00:00.000Z',
      ...permissions,
    }),
  ),
};
const clients: QueryClient[] = [];

function pointer(handle: HTMLElement, type: string, clientY: number) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: 20,
    clientY,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    isPrimary: { value: true },
  });
  fireEvent(handle, event);
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  setCsrfToken(null);
  vi.restoreAllMocks();
});

it.each([false, true])(
  'saves a five-group personal drag draft through the real API only after footer save (cached=%s)',
  async (cached) => {
    expect(isFixtureMode).toBe(false);
    expect(vi.isMockFunction(api.saveWatchlistGroups)).toBe(false);
    expect(vi.isMockFunction(api.watchlistGroups)).toBe(false);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    clients.push(client);
    const key = ['watchlist-v2', actor, 'groups', 'personal'];
    if (cached) client.setQueryData(key, structuredClone(initial));
    const writes: Array<{ input: unknown; init: RequestInit }> = [];
    const validations: ReturnType<typeof groupSaveSchema.safeParse>[] = [];
    setCsrfToken('integration-only-csrf');
    // Only the HTTP boundary is mocked. Hooks, API request construction and the server
    // schema are real; unexpected requests can never reach a running service.
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'https://app.example.test');
      if (url.pathname === '/api/v1/watchlist-groups' && (init?.method ?? 'GET') === 'GET') {
        // Reproduce an old GET already in flight after a successful PUT.
        return Response.json(structuredClone(initial));
      }
      if (url.pathname === '/api/v1/watchlist-groups/edit' && init?.method === 'PUT') {
        const body: unknown = JSON.parse(String(init.body));
        const result = groupSaveSchema.safeParse(body);
        writes.push({ input: body, init });
        validations.push(result);
        return result.success
          ? new Response(null, { status: 204 })
          : Response.json(
              {
                message: '요청 값이 올바르지 않습니다.',
                issues: result.error.issues.map((issue) => ({
                  path: issue.path.join('.'),
                  message: issue.message,
                })),
              },
              { status: 400 },
            );
      }
      throw new Error(`Unexpected test request: ${init?.method ?? 'GET'} ${url.pathname}`);
    });
    render(
      <QueryClientProvider client={client}>
        <GroupManagerDialog actor={actor} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    const handle = await screen.findByRole('button', { name: '반도체 순서 변경' });
    await waitFor(() => expect(handle).toHaveAttribute('aria-disabled', 'false'));
    const list = screen.getByRole('list', { name: '관심 그룹' });
    for (const row of list.children) {
      vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => {
        const top = [...list.children].indexOf(row) * 44;
        return {
          top,
          bottom: top + 44,
          height: 44,
          width: 400,
          left: 0,
          right: 400,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    }
    const captures = new Set<number>();
    Object.defineProperties(handle, {
      setPointerCapture: { value: (id: number) => captures.add(id) },
      hasPointerCapture: { value: (id: number) => captures.has(id) },
      releasePointerCapture: { value: (id: number) => captures.delete(id) },
    });
    pointer(handle, 'pointerdown', 22);
    pointer(handle, 'pointermove', 198);
    expect(writes).toHaveLength(0);
    pointer(handle, 'pointerup', 198);
    await act(async () => undefined);
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(validations[0]?.success).toBe(true);
    const first = writes[0]!;
    expect(first.input).toEqual({
      revision: 10,
      groups: [...initial.items.slice(1), initial.items[0]!].map(({ id, name }) => ({ id, name })),
    });
    expect(first.input).not.toHaveProperty('roomId');
    expect(first.init.credentials).toBe('include');
    expect(new Headers(first.init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(first.init.headers).get('X-CSRF-Token')).toBe('integration-only-csrf');
    await screen.findByText('변경 사항을 저장했습니다.');
    await waitFor(() => expect(handle).toHaveAttribute('aria-disabled', 'false'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect([...list.children].map((row) => row.getAttribute('data-sort-id'))).toEqual([
      ...initial.items.slice(1).map((group) => group.id),
      initial.items[0]!.id,
    ]);

    pointer(handle, 'pointerdown', 198);
    // Drop in the first row's upper half to insert before it.
    pointer(handle, 'pointermove', 10);
    pointer(handle, 'pointerup', 10);
    await act(async () => undefined);
    expect(writes).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(validations[1]?.success).toBe(true);
    expect(writes[1]?.input).toEqual({
      revision: 11,
      groups: initial.items.map(({ id, name }) => ({ id, name })),
    });
    await waitFor(() => expect(handle).toHaveAttribute('aria-disabled', 'false'));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(2);
  },
);
