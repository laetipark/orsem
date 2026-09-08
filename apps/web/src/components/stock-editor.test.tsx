import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Company, WatchlistGroup } from '@orsem/contracts';
import { api } from '../lib/api';
import { StockEditor } from './watchlist-group-editors';

const group: WatchlistGroup = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '관심 기업',
  kind: 'PERSONAL',
  revision: 7,
  isShared: false,
  isFollowing: false,
  canEdit: true,
  canManageStocks: true,
  itemCount: 2,
  ownerLabel: '나',
  updatedAt: '2026-09-07T00:00:00Z',
};
const companies: Company[] = ['첫 기업', '둘째 기업'].map((nameKo, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  market: 'KOSPI',
  corpCode: null,
  stockCode: `00000${index + 1}`,
  ticker: null,
  cik: null,
  nameKo,
  nameEn: null,
  isListed: true,
  updatedAt: '2026-09-07T00:00:00Z',
}));
let client: QueryClient;
const close = vi.fn();
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  vi.spyOn(api, 'editWatchlistGroup').mockResolvedValue({ group, items: companies, revision: 7 });
  vi.spyOn(api, 'saveWatchlistGroupItems').mockResolvedValue(undefined);
  close.mockReset();
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});
async function open() {
  render(
    <QueryClientProvider client={client}>
      <StockEditor actor="MEMBER:viewer" group={group} onClose={close} />
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: '첫 기업 순서 변경' });
  return screen.getByRole('list', { name: '편집할 종목' });
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
    pointerType: { value: 'mouse' },
    isPrimary: { value: true },
  });
  fireEvent(target, event);
}
it('shows a drop position, stages drag and right-edge deletion, and sends the final IDs only on Save', async () => {
  const list = await open();
  const rows = within(list).getAllByRole('listitem');
  for (const [index, row] of rows.entries()) {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      top: index * 52,
      bottom: (index + 1) * 52,
      height: 52,
      width: 300,
      left: 0,
      right: 300,
      x: 0,
      y: index * 52,
      toJSON() {},
    });
    const controls = within(row).getAllByRole('button');
    expect(controls[0]).toHaveAccessibleName(`${companies[index]!.nameKo} 순서 변경`);
    expect(controls.at(-1)).toHaveAccessibleName(`${companies[index]!.nameKo} 삭제`);
  }
  const handle = screen.getByRole('button', { name: '첫 기업 순서 변경' });
  pointer(handle, 'pointerdown', 26);
  pointer(handle, 'pointermove', 90);
  expect(screen.getByText('아래에 놓기')).toBeInTheDocument();
  pointer(handle, 'pointerup', 90);
  expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('둘째 기업');
  expect(api.saveWatchlistGroupItems).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '첫 기업 삭제' }));
  expect(screen.queryByRole('button', { name: '첫 기업 삭제' })).not.toBeInTheDocument();
  expect(api.saveWatchlistGroupItems).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() =>
    expect(api.saveWatchlistGroupItems).toHaveBeenCalledExactlyOnceWith(group.id, 7, [
      companies[1]!.id,
    ]),
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it('closes without saving a removed stock when Cancel is chosen', async () => {
  await open();
  fireEvent.click(screen.getByRole('button', { name: '첫 기업 삭제' }));
  fireEvent.click(screen.getByRole('button', { name: '취소' }));
  expect(close).toHaveBeenCalledOnce();
  expect(api.saveWatchlistGroupItems).not.toHaveBeenCalled();
});
