import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as popout from '../lib/watchlist-popout';
import { WatchlistPopoutPage } from './watchlist-popout-page';

vi.mock('../lib/api', () => ({ isFixtureMode: false }));
vi.mock('../lib/watchlist-popout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/watchlist-popout')>()),
  canPinWatchlistWindow: vi.fn(() => true),
  openWatchlistPictureInPicture: vi.fn(),
  watchlistPictureInPictureOwner: vi.fn(() => null),
  postWatchlistPopoutMessage: vi.fn(),
}));
vi.mock('../components/watchlist-groups-panel', () => ({
  WatchlistGroupsPanel: ({
    floating,
    headerActions,
  }: {
    floating: boolean;
    headerActions: ReactNode;
  }) => (
    <section aria-label="전체 관심 종목 카드" data-floating={floating}>
      {headerActions}
    </section>
  ),
}));

const clients: QueryClient[] = [];
function Location() {
  const location = useLocation();
  return <output aria-label="현재 선택">{location.search}</output>;
}
function show(search = 'watchGroup=first&watchView=list') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <StrictMode>
        <MemoryRouter initialEntries={[`/watchlist/popout?${search}`]}>
          <WatchlistPopoutPage />
          <Location />
        </MemoryRouter>
      </StrictMode>
    </QueryClientProvider>,
  );
  return { ...view, client };
}
function pictureInPicture() {
  const wrapper = document.createElement('iframe');
  document.body.append(wrapper);
  const pipWindow = wrapper.contentWindow!;
  const iframe = pipWindow.document.createElement('iframe');
  pipWindow.document.body.append(iframe);
  const close = vi.spyOn(pipWindow, 'close').mockImplementation(() => {
    pipWindow.dispatchEvent(new Event('pagehide'));
  });
  const result = { window: pipWindow, iframe };
  vi.mocked(popout.openWatchlistPictureInPicture).mockResolvedValue(result);
  return { ...result, close };
}
function message(
  source: Window | null,
  action: string,
  search: string,
  origin = window.location.origin,
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin,
      data: { type: popout.WATCHLIST_POPOUT_MESSAGE, action, search },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(popout.canPinWatchlistWindow).mockReturnValue(true);
  vi.mocked(popout.watchlistPictureInPictureOwner).mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it('renders the full floating card with attribution and a disabled unsupported pin control', () => {
  vi.mocked(popout.canPinWatchlistWindow).mockReturnValue(false);
  show();
  expect(screen.getByRole('region', { name: '전체 관심 종목 카드' })).toHaveAttribute(
    'data-floating',
    'true',
  );
  expect(screen.getByRole('button', { name: '항상 위로 고정' })).toBeDisabled();
  expect(
    screen.getByText('이 브라우저에서는 항상 위 고정을 지원하지 않습니다.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Logos provided by Logo.dev' })).toBeNull();
  expect(screen.queryByRole('link', { name: '로고 출처·이용 안내' })).not.toBeInTheDocument();
  expect(screen.getByText(/어떤 항목도 자동 매수·매도 추천/)).toBeInTheDocument();
});

it('keeps the ordinary card available when PiP opening fails', async () => {
  vi.mocked(popout.openWatchlistPictureInPicture).mockRejectedValue(new Error('not allowed'));
  show();
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('일반 관심 종목 창을 계속 이용');
  expect(screen.getByRole('region', { name: '전체 관심 종목 카드' })).toBeInTheDocument();
});

it('unmounts duplicate polling content while pinned and restores the latest trusted selection on native close', async () => {
  const pip = pictureInPicture();
  show();
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  expect(await screen.findByRole('region', { name: '항상 위 표시 상태' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '전체 관심 종목 카드' })).not.toBeInTheDocument();
  act(() => {
    message(pip.iframe.contentWindow, 'selection', 'watchGroup=next&watchContent=news&watchPage=2');
    message(window, 'selection', 'watchGroup=forged');
    message(pip.iframe.contentWindow, 'selection', 'watchGroup=foreign', 'https://foreign.test');
    pip.window.dispatchEvent(new Event('pagehide'));
  });
  expect(screen.getByRole('region', { name: '전체 관심 종목 카드' })).toBeInTheDocument();
  expect(screen.getByLabelText('현재 선택')).toHaveTextContent(
    'watchGroup=next&watchContent=news&watchPage=2',
  );
  expect(screen.getByLabelText('현재 선택')).not.toHaveTextContent('watchWindow');
});

it('handles iframe unpin after saving its latest search and disposes on route unmount', async () => {
  const pip = pictureInPicture();
  const view = show();
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  await screen.findByRole('region', { name: '항상 위 표시 상태' });
  act(() => message(pip.iframe.contentWindow, 'unpin', 'watchGroup=recent&watchView=grid'));
  expect(pip.close).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('현재 선택')).toHaveTextContent('watchGroup=recent&watchView=grid');
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  await screen.findByRole('region', { name: '항상 위 표시 상태' });
  view.unmount();
  expect(pip.close).toHaveBeenCalledTimes(2);
});

it('closes a PiP request that resolves after the authenticated StrictMode page unmounts', async () => {
  const pip = pictureInPicture();
  let resolve!: (value: { window: Window; iframe: HTMLIFrameElement }) => void;
  vi.mocked(popout.openWatchlistPictureInPicture).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = show();
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  view.unmount();
  await act(async () => resolve(pip));
  expect(pip.close).toHaveBeenCalledOnce();
});

it('closes PiP and hides the private card while the host session is revalidated after access loss', async () => {
  const pip = pictureInPicture();
  const view = show();
  const reset = vi.spyOn(view.client, 'resetQueries');
  fireEvent.click(screen.getByRole('button', { name: '항상 위로 고정' }));
  await screen.findByRole('region', { name: '항상 위 표시 상태' });
  act(() => message(pip.iframe.contentWindow, 'session-ended', 'watchGroup=next'));
  expect(pip.close).toHaveBeenCalledOnce();
  expect(reset).toHaveBeenCalledWith({ queryKey: ['session'], exact: true });
  expect(screen.getByText('보안 세션을 다시 확인하는 중입니다.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '전체 관심 종목 카드' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('현재 선택')).toHaveTextContent('watchGroup=next');
});

it('offers unpin inside the verified PiP iframe and focuses its owner before posting', async () => {
  const owner = { focus: vi.fn() } as unknown as Window;
  vi.mocked(popout.watchlistPictureInPictureOwner).mockReturnValue(owner);
  vi.mocked(popout.canPinWatchlistWindow).mockReturnValue(false);
  show('watchGroup=recent&watchWindow=pip');
  fireEvent.click(screen.getByRole('button', { name: '항상 위 고정 해제' }));
  expect(owner.focus).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(popout.postWatchlistPopoutMessage).toHaveBeenCalledWith(
      owner,
      'unpin',
      expect.any(URLSearchParams),
    ),
  );
  expect(popout.openWatchlistPictureInPicture).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '항상 위 창 닫기' }));
  expect(popout.postWatchlistPopoutMessage).toHaveBeenCalledWith(
    owner,
    'close',
    expect.any(URLSearchParams),
  );
});
