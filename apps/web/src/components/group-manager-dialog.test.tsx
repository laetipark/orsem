import type { WatchPermissions } from '@orsem/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import type { WatchlistGroup } from '../types';
import { GroupManagerDialog } from './group-manager-dialog';

const actor = 'MEMBER:viewer';
const queryKey = ['watchlist-v2', actor, 'groups', 'room'];
const permissions: WatchPermissions = {
  canManageGroups: true,
  canManageStocks: true,
  canManageMembers: false,
};
const group = (id: string, name: string, itemCount = 1): WatchlistGroup => ({
  id,
  name,
  itemCount,
  kind: 'ROOM',
  roomId: 'room',
  revision: 1,
  isShared: true,
  isFollowing: false,
  canEdit: true,
  ownerLabel: '방장',
  updatedAt: '2026-09-07T00:00:00Z',
  ...permissions,
});
const initial = {
  items: [group('a', '반도체'), group('b', '배당주', 0)],
  revision: 1,
  permissions,
};
let client: QueryClient;
let onClose: ReturnType<typeof vi.fn>;
function open() {
  render(
    <QueryClientProvider client={client}>
      <GroupManagerDialog actor={actor} roomId="room" onClose={onClose} />
    </QueryClientProvider>,
  );
}
async function rename() {
  fireEvent.click(await screen.findByRole('button', { name: '반도체 이름 수정' }));
  return screen.getByRole('textbox', { name: '그룹 이름' });
}
function rowIds() {
  return within(screen.getByRole('list', { name: '관심 그룹' }))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('data-sort-id'));
}
function pointer(target: HTMLElement, type: string, clientY: number) {
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
    pointerType: { value: 'touch' },
    isPrimary: { value: true },
  });
  fireEvent(target, event);
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  onClose = vi.fn();
  vi.spyOn(api, 'watchlistGroups').mockResolvedValue(structuredClone(initial));
  vi.spyOn(api, 'saveWatchlistGroups').mockResolvedValue(undefined);
  vi.spyOn(api, 'watchlistRooms');
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('keeps one footer cancel/save pair and inline row controls', async () => {
  open();
  await screen.findByRole('button', { name: '반도체 이름 수정' });
  expect(screen.getAllByRole('button', { name: '종목 설정' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: '반도체 그룹 삭제' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '반도체 순서 변경' })).toBeEnabled();
  expect(screen.getAllByRole('button', { name: '취소' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: '저장' })).toHaveLength(1);
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  expect(
    screen.queryByRole('button', {
      name: /최신 목록 확인|순서 저장|완료|방 순서|그룹 이름·순서·삭제/,
    }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/그룹과 관심 종목을 이곳에서 관리/)).not.toBeInTheDocument();
  expect(api.watchlistRooms).not.toHaveBeenCalled();
});

it('saves an inline name only from the footer and protects the confirmed revision from an old refetch', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: ' 성장 반도체 ' } });
  expect(screen.getAllByRole('button', { name: '저장' })).toHaveLength(1);
  fireEvent.keyDown(screen.getByRole('textbox', { name: '그룹 이름' }), { key: 'Enter' });
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  const edit = await screen.findByRole('button', { name: '성장 반도체 이름 수정' });
  await waitFor(() => expect(edit).toBeEnabled());
  expect(api.saveWatchlistGroups).toHaveBeenCalledExactlyOnceWith({
    roomId: 'room',
    revision: 1,
    groups: [
      { id: 'a', name: '성장 반도체' },
      { id: 'b', name: '배당주' },
    ],
  });
  fireEvent.click(edit);
  fireEvent.change(screen.getByRole('textbox', { name: '그룹 이름' }), {
    target: { value: '새 이름' },
  });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByRole('button', { name: '새 이름 이름 수정' });
  expect(vi.mocked(api.saveWatchlistGroups).mock.calls[1]?.[0].revision).toBe(2);
  expect(onClose).not.toHaveBeenCalled();
});

it('closes and discards unsaved changes when the footer cancel button is used', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '초안' } });
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole('textbox', { name: '그룹 이름' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeInTheDocument();
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
});

