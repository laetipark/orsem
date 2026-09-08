import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('copies only watchlist selection and resets compact pagination when opening', async () => {
  const { watchlistPopoutParams } = await import('./watchlist-popout');
  const params = new URLSearchParams(
    'watchRoom=room-1&watchGroup=recent&watchView=list&watchContent=news&watchCompany=corp&watchNewsType=filings&watchPage=3&watchWindow=pip&q=private&returnTo=https://elsewhere.test',
  );
  expect(Object.fromEntries(watchlistPopoutParams(params))).toEqual({
    watchRoom: 'room-1',
    watchGroup: 'recent',
    watchCompany: 'corp',
    watchView: 'list',
    watchContent: 'news',
    watchNewsType: 'filings',
  });
  expect(watchlistPopoutParams(params, true).get('watchPage')).toBe('3');
  expect(params.get('watchPage')).toBe('3');
  expect(
    watchlistPopoutParams(new URLSearchParams('watchView=bad&watchContent=bad&watchPage=-2'), true)
      .size,
  ).toBe(0);
});

it('opens a bounded named popup, focuses it and reuses it for another group', async () => {
  const { openWatchlistPopout } = await import('./watchlist-popout');
  const location = { href: '', replace: vi.fn() };
  const popup = { closed: false, location, focus: vi.fn() } as unknown as Window;
  const open = vi.spyOn(window, 'open').mockReturnValue(popup);
  vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(480);
  vi.spyOn(window.screen, 'availHeight', 'get').mockReturnValue(640);
  expect(openWatchlistPopout(new URLSearchParams('watchGroup=first&watchPage=2'))).toBe(true);
  expect(open).toHaveBeenCalledWith(
    `${window.location.origin}/watchlist/popout?watchGroup=first`,
    'orsem-watchlist-popout',
    'popup=yes,width=480,height=640,resizable=yes,scrollbars=yes',
  );
  expect(openWatchlistPopout(new URLSearchParams('watchGroup=second'))).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
  expect(location.replace).toHaveBeenCalledWith(
    `${window.location.origin}/watchlist/popout?watchGroup=second`,
  );
  expect(popup.focus).toHaveBeenCalledTimes(2);
});

it('reports a blocked popup without navigating the current page', async () => {
  const { openWatchlistPopout } = await import('./watchlist-popout');
  const before = window.location.href;
  vi.spyOn(window, 'open').mockReturnValue(null);
  expect(openWatchlistPopout(new URLSearchParams())).toBe(false);
  expect(window.location.href).toBe(before);
});

it('requires a secure top-level window and an available PiP API', async () => {
  const { canPinWatchlistWindow } = await import('./watchlist-popout');
  const host = {
    isSecureContext: true,
    documentPictureInPicture: { requestWindow: vi.fn() },
  } as unknown as Window;
  Object.defineProperty(host, 'top', { configurable: true, value: host });
  expect(canPinWatchlistWindow(host)).toBe(true);
  Object.defineProperty(host, 'top', { configurable: true, value: window });
  expect(canPinWatchlistWindow(host)).toBe(false);
  Object.defineProperty(host, 'top', { configurable: true, value: host });
  Object.defineProperty(host, 'isSecureContext', { value: false });
  expect(canPinWatchlistWindow(host)).toBe(false);
});

it('loads the full same-origin standalone app in a PiP iframe with its current selection', async () => {
  const { openWatchlistPictureInPicture } = await import('./watchlist-popout');
  const container = document.createElement('iframe');
  document.body.append(container);
  const pip = container.contentWindow!;
  const requestWindow = vi.fn().mockResolvedValue(pip);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('documentPictureInPicture', { window: null, requestWindow });
  const result = await openWatchlistPictureInPicture(
    new URLSearchParams('watchGroup=recent&watchView=list&watchPage=2&unrelated=1'),
  );
  expect(result.window).toBe(pip);
  expect(requestWindow).toHaveBeenCalledWith({ width: 720, height: 760 });
  expect(result.iframe.src).toBe(
    `${window.location.origin}/watchlist/popout?watchGroup=recent&watchView=list&watchPage=2&watchWindow=pip`,
  );
  expect(result.iframe.title).toBe('관심 종목 항상 위 창');
  expect(result.iframe.hasAttribute('sandbox')).toBe(false);
  expect(pip.document.documentElement.lang).toBe('ko');
});

it('accepts state only from the exact PiP iframe and origin and strips unrelated fields', async () => {
  const { WATCHLIST_POPOUT_MESSAGE, readWatchlistPopoutMessage } =
    await import('./watchlist-popout');
  const source = {} as Window;
  const data = {
    type: WATCHLIST_POPOUT_MESSAGE,
    action: 'unpin',
    search: 'watchGroup=next&watchContent=news&watchWindow=pip&watchPage=1&redirect=//bad.test',
  };
  const event = new MessageEvent('message', {
    data,
    source,
    origin: window.location.origin,
  });
  expect(readWatchlistPopoutMessage(event, source, window.location.origin)).toEqual({
    type: WATCHLIST_POPOUT_MESSAGE,
    action: 'unpin',
    search: 'watchGroup=next&watchContent=news&watchPage=1',
  });
  expect(readWatchlistPopoutMessage(event, {} as Window, window.location.origin)).toBeNull();
  expect(readWatchlistPopoutMessage(event, source, 'https://unrelated.test')).toBeNull();
  expect(readWatchlistPopoutMessage(event, null, window.location.origin)).toBeNull();
  expect(
    readWatchlistPopoutMessage(
      new MessageEvent('message', {
        source,
        origin: window.location.origin,
        data: { ...data, action: ['unpin'] },
      }),
      source,
      window.location.origin,
    ),
  ).toBeNull();
});

it('recognizes only an iframe belonging to its owner’s current PiP window', async () => {
  const { watchlistPictureInPictureOwner } = await import('./watchlist-popout');
  const owner = { documentPictureInPicture: { window: null as unknown } };
  const parent = { opener: owner };
  const frame = { parent } as unknown as Window;
  expect(watchlistPictureInPictureOwner(frame)).toBeNull();
  owner.documentPictureInPicture.window = parent;
  expect(watchlistPictureInPictureOwner(frame)).toBe(owner);
  expect(watchlistPictureInPictureOwner(window)).toBeNull();
});
