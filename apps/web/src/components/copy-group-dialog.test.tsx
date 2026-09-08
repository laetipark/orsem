import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WatchRoom } from '@orsem/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import type { WatchlistGroup } from '../types';
import { CopyGroupDialog } from './watchlist-group-editors';

const actor = 'MEMBER:viewer';
const group: WatchlistGroup = {
  id: 'personal-group',
  name: '반도체',
  kind: 'PERSONAL',
  isShared: false,
  isFollowing: false,
  canEdit: true,
  revision: 7,
  itemCount: 3,
  ownerLabel: '나',
  updatedAt: '2026-09-07T00:00:00.000Z',
};
const room = (values: Partial<WatchRoom> = {}): WatchRoom => ({
  id: 'existing-room',
  name: '함께 보는 종목',
  description: '',
  ownerLabel: '나',
  role: 'OWNER',
  revision: 0,
  memberCount: 1,
  canManageGroups: true,
  canManageStocks: true,
  canManageMembers: true,
  ...values,
});
const created = room({ id: 'created-room', name: '새 관찰방', description: '장기 관찰' });
let client: QueryClient;
const onClose = vi.fn();

function view(rooms: WatchRoom[]) {
  return (
    <QueryClientProvider client={client}>
      <CopyGroupDialog actor={actor} group={group} rooms={rooms} onClose={onClose} />
    </QueryClientProvider>
  );
}
function fillRoom(name = ' 새 관찰방 ', description = ' 장기 관찰 ') {
  fireEvent.click(screen.getByRole('button', { name: '새 공유방 만들기' }));
  fireEvent.change(screen.getByRole('textbox', { name: '방 이름' }), { target: { value: name } });
  fireEvent.change(screen.getByRole('textbox', { name: '소개' }), {
    target: { value: description },
  });
}
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  onClose.mockReset();
  vi.spyOn(api, 'createWatchlistRoom').mockResolvedValue(created);
  vi.spyOn(api, 'copyWatchlistGroup').mockResolvedValue({
    ...group,
    id: 'copy',
    kind: 'ROOM',
    roomId: created.id,
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

it('shares as an independent copy and only offers rooms with both management permissions', async () => {
  render(
    view([
      room(),
      room({ id: 'readonly', name: '읽기 전용', canManageGroups: false, canManageStocks: false }),
      room({ id: 'groups-only', name: '그룹만 관리', canManageStocks: false }),
      room({ id: 'stocks-only', name: '종목만 관리', canManageGroups: false }),
    ]),
  );
  expect(screen.getByRole('dialog', { name: '공유' })).toBeInTheDocument();
  expect(
    screen.getByText(/개인 그룹은 유지되며 복사한 뒤에는 서로 독립적으로 관리/),
  ).toBeInTheDocument();
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('combobox', { name: '복사할 공유방' })).toHaveValue('existing-room');
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.copyWatchlistGroup).toHaveBeenCalledWith(group.id, 'existing-room', 7);
  expect(api.createWatchlistRoom).not.toHaveBeenCalled();
});

it('creates and selects a new room before parent refresh, then waits for a separate copy action', async () => {
  vi.spyOn(client, 'invalidateQueries').mockImplementation(() => new Promise(() => {}));
  const rendered = render(view([]));
  expect(screen.getByRole('button', { name: '복사' })).toBeDisabled();
  fillRoom();
  expect(screen.getByRole('textbox', { name: '방 이름' })).toHaveAttribute('maxlength', '80');
  expect(screen.getByRole('textbox', { name: '소개' })).toHaveAttribute('maxlength', '500');
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: '복사할 공유방' })).toHaveValue(created.id),
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '복사' })).toBeEnabled());
  expect(api.createWatchlistRoom).toHaveBeenCalledWith('새 관찰방', '장기 관찰');
  expect(api.copyWatchlistGroup).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toHaveTextContent('복사를 누르면 이 방에 그룹이 추가됩니다');
  rendered.rerender(view([room()]));
  expect(screen.getByRole('combobox', { name: '복사할 공유방' })).toHaveValue(created.id);
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  await waitFor(() => expect(api.copyWatchlistGroup).toHaveBeenCalledWith(group.id, created.id, 7));
  expect(api.createWatchlistRoom).toHaveBeenCalledOnce();
});