it('combines repeated order changes, an inline rename and a confirmed deletion in one explicit save', async () => {
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    ...initial,
    items: [...initial.items, group('c', '성장주')],
  });
  open();
  fireEvent.keyDown(await screen.findByRole('button', { name: '반도체 순서 변경' }), {
    key: 'End',
  });
  expect(rowIds()).toEqual(['b', 'c', 'a']);
  fireEvent.keyDown(screen.getByRole('button', { name: '배당주 순서 변경' }), { key: 'End' });
  expect(rowIds()).toEqual(['c', 'a', 'b']);
  fireEvent.change(await rename(), { target: { value: '새 반도체' } });
  fireEvent.click(screen.getByRole('button', { name: '성장주 그룹 삭제' }));
  expect(screen.getByRole('group', { name: '성장주 삭제 확인' })).toHaveTextContent('하단 저장');
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() =>
    expect(api.saveWatchlistGroups).toHaveBeenCalledExactlyOnceWith({
      roomId: 'room',
      revision: 1,
      groups: [
        { id: 'a', name: '새 반도체' },
        { id: 'b', name: '배당주' },
      ],
    }),
  );
  await waitFor(() => expect(rowIds()).toEqual(['a', 'b']));
});

it('automatically refreshes a 409 while retaining draft order and names, then waits for another save click', async () => {
  open();
  fireEvent.keyDown(await screen.findByRole('button', { name: '반도체 순서 변경' }), {
    key: 'ArrowDown',
  });
  fireEvent.change(await rename(), { target: { value: '내 초안' } });
  const latest = {
    ...initial,
    revision: 5,
    items: [group('a', '다른 이름'), initial.items[1]!, group('c', '새 그룹')],
  };
  vi.mocked(api.watchlistGroups).mockResolvedValue(latest);
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new ApiError(409, 'CONFLICT', '충돌'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('저장을 다시 눌러');
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
  expect(screen.getByRole('textbox', { name: '그룹 이름' })).toHaveValue('내 초안');
  expect(rowIds()).toEqual(['b', 'a', 'c']);
  expect(api.watchlistGroups).toHaveBeenCalledTimes(2);
  expect(api.saveWatchlistGroups).toHaveBeenCalledExactlyOnceWith({
    roomId: 'room',
    revision: 1,
    groups: [
      { id: 'b', name: '배당주' },
      { id: 'a', name: '내 초안' },
    ],
  });
  expect(screen.queryByRole('button', { name: '최신 목록 확인' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByRole('button', { name: '내 초안 이름 수정' });
  expect(vi.mocked(api.saveWatchlistGroups).mock.calls[1]?.[0]).toEqual({
    roomId: 'room',
    revision: 5,
    groups: [
      { id: 'b', name: '배당주' },
      { id: 'a', name: '내 초안' },
      { id: 'c', name: '새 그룹' },
    ],
  });
});

it('preserves a concurrent server order when the local draft only renamed a group', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '내 이름' } });
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    ...initial,
    revision: 3,
    items: [...initial.items].reverse(),
  });
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new ApiError(409, 'CONFLICT', '충돌'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
  expect(rowIds()).toEqual(['b', 'a']);
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.saveWatchlistGroups).mock.calls[1]?.[0]).toMatchObject({
    revision: 3,
    groups: [
      { id: 'b', name: '배당주' },
      { id: 'a', name: '내 이름' },
    ],
  });
});

it('shows deletion consequences without extra buttons and commits only from the footer', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: '반도체 그룹 삭제' }));
  const confirmation = screen.getByRole('group', { name: '반도체 삭제 확인' });
  expect(confirmation).toHaveTextContent('등록된 1종목');
  expect(confirmation).toHaveTextContent('모든 참여자');
  expect(within(confirmation).queryByRole('button')).not.toBeInTheDocument();
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '반도체 삭제 취소' }));
  expect(screen.queryByRole('group', { name: '반도체 삭제 확인' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '반도체 그룹 삭제' }));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(rowIds()).toEqual(['b']));
  expect(api.saveWatchlistGroups).toHaveBeenCalledExactlyOnceWith({
    roomId: 'room',
    revision: 1,
    groups: [{ id: 'b', name: '배당주' }],
  });
});

it('allows a group manager without stock permissions to delete only empty groups', async () => {
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    ...initial,
    permissions: { ...permissions, canManageStocks: false },
    items: initial.items.map((row) => ({ ...row, canManageStocks: false })),
  });
  open();
  expect(await screen.findByRole('button', { name: '반도체 그룹 삭제' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '배당주 그룹 삭제' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '종목 설정' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '반도체 이름 수정' })).toBeEnabled();
});

