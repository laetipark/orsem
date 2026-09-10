import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { LogoSourcesPage } from './logo-sources-page';

const clients: QueryClient[] = [];
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LogoSourcesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
});

describe('public local logo credits', () => {
  it('preserves long source details and the public attribution and header destinations', async () => {
    const filename = `/logos/${'reviewed-fund-'.repeat(12)}.svg`;
    const sourceUrl = `https://commons.wikimedia.org/wiki/File:${'Long_source_title_'.repeat(20)}.svg`;
    const attribution = `저작자 ${sourceUrl}`;
    vi.spyOn(api, 'companyLogoCredits').mockResolvedValue({
      items: [
        { path: filename, source: 'wikimedia', sourceUrl, license: 'CC BY-SA 4.0', attribution },
      ],
    });
    show();
    const credits = within(await screen.findByRole('list', { name: '로컬 로고 출처 목록' }));
    expect(credits.getByText(filename)).toBeVisible();
    expect(credits.getByText(attribution)).toBeVisible();
    expect(credits.getByRole('link', { name: '원본 출처 (Wikimedia Commons)' })).toHaveAttribute(
      'href',
      sourceUrl,
    );
    const header = within(screen.getByRole('banner', { name: '오르셈 안내' }));
    expect(header.getByRole('link', { name: '오르셈 홈' })).toHaveAttribute('href', '/');
    expect(header.getByRole('link', { name: '오르셈 로그인' })).toHaveAttribute('href', '/login');
    const provider = screen.getByRole('link', { name: 'Logos provided by Logo.dev' });
    expect(provider).toHaveAttribute('href', 'https://logo.dev');
    expect(provider).toHaveAttribute('referrerpolicy', 'origin');
    expect(provider).toHaveAttribute('rel', 'noopener');
  });

  it('shows each registered asset source, license and literal attribution without loading images', async () => {
    vi.spyOn(api, 'companyLogoCredits').mockResolvedValue({
      items: [
        {
          path: '/logos/test-fund.svg',
          source: 'wikimedia',
          sourceUrl: 'https://commons.wikimedia.org/wiki/File:Example.svg',
          license: 'CC BY-SA 4.0',
          attribution: 'Example author <img src=x onerror=alert(1)>',
        },
      ],
    });
    show();
    const credits = within(await screen.findByRole('list', { name: '로컬 로고 출처 목록' }));
    expect(credits.getByText('/logos/test-fund.svg')).toBeVisible();
    expect(credits.getByText('이용 조건: CC BY-SA 4.0')).toBeVisible();
    expect(credits.getByText('Example author <img src=x onerror=alert(1)>')).toBeVisible();
    expect(credits.queryByRole('img')).not.toBeInTheDocument();
    expect(credits.getByRole('link', { name: '원본 출처 (Wikimedia Commons)' })).toHaveAttribute(
      'href',
      'https://commons.wikimedia.org/wiki/File:Example.svg',
    );
  });

  it('keeps provider attribution available when the local credit service fails', async () => {
    vi.spyOn(api, 'companyLogoCredits').mockRejectedValue(new Error('private backend details'));
    show();
    expect(await screen.findByText(/로컬 파일 출처 목록을 불러오지 못했습니다/)).toBeVisible();
    expect(screen.queryByText('private backend details')).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Logos provided by Logo.dev' })).toHaveLength(1);
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    expect(screen.queryByText(/등록된 로컬 종목 로고가 없습니다/)).not.toBeInTheDocument();
  });

  it('distinguishes an empty inspected registry from a failed registry request', async () => {
    vi.spyOn(api, 'companyLogoCredits').mockResolvedValue({ items: [] });
    show();
    expect(
      await screen.findByText(/현재 공개 출처 목록에 등록된 로컬 종목 로고가 없습니다/),
    ).toBeVisible();
  });
});
