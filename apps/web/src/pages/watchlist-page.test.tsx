import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WatchlistItem, WatchlistQuote } from '../types';
import { WatchlistContent } from './watchlist-page';

afterEach(() => vi.restoreAllMocks());

describe('empty watchlist onboarding', () => {
  it('explains what adding a company does without recommending a trade', () => {
    render(<WatchlistContent items={[]} onRemove={vi.fn()} onUpdate={vi.fn()} busyId={null} />);
    expect(screen.getByText('아직 관심기업이 없습니다')).toBeInTheDocument();
    expect(screen.getByText(/자동 주문을 만들지 않습니다/)).toBeInTheDocument();
  });

  it('updates priority and external alert policy explicitly', () => {
    const item: WatchlistItem = {
      id: 'company-1',
      nameKo: '테스트전자',
      nameEn: 'Test Electronics',
      stockCode: '123456',
      ticker: null,
      market: 'KOSPI',
      sector: '반도체',
      priority: 'P2',
      isListed: true,
      isWatchlisted: true,
      lastEventAt: null,
      addedAt: '2026-09-03T00:00:00.000Z',
      note: null,
      realtimeAlerts: true,
      digestAlerts: false,
    };
    const onUpdate = vi.fn();
    render(
      <MemoryRouter>
        <WatchlistContent items={[item]} onRemove={vi.fn()} onUpdate={onUpdate} busyId={null} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('option', { name: '중점 관찰' })).toHaveValue('P1');
    expect(screen.getByRole('option', { name: '관심 종목' })).toHaveValue('P2');
    expect(screen.queryByText(/P1 ·|P2 ·/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('테스트전자 알림 우선순위'), {
      target: { value: 'P1' },
    });
    fireEvent.click(screen.getByLabelText('실시간 외부 알림'));

    expect(onUpdate).toHaveBeenNthCalledWith(1, 'company-1', { priority: 'P1' });
    expect(onUpdate).toHaveBeenNthCalledWith(2, 'company-1', { realtimeAlerts: false });
  });
});

it('shows saved prices and stale timing while keeping administration collapsed and absent for viewers', () => {
  const item: WatchlistItem = {
    id: 'company-2',
    nameKo: '아주 긴 이름의 테스트 관심기업',
    nameEn: 'A Long Company Name',
    stockCode: '123456',
    ticker: null,
    market: 'KOSPI',
    sector: '반도체',
    priority: 'P2',
    isListed: true,
    isWatchlisted: true,
    lastEventAt: null,
    addedAt: '2026-09-03T00:00:00.000Z',
    note: null,
    realtimeAlerts: true,
    digestAlerts: false,
  };
  const props = { items: [item], onRemove: vi.fn(), onUpdate: vi.fn(), busyId: null };
  const { container, rerender } = render(
    <MemoryRouter>
      <WatchlistContent
        {...props}
        quotes={[
          {
            companyId: item.id,
            status: 'STALE',
            quote: {
              symbol: '123456',
              source: 'TOSS_KR',
              currency: 'KRW',
              price: '123456',
              providerAt: '2026-09-03T00:00:00Z',
              observedAt: '2026-09-03T00:00:01Z',
              rightsMode: 'PRIVATE_DISPLAY_ONLY',
              lossy: true,
            },
            previousClose: null,
            change: null,
            changePercent: null,
            referenceDate: null,
          },
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('₩123,456')).toBeInTheDocument();
  expect(screen.getByText(/지연된 시세/)).toHaveTextContent('09:00 KST');
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  expect(screen.getByRole('button', { name: /관심기업에서 제거/ })).not.toBeVisible();
  rerender(
    <MemoryRouter>
      <WatchlistContent {...props} readOnly />
    </MemoryRouter>,
  );
  expect(screen.queryByText('관리 설정')).not.toBeInTheDocument();
});

it.each(['missing', 'previous-day', 'today-stale'] as const)(
  'shows the dated domestic close and suppresses unrelated quote returns (%s)',
  (scenario) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-05T03:00:00Z'));
    const item: WatchlistItem = {
      id: 'close-company',
      nameKo: '테스트전자',
      nameEn: null,
      stockCode: '123456',
      ticker: null,
      market: 'KOSPI',
      sector: '',
      priority: 'P2',
      isListed: true,
      isWatchlisted: true,
      lastEventAt: null,
      addedAt: '2026-09-03T00:00:00Z',
      note: null,
      realtimeAlerts: false,
      digestAlerts: false,
    };
    const price: WatchlistQuote = {
      companyId: item.id,
      status: scenario === 'missing' ? 'WAITING' : 'STALE',
      quote:
        scenario === 'missing'
          ? null
          : {
              symbol: '123456',
              source: 'TOSS_KR_INTEGRATED',
              currency: 'KRW',
              price: '72100',
              providerAt:
                scenario === 'today-stale' ? '2026-09-05T00:00:00Z' : '2026-09-04T00:00:00Z',
              observedAt: '2026-09-05T00:00:00Z',
              rightsMode: 'PRIVATE_DISPLAY_ONLY',
              lossy: true,
            },
      fallbackClose: {
        price: '71000',
        currency: 'KRW',
        source: 'TOSS_KR',
        sessionDate: '2026-09-04',
      },
      previousClose: 70000,
      change: 2100,
      changePercent: 3,
      referenceDate: '2026-09-03',
    };
    render(
      <MemoryRouter>
        <WatchlistContent
          items={[item]}
          quotes={[price]}
          onRemove={vi.fn()}
          onUpdate={vi.fn()}
          busyId={null}
        />
      </MemoryRouter>,
    );
    if (scenario === 'today-stale') {
      expect(screen.getByText('₩72,100')).toBeInTheDocument();
      expect(screen.getByText('+3.00%')).toBeInTheDocument();
      expect(screen.getByText(/지연된 시세/)).toBeInTheDocument();
      expect(screen.queryByText('최근 거래일 종가')).not.toBeInTheDocument();
    } else {
      expect(screen.getByText('₩71,000')).toBeInTheDocument();
      expect(screen.getByText('최근 거래일 종가')).toBeInTheDocument();
      expect(screen.getByText('2026. 09. 04. 종가 · 토스증권 국내 일봉')).toBeInTheDocument();
      expect(screen.queryByText('+3.00%')).not.toBeInTheDocument();
      expect(screen.queryByText(/전일 종가 대비|KST|지연된 시세/)).not.toBeInTheDocument();
    }
  },
);