it('keeps a failed draft editable and retries only when the footer save is clicked again', async () => {
  open();
  fireEvent.keyDown(await screen.findByRole('button', { name: '반도체 순서 변경' }), {
    key: 'ArrowDown',
  });
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new Error('저장 실패'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText('저장 실패');
  expect(rowIds()).toEqual(['b', 'a']);
  expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '배당주 이름 수정' }));
  fireEvent.change(screen.getByRole('textbox', { name: '그룹 이름' }), {
    target: { value: '새 배당주' },
  });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByRole('button', { name: '새 배당주 이름 수정' });
  expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.saveWatchlistGroups).mock.calls[1]?.[0]).toMatchObject({
    revision: 1,
    groups: [
      { id: 'b', name: '새 배당주' },
      { id: 'a', name: '반도체' },
    ],
  });
});

it('shows the exact drop boundary and stages pointer order with the drag-start snapshot', async () => {
  open();
  const handle = await screen.findByRole('button', { name: '반도체 순서 변경' });
  const rows = within(screen.getByRole('list', { name: '관심 그룹' })).getAllByRole('listitem');
  rows.forEach((row, index) => {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, index * 60, 300, 60));
  });
  pointer(handle, 'pointerdown', 30);
  pointer(handle, 'pointermove', 110);
  expect(rows[0]).toHaveClass('is-dragging');
  expect(rows[1]).toHaveClass('is-drop-after');
  expect(rows[1]).not.toHaveClass('is-drop-before');
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  act(() => {
    client.setQueryData(queryKey, {
      ...initial,
      revision: 9,
      items: [group('a', '다른 사람이 수정'), initial.items[1]!],
    });
  });
  await screen.findByRole('button', { name: '다른 사람이 수정 이름 수정' });
  pointer(handle, 'pointerup', 110);
  expect(rowIds()).toEqual(['b', 'a']);
  expect(rows[1]).not.toHaveClass('is-drop-after');
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() =>
    expect(api.saveWatchlistGroups).toHaveBeenCalledExactlyOnceWith({
      roomId: 'room',
      revision: 1,
      groups: [
        { id: 'b', name: '배당주' },
        { id: 'a', name: '반도체' },
      ],
    }),
  );
});

it('removes edit controls and blocks unsaved changes immediately after permission loss', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '보존할 초안' } });
  act(() => {
    client.setQueryData(queryKey, {
      ...initial,
      revision: 2,
      permissions: { ...permissions, canManageGroups: false, canManageStocks: false },
    });
  });
  await waitFor(() => expect(screen.getByRole('textbox', { name: '그룹 이름' })).toBeDisabled());
  expect(screen.getByRole('textbox', { name: '그룹 이름' })).toHaveValue('보존할 초안');
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: /이름 수정|그룹 삭제|순서 변경|종목 설정/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.saveWatchlistGroups).not.toHaveBeenCalled();
});

it('rechecks permissions during automatic conflict recovery and never resubmits after access is removed', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '내 초안' } });
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    ...initial,
    revision: 4,
    permissions: { ...permissions, canManageGroups: false, canManageStocks: false },
  });
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new ApiError(409, 'CONFLICT', '충돌'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('권한이 없어 저장할 수 없습니다');
  expect(screen.getByRole('textbox', { name: '그룹 이름' })).toHaveValue('내 초안');
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(1);
});

it('uses save to retry a failed conflict refresh, then requires another click to write', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '내 초안' } });
  vi.mocked(api.watchlistGroups).mockRejectedValueOnce(new Error('조회 실패'));
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new ApiError(409, 'CONFLICT', '충돌'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await screen.findByText(/저장을 누르면 다시 확인합니다/);
  expect(screen.getByRole('textbox', { name: '그룹 이름' })).toHaveValue('내 초안');
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
  vi.mocked(api.watchlistGroups).mockResolvedValue({ ...initial, revision: 5 });
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled());
  expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.saveWatchlistGroups).mock.calls[1]?.[0].revision).toBe(5);
});

it('does not silently recreate or drop the name draft of a group deleted during a conflict', async () => {
  open();
  fireEvent.change(await rename(), { target: { value: '보존할 이름' } });
  vi.mocked(api.watchlistGroups).mockResolvedValue({
    ...initial,
    revision: 5,
    items: [initial.items[1]!],
  });
  vi.mocked(api.saveWatchlistGroups).mockRejectedValueOnce(new ApiError(409, 'CONFLICT', '충돌'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '수정 중인 그룹이 다른 곳에서 삭제되었습니다',
  );
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  expect(api.saveWatchlistGroups).toHaveBeenCalledTimes(1);
});