it('retries a failed copy in the already-created room without creating another room', async () => {
  vi.mocked(api.copyWatchlistGroup).mockRejectedValueOnce(new Error('복사를 완료하지 못했습니다.'));
  render(view([]));
  fillRoom();
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '복사' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('복사를 완료하지 못했습니다');
  expect(screen.getByRole('combobox', { name: '복사할 공유방' })).toHaveValue(created.id);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.createWatchlistRoom).toHaveBeenCalledOnce();
  expect(api.copyWatchlistGroup).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.copyWatchlistGroup).mock.calls).toEqual([
    [group.id, created.id, 7],
    [group.id, created.id, 7],
  ]);
});

it('retains creation inputs on failure and does not submit an empty name or copy automatically', async () => {
  vi.mocked(api.createWatchlistRoom).mockRejectedValueOnce(
    new Error('공유방을 만들지 못했습니다.'),
  );
  render(view([]));
  fillRoom('   ');
  expect(screen.getByRole('button', { name: '만들기' })).toBeDisabled();
  const name = screen.getByRole('textbox', { name: '방 이름' });
  fireEvent.submit(name.closest('form')!);
  expect(api.createWatchlistRoom).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: '새 관찰방' } });
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('공유방을 만들지 못했습니다');
  expect(name).toHaveValue('새 관찰방');
  expect(screen.getByRole('textbox', { name: '소개' })).toHaveValue(' 장기 관찰 ');
  expect(screen.getByRole('button', { name: '복사' })).toBeDisabled();
  expect(api.copyWatchlistGroup).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('uses refreshed room permissions and does not resurrect a removed room after server acknowledgement', async () => {
  const rendered = render(view([]));
  fillRoom();
  fireEvent.click(screen.getByRole('button', { name: '만들기' }));
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: '복사할 공유방' })).toHaveValue(created.id),
  );
  rendered.rerender(view([created]));
  expect(screen.getAllByRole('option')).toHaveLength(1);
  rendered.rerender(view([{ ...created, canManageStocks: false }]));
  expect(screen.queryByRole('option', { name: created.name })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '복사' })).toBeDisabled();
  rendered.rerender(view([]));
  expect(screen.queryByRole('option', { name: created.name })).not.toBeInTheDocument();
  expect(api.copyWatchlistGroup).not.toHaveBeenCalled();
});

it('requires a new manual selection when the chosen room loses permission even if another room remains', async () => {
  const chosen = room({ id: 'chosen-room', name: '선택한 방' });
  const backup = room();
  const rendered = render(view([backup, chosen]));
  const select = screen.getByRole('combobox', { name: '복사할 공유방' });
  fireEvent.change(select, { target: { value: chosen.id } });
  expect(select).toHaveValue(chosen.id);
  rendered.rerender(view([backup, { ...chosen, canManageStocks: false }]));
  expect(select).toHaveValue('');
  expect(screen.getByRole('option', { name: '공유방을 다시 선택해 주세요' })).toBeInTheDocument();
  expect(select).toBeEnabled();
  expect(screen.getByRole('button', { name: '복사' })).toBeDisabled();
  expect(api.copyWatchlistGroup).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: backup.id } });
  expect(screen.getByRole('button', { name: '복사' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  await waitFor(() => expect(api.copyWatchlistGroup).toHaveBeenCalledWith(group.id, backup.id, 7));
});

it('does not copy into an existing room while the new-room form is being written', () => {
  render(view([room()]));
  expect(screen.getByRole('button', { name: '복사' })).toBeEnabled();
  fillRoom();
  expect(screen.getByRole('button', { name: '복사' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '복사' }));
  expect(api.copyWatchlistGroup).not.toHaveBeenCalled();
  expect(api.createWatchlistRoom).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '새 공유방 만들기' }));
  expect(screen.getByRole('button', { name: '복사' })).toBeEnabled();
});
