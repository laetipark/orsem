import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WatchlistNewsWorkspace } from './watchlist-news-workspace';

vi.mock('./watchlist-groups-panel', () => ({
  WatchlistGroupsPanel: () => (
    <div data-testid="visibility-wrapper">
      <section className="card watch-groups" aria-label="관심 종목" />
    </div>
  ),
}));
vi.mock('./market-news', () => ({
  DashboardNews: () => <section className="card market-news" aria-label="시장 뉴스" />,
}));
vi.mock('./personal-news', () => ({
  PersonalNews: () => (
    <section className="card personal-news" aria-label="내 관심 종목 소식">
      <header className="card__header">내 관심 종목 소식</header>
      <div className="personal-news__tabs" role="tablist" />
      <div className="personal-news__body" role="tabpanel" />
    </section>
  ),
}));

let watchHeight = 320;
let resize: ResizeObserverCallback;
const observe = vi.fn();
const disconnect = vi.fn();

beforeEach(() => {
  watchHeight = 320;
  observe.mockClear();
  disconnect.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return {
      height: this.classList.contains('watch-groups') ? watchHeight : 900,
    } as DOMRect;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('puts market news before the watch and personal cards and measures the card inside its visibility wrapper', () => {
  render(<WatchlistNewsWorkspace compact />);
  const workspace = screen.getByRole('region', { name: '관심 그룹과 소식' });
  expect([...workspace.children]).toEqual([
    screen.getByRole('region', { name: '시장 뉴스' }),
    screen.getByTestId('visibility-wrapper'),
    screen.getByRole('region', { name: '내 관심 종목 소식' }),
  ]);
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('320px');
  expect(observe).toHaveBeenCalledWith(screen.getByRole('region', { name: '관심 종목' }), {
    box: 'border-box',
  });
});

it('updates the shared height when content or responsive layout changes and discards hidden measurements', () => {
  render(<WatchlistNewsWorkspace compact />);
  const workspace = screen.getByRole('region', { name: '관심 그룹과 소식' });
  watchHeight = 528.5;
  act(() => resize([], {} as ResizeObserver));
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('528.5px');
  watchHeight = 0;
  act(() => resize([], {} as ResizeObserver));
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('');
  watchHeight = 244;
  act(() => resize([], {} as ResizeObserver));
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('244px');
});

it('stacks watchlist management and personal news without market news and keeps measuring its card', () => {
  const view = render(<WatchlistNewsWorkspace compact />);
  view.rerender(<WatchlistNewsWorkspace />);
  const workspace = screen.getByRole('region', { name: '관심 그룹과 소식' });
  expect(workspace).not.toHaveClass('watchlist-news-workspace--dashboard');
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('320px');
  expect(disconnect).toHaveBeenCalledOnce();
  expect([...workspace.children]).toEqual([
    screen.getByTestId('visibility-wrapper'),
    screen.getByRole('region', { name: '내 관심 종목 소식' }),
  ]);
  expect(screen.queryByRole('region', { name: '시장 뉴스' })).toBeNull();
  watchHeight = 460;
  act(() => resize([], {} as ResizeObserver));
  expect(workspace.style.getPropertyValue('--watch-card-height')).toBe('460px');
});

it('remeasures on window resize when ResizeObserver is unavailable', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  render(<WatchlistNewsWorkspace compact />);
  watchHeight = 410;
  fireEvent.resize(window);
  expect(
    screen
      .getByRole('region', { name: '관심 그룹과 소식' })
      .style.getPropertyValue('--watch-card-height'),
  ).toBe('410px');
});
