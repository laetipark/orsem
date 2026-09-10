import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/app-shell';
import { api } from '../lib/api';
import { ThemeProvider } from '../theme';
import type { Session, SourceFreshness } from '../types';
import { SourcesPage } from './sources-page';

const sources: SourceFreshness[] = [
  {
    id: 'naver',
    name: 'NAVER 뉴스검색',
    category: 'NEWS',
    status: 'DEGRADED',
    lastSuccessAt: '2026-09-04T00:00:00Z',
    lagSeconds: 660,
    rightsMode: 'STORE_METADATA_ONLY',
    message: null,
  },
  {
    id: 'market:gold',
    name: 'Gold API',
    category: 'MARKET',
    status: 'UNCONFIGURED',
    lastSuccessAt: null,
    lagSeconds: null,
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    message: null,
  },
];
const snapshot = { asOf: '2026-09-04T00:11:00Z', items: sources };
const clients: QueryClient[] = [];

function show(role: 'ADMIN' | 'VIEWER', path = '/sources') {
  const session: Session = {
    authenticated: true,
    canAccess: true,
    csrfToken: 'test',
    setupRequired: false,
    user: {
      id: `${role}-user`,
      role,
      provider: role === 'ADMIN' ? 'LOCAL' : 'KAKAO',
      status: 'APPROVED',
      email: null,
      displayName: '테스트',
      totpEnabled: false,
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<AppShell session={session} />}>
              <Route index element={<p>오늘 화면</p>} />
              <Route path="sources" element={<SourcesPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  vi.spyOn(api, 'sourceFreshness').mockResolvedValue(snapshot);
  vi.spyOn(api, 'naverNewsStatus').mockResolvedValue({
    configured: true,
    automaticAllowed: false,
    mode: 'ON_DEMAND',
    freeUntil: null,
    dailyLimit: 100,
    monthlyLimit: 2000,
    remainingToday: 100,
    remainingMonth: 2000,
    reason: '이번 달 무료 이용 조건과 호출 가능량 확인이 필요합니다.',
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe('shared data sources page', () => {
  it('loads saved freshness only after following the footer link and stops querying after leaving', async () => {
    show('VIEWER', '/');
    const footer = within(screen.getByRole('contentinfo'));
    expect(footer.getByRole('link', { name: '데이터 출처·신선도' })).toHaveAttribute(
      'href',
      '/sources',
    );
    expect(api.sourceFreshness).not.toHaveBeenCalled();
    expect(footer.queryByText('커넥터 신선도')).not.toBeInTheDocument();
    expect(footer.queryByRole('link', { name: 'Logos provided by Logo.dev' })).toBeNull();
    expect(footer.queryByRole('link', { name: '로고 출처·이용 안내' })).not.toBeInTheDocument();

    fireEvent.click(footer.getByRole('link', { name: '데이터 출처·신선도' }));
    expect(await screen.findByText('NAVER 뉴스검색')).toBeInTheDocument();
    expect(api.sourceFreshness).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('데이터 출처·신선도');
    fireEvent.click(screen.getByRole('link', { name: '오르셈 홈' }));
    expect(await screen.findByText('오늘 화면')).toBeInTheDocument();
    expect(
      clients[0]!
        .getQueryCache()
        .find({ queryKey: ['source-freshness'] })
        ?.isActive(),
    ).toBe(false);
  });

  it.each(['VIEWER', 'ADMIN'] as const)(
    'shows provenance, KST freshness and logo attribution to an approved %s with scoped operations access',
    async (role) => {
      const operations = vi.spyOn(api, 'operationSources');
      show(role);
      expect(await screen.findByText('NAVER 뉴스검색')).toBeInTheDocument();
      expect(await screen.findByText('검색 일시 중단')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /시장 뉴스/ })).toHaveAttribute('href', '/news');
      expect(screen.getByText('2026. 09. 04. 09:00 KST')).toBeInTheDocument();
      expect(screen.getByText('11분 전')).toBeInTheDocument();
      expect(screen.getByText('메타데이터만')).toBeInTheDocument();
      expect(screen.getByText('미설정')).toBeInTheDocument();
      expect(screen.getByText('기록 없음')).toBeInTheDocument();
      expect(screen.getByText('—')).toBeInTheDocument();
      expect(
        within(screen.getByRole('contentinfo')).queryByRole('link', {
          name: '로고 출처·이용 안내',
        }),
      ).not.toBeInTheDocument();
      if (role === 'ADMIN') {
        expect(screen.getByRole('link', { name: '운영 상세 보기' })).toHaveAttribute(
          'href',
          '/operations',
        );
      } else {
        expect(screen.queryByRole('link', { name: '운영 상세 보기' })).not.toBeInTheDocument();
        expect(screen.queryByRole('navigation', { name: '관리 메뉴' })).not.toBeInTheDocument();
      }
      expect(operations).not.toHaveBeenCalled();
    },
  );

  it('retains the last saved state when refresh fails and exposes only a safe error', async () => {
    show('VIEWER');
    await screen.findByText('NAVER 뉴스검색');
    vi.mocked(api.sourceFreshness).mockRejectedValue(new Error('internal connector configuration'));
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('마지막으로 확인한 상태를 표시합니다'),
    );
    expect(screen.getByText('NAVER 뉴스검색')).toBeInTheDocument();
    expect(screen.queryByText('internal connector configuration')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('contentinfo')).queryByRole('link', {
        name: '로고 출처·이용 안내',
      }),
    ).not.toBeInTheDocument();
  });

  it('groups connectors by purpose and preserves deterministic name order after refresh', async () => {
    const items: SourceFreshness[] = [
      { ...sources[0]!, id: 'ai', name: 'AI 분류기', category: 'OFFICIAL' },
      { ...sources[0]!, id: 'sec', name: 'SEC EDGAR', category: 'OFFICIAL' },
      { ...sources[0]!, id: 'ir', name: 'Samsung Global Newsroom', category: 'OFFICIAL' },
      sources[0]!,
      { ...sources[1]!, id: 'toss', name: 'Toss', category: 'MARKET' },
      { ...sources[0]!, id: 'news_rss:bls', name: 'BLS', category: 'OFFICIAL' },
      { ...sources[0]!, id: 'opendart', name: 'OpenDART', category: 'OFFICIAL' },
      sources[1]!,
    ];
    const inputOrder = items.map((source) => source.id);
    vi.mocked(api.sourceFreshness).mockResolvedValue({ ...snapshot, items });
    show('VIEWER');
    await screen.findByText('OpenDART');
    const freshness = within(screen.getByRole('region', { name: '커넥터 신선도' }));
    const groupNames = ['공식 공시', '시장 데이터', '뉴스', '기타'];
    expect(
      freshness.getAllByRole('region').map((group) => group.getAttribute('aria-label')),
    ).toEqual(groupNames);
    const expectedNames = [
      ['OpenDART', 'SEC EDGAR'],
      ['Gold API', 'Toss'],
      ['BLS', 'NAVER 뉴스검색', 'Samsung Global Newsroom'],
      ['AI 분류기'],
    ];
    const displayedNames = () =>
      groupNames.map((name) =>
        within(freshness.getByRole('region', { name }))
          .getAllByRole('heading', { level: 4 })
          .map((heading) => heading.textContent),
      );
    expect(displayedNames()).toEqual(expectedNames);
    expect(items.map((source) => source.id)).toEqual(inputOrder);

    vi.mocked(api.sourceFreshness).mockResolvedValue({ ...snapshot, items: [...items].reverse() });
    fireEvent.click(screen.getByRole('button', { name: '상태 새로고침' }));
    await waitFor(() =>
      expect(clients[0]!.getQueryData<typeof snapshot>(['source-freshness'])?.items[0]?.id).toBe(
        'market:gold',
      ),
    );
    expect(displayedNames()).toEqual(expectedNames);
  });

  it('omits empty connector categories', async () => {
    show('VIEWER');
    await screen.findByText('NAVER 뉴스검색');
    const freshness = within(screen.getByRole('region', { name: '커넥터 신선도' }));
    expect(
      freshness.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['시장 데이터 1개', '뉴스 1개']);
    expect(freshness.queryByRole('region', { name: '공식 공시' })).not.toBeInTheDocument();
    expect(freshness.queryByRole('region', { name: '기타' })).not.toBeInTheDocument();
  });
});

it('shows safe SEC cooldown facts and the next request time without inventing a new successful fetch', async () => {
  vi.mocked(api.sourceFreshness).mockResolvedValue({
    ...snapshot,
    items: [
      {
        ...sources[0]!,
        id: 'sec',
        name: 'SEC EDGAR',
        category: 'OFFICIAL',
        requestAttempted: false,
        httpStatus: 403,
        message: 'SEC 접근이 거부되었습니다(403). 대기 중이므로 새 요청을 보내지 않았습니다.',
        nextRetryAt: '2026-09-04T00:30:00Z',
      },
    ],
  });
  show('VIEWER');
  expect(await screen.findByText(/대기 중이므로 새 요청을 보내지 않았습니다/)).toBeVisible();
  expect(screen.getByText('다음 요청 가능 2026. 09. 04. 09:30 KST')).toBeVisible();
  expect(screen.getByText('2026. 09. 04. 09:00 KST')).toBeVisible();
});
