import { Pin, PinOff, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ObservationDisclaimer } from '../components/disclaimer';
import { WatchlistGroupsPanel } from '../components/watchlist-groups-panel';
import { Badge, Button, LoadingState } from '../components/ui';
import { isFixtureMode } from '../lib/api';
import { useNewsCacheExpiry } from '../lib/news-cache';
import {
  canPinWatchlistWindow,
  openWatchlistPictureInPicture,
  postWatchlistPopoutMessage,
  readWatchlistPopoutMessage,
  watchlistPictureInPictureOwner,
  watchlistPopoutParams,
} from '../lib/watchlist-popout';
import './watchlist-popout-page.css';

type ActivePictureInPicture = {
  window: Window;
  dispose: () => void;
};

export function WatchlistPopoutPage() {
  useNewsCacheExpiry();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [opening, setOpening] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [refreshingSession, setRefreshingSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentParams = useRef(params);
  currentParams.current = params;
  const active = useRef<ActivePictureInPicture | null>(null);
  const mounted = useRef(false);
  const owner = params.get('watchWindow') === 'pip' ? watchlistPictureInPictureOwner() : null;
  const pinSupported = canPinWatchlistWindow();
  const pinUnavailableReason =
    window.isSecureContext === false
      ? '항상 위 고정은 HTTPS 또는 localhost에서 사용할 수 있습니다.'
      : window.top !== window
        ? '항상 위 고정은 독립 창에서 사용할 수 있습니다.'
        : '이 브라우저에서는 항상 위 고정을 지원하지 않습니다.';

  useEffect(() => {
    mounted.current = true;
    const previousTitle = document.title;
    document.title = '관심 종목 · 오르셈';
    return () => {
      mounted.current = false;
      active.current?.dispose();
      active.current?.window.close();
      active.current = null;
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (owner) postWatchlistPopoutMessage(owner, 'selection', params);
  }, [owner, params]);

  const pin = async () => {
    if (opening) return;
    if (active.current) {
      active.current.window.close();
      return;
    }
    setError(null);
    setOpening(true);
    try {
      const pip = await openWatchlistPictureInPicture(currentParams.current);
      if (!mounted.current) {
        pip.window.close();
        return;
      }
      let latest = watchlistPopoutParams(currentParams.current, true);
      const source = pip.iframe.contentWindow;
      const receive = (event: MessageEvent<unknown>) => {
        const message = readWatchlistPopoutMessage(event, source, window.location.origin);
        if (!message) return;
        latest = new URLSearchParams(message.search);
        if (message.action === 'session-ended') {
          // Keep private content hidden while App revalidates the host's session.
          setRefreshingSession(true);
          pip.window.close();
          void client.resetQueries({ queryKey: ['session'], exact: true });
          return;
        }
        if (message.action !== 'selection') pip.window.close();
      };
      const dispose = () => {
        window.removeEventListener('message', receive);
        pip.window.removeEventListener('pagehide', closed);
      };
      const closed = () => {
        dispose();
        if (active.current?.window !== pip.window) return;
        active.current = null;
        if (mounted.current) {
          setPinned(false);
          setParams(latest, { replace: true });
        }
      };
      window.addEventListener('message', receive);
      pip.window.addEventListener('pagehide', closed);
      active.current = { window: pip.window, dispose };
      setPinned(true);
    } catch {
      if (mounted.current)
        setError('항상 위 창을 열지 못했습니다. 일반 관심 종목 창을 계속 이용할 수 있습니다.');
    } finally {
      if (mounted.current) setOpening(false);
    }
  };

  const unpin = () => {
    if (owner) {
      // Focus while the PiP click still has user activation. The owner closes PiP after saving state.
      try {
        owner.focus();
      } catch {
        // Returning still works when the browser declines the focus request.
      }
      postWatchlistPopoutMessage(owner, 'unpin', currentParams.current);
    } else {
      active.current?.window.close();
    }
  };
  const close = () => {
    if (owner) postWatchlistPopoutMessage(owner, 'close', currentParams.current);
    else window.close();
  };
  const actions = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="watchlist-popout__icon"
        onClick={owner || pinned ? unpin : () => void pin()}
        disabled={opening || (!owner && !pinned && !pinSupported)}
        aria-pressed={Boolean(owner || pinned)}
        aria-label={owner || pinned ? '항상 위 고정 해제' : '항상 위로 고정'}
        title={
          owner || pinned
            ? '항상 위 고정 해제'
            : pinSupported
              ? '항상 위로 고정 · 일반 창을 열어 두세요'
              : pinUnavailableReason
        }
      >
        {owner || pinned ? <PinOff size={16} /> : <Pin size={16} />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="watchlist-popout__icon"
        onClick={close}
        aria-label={owner ? '항상 위 창 닫기' : '관심 종목 창 닫기'}
        title={owner ? '항상 위 창 닫기' : '관심 종목 창 닫기'}
      >
        <X size={16} />
      </Button>
    </>
  );

  return (
    <main className="watchlist-popout" aria-label="관심 종목 새창">
      {isFixtureMode ? <Badge tone="orange">개발용 모의 데이터</Badge> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {refreshingSession ? (
        <LoadingState label="보안 세션을 다시 확인하는 중입니다." />
      ) : pinned ? (
        <section className="card watchlist-popout__pinned" aria-label="항상 위 표시 상태">
          <header>
            <h1>관심 종목</h1>
            <div className="watchlist-popout__actions">{actions}</div>
          </header>
          <p>관심 종목을 항상 위 창에 표시하고 있습니다.</p>
          <p>이 창을 닫으면 항상 위 창도 닫힙니다.</p>
          <Button variant="secondary" size="sm" onClick={() => active.current?.window.focus()}>
            항상 위 창 보기
          </Button>
        </section>
      ) : (
        <WatchlistGroupsPanel floating headerActions={actions} />
      )}
      {!pinSupported && !owner ? (
        <p className="watchlist-popout__note">{pinUnavailableReason}</p>
      ) : null}
      <footer className="watchlist-popout__footer">
        <div>
          <Link to="/sources" target="_blank" rel="noopener noreferrer">
            데이터 출처·신선도
          </Link>
        </div>
        <ObservationDisclaimer compact />
      </footer>
    </main>
  );
}
