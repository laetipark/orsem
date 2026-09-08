export const WATCHLIST_POPOUT_PATH = '/watchlist/popout';
export const WATCHLIST_POPOUT_MESSAGE = 'orsem:watchlist-popout';
const windowName = 'orsem-watchlist-popout';
let popupWindow: Window | null = null;

type PictureInPictureApi = {
  window: Window | null;
  requestWindow: (options: { width: number; height: number }) => Promise<Window>;
};

type PictureInPictureHost = Window & { documentPictureInPicture?: PictureInPictureApi };

/** Only copy watchlist state; never forward unrelated page parameters to another window. */
export function watchlistPopoutParams(params: URLSearchParams, preservePage = false) {
  const next = new URLSearchParams();
  for (const key of ['watchRoom', 'watchGroup', 'watchCompany']) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  for (const [key, allowed] of [
    ['watchView', ['grid', 'list']],
    ['watchContent', ['stocks', 'news']],
    ['watchNewsType', ['news', 'filings']],
  ] as const) {
    const value = params.get(key);
    if (value && (allowed as readonly string[]).includes(value)) next.set(key, value);
  }
  if (preservePage) {
    const page = Number(params.get('watchPage'));
    if (Number.isSafeInteger(page) && page > 0) next.set('watchPage', String(page));
  }
  return next;
}

function popoutUrl(params: URLSearchParams, host: Window, pip = false) {
  const url = new URL(WATCHLIST_POPOUT_PATH, host.location.origin);
  const search = watchlistPopoutParams(params, pip);
  if (pip) search.set('watchWindow', 'pip');
  url.search = search.toString();
  return url.href;
}

function initialSize(host: Window) {
  return {
    width: Math.max(100, Math.min(720, host.screen.availWidth || 720)),
    height: Math.max(100, Math.min(760, host.screen.availHeight || 760)),
  };
}

/** Call synchronously from a click so popup blockers can recognize the user gesture. */
export function openWatchlistPopout(params: URLSearchParams): boolean {
  const url = popoutUrl(params, window);
  try {
    if (popupWindow && !popupWindow.closed) {
      if (popupWindow.location.href !== url) popupWindow.location.replace(url);
    } else {
      const { width, height } = initialSize(window);
      popupWindow = window.open(
        url,
        windowName,
        `popup=yes,width=${width},height=${height},resizable=yes,scrollbars=yes`,
      );
    }
    if (!popupWindow) return false;
  } catch {
    popupWindow = null;
    return false;
  }
  try {
    popupWindow.focus();
  } catch {
    // The browser may decline focus even though it successfully opened the window.
  }
  return true;
}

export function canPinWatchlistWindow(host: Window = window): boolean {
  try {
    return (
      host.isSecureContext === true &&
      host.top === host &&
      typeof (host as PictureInPictureHost).documentPictureInPicture?.requestWindow === 'function'
    );
  } catch {
    return false;
  }
}

/** The iframe owns its app runtime, visibility, styles and polling timers. */
export async function openWatchlistPictureInPicture(params: URLSearchParams) {
  const api = (window as PictureInPictureHost).documentPictureInPicture;
  if (!canPinWatchlistWindow() || !api) throw new Error('항상 위 고정을 지원하지 않습니다.');
  const pipWindow = await api.requestWindow(initialSize(window));
  try {
    const { document } = pipWindow;
    document.title = '관심 종목 · 오르셈';
    document.documentElement.lang = 'ko';
    const style = document.createElement('style');
    style.textContent =
      'html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}';
    document.head.append(style);
    const iframe = document.createElement('iframe');
    iframe.title = '관심 종목 항상 위 창';
    iframe.src = popoutUrl(params, window, true);
    document.body.append(iframe);
    return { window: pipWindow, iframe };
  } catch (error) {
    pipWindow.close();
    throw error;
  }
}

/** Verify the parent is this application's actual PiP window, not just any iframe host. */
export function watchlistPictureInPictureOwner(host: Window = window): Window | null {
  try {
    if (host.parent === host) return null;
    const owner = host.parent.opener as PictureInPictureHost | null;
    return owner?.documentPictureInPicture?.window === host.parent ? owner : null;
  } catch {
    return null;
  }
}

type PopoutAction = 'selection' | 'unpin' | 'close' | 'session-ended';
export type WatchlistPopoutMessage = {
  type: typeof WATCHLIST_POPOUT_MESSAGE;
  action: PopoutAction;
  search: string;
};

export function postWatchlistPopoutMessage(
  owner: Window,
  action: PopoutAction,
  params: URLSearchParams,
) {
  owner.postMessage(
    {
      type: WATCHLIST_POPOUT_MESSAGE,
      action,
      search: watchlistPopoutParams(params, true).toString(),
    } satisfies WatchlistPopoutMessage,
    window.location.origin,
  );
}

export function readWatchlistPopoutMessage(
  event: MessageEvent<unknown>,
  source: Window | null,
  origin: string,
): WatchlistPopoutMessage | null {
  if (!source || event.source !== source || event.origin !== origin) return null;
  const data = event.data;
  if (
    !data ||
    typeof data !== 'object' ||
    !('type' in data) ||
    data.type !== WATCHLIST_POPOUT_MESSAGE ||
    !('action' in data) ||
    typeof data.action !== 'string' ||
    !['selection', 'unpin', 'close', 'session-ended'].includes(data.action) ||
    !('search' in data) ||
    typeof data.search !== 'string'
  )
    return null;
  return {
    type: WATCHLIST_POPOUT_MESSAGE,
    action: data.action as PopoutAction,
    search: watchlistPopoutParams(new URLSearchParams(data.search), true).toString(),
  };
}
