import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyAvatar } from './company-avatar';
import { api } from '../lib/api';
import { clearCompanyLogoMetadataCache } from '../lib/use-company-logo';
import { clearLogoFailures, LOGO_FAILURE_TTL_MS, recordLogoFailure } from '../lib/logo-failures';
import { localLogo, logoCompany, logoResponse, reviewedMapping } from '../test/logo-fixtures';
import { ThemeProvider } from '../theme';

beforeEach(() => {
  clearCompanyLogoMetadataCache();
  clearLogoFailures();
  vi.spyOn(api, 'companyLogo').mockResolvedValue(logoResponse());
  vi.spyOn(api, 'companyLogoPermit').mockResolvedValue({ allowed: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('company logo loading resilience', () => {
  it('falls back from stalled images within a bounded time without asserting an HTTP status', async () => {
    vi.useFakeTimers();
    const view = render(<CompanyAvatar company={logoCompany} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.container.querySelector('img')?.src).toContain('img.logo.dev');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(view.container.querySelector('img')?.src).toContain('cdn.brandfetch.io');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(view.container.querySelector('img')).toBeNull();
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
  });
  it('shares metadata while images are direct, sequential and bounded to two external attempts', async () => {
    const response = logoResponse();
    response.metadata.officialDomain = reviewedMapping('apple.com');
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute(
        'src',
        expect.stringContaining('img.logo.dev/ticker/AAPL'),
      ),
    );
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(1);
    fireEvent.load(view.container.querySelector('img')!);
    expect(view.container.querySelector('.company-avatar')).toHaveAttribute(
      'data-load-state',
      'loaded',
    );
    expect(view.container.querySelector('.company-avatar')).toHaveAttribute(
      'data-review-status',
      'unreviewed',
    );
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute(
        'src',
        expect.stringContaining('img.logo.dev/apple.com'),
      ),
    );
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
    expect(view.container).toHaveTextContent('AA');
    expect(view.container.querySelector('.company-avatar')).toHaveAttribute('aria-hidden', 'true');
    view.rerender(<CompanyAvatar company={{ ...logoCompany, nameKo: 'Apple updated' }} />);
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
  });
  it('falls back from Logo.dev to Brandfetch with origin Referer only', async () => {
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute(
        'src',
        expect.stringContaining('cdn.brandfetch.io/ticker/AAPL/'),
      ),
    );
    expect(view.container.querySelector('img')).toHaveAttribute('referrerpolicy', 'origin');
    expect(view.container.querySelector('img')).toHaveAttribute('loading', 'lazy');
    expect(view.container.querySelector('img')).toHaveAttribute('alt', '');
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
  });
  it('suppresses repeated failed URLs across remounts only for a short time', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('brandfetch'));
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
    view.unmount();
    const second = render(<CompanyAvatar company={logoCompany} />);
    await act(async () => undefined);
    expect(second.container.querySelector('img')).toBeNull();
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
    second.unmount();
    now += LOGO_FAILURE_TTL_MS + 1;
    const third = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(third.container.querySelector('img')).not.toBeNull());
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(3);
    expect(api.companyLogo).toHaveBeenCalledTimes(1);
  });
  it('uses local reviewed files without any keys or permits; remains visible in dark and light modes', async () => {
    const response = logoResponse();
    response.providers.logoDev.publishableKey = null;
    response.providers.brandfetch.clientId = null;
    response.metadata.localLogo = localLogo();
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    for (const theme of ['light', 'dark']) {
      window.localStorage.setItem('orsem-theme', theme);
      const view = render(
        <ThemeProvider>
          <CompanyAvatar company={logoCompany} />
        </ThemeProvider>,
      );
      await waitFor(() =>
        expect(view.container.querySelector('img')).toHaveAttribute('src', '/logos/test-only.svg'),
      );
      expect(document.documentElement).toHaveAttribute('data-theme', theme);
      expect(view.container.querySelector('img')).toHaveAttribute('width', '128');
      view.unmount();
    }
    expect(api.companyLogoPermit).not.toHaveBeenCalled();
  });
  it('keeps the local issuer fallback after two external failures and labels its role', async () => {
    const response = logoResponse();
    response.metadata.assetType = 'etf';
    response.metadata.issuerId = 'issuer-id';
    for (const provider of ['logoDev', 'brandfetch'] as const) {
      response.metadata.providers[provider].ticker = reviewedMapping('AAPL');
      response.metadata.providers[provider].logoRole = 'fund';
    }
    response.metadata.issuerLogo = { ...localLogo('/logos/issuer.svg'), logoRole: 'issuer' };
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('logo.dev'));
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() => expect(view.container.querySelector('img')?.src).toContain('brandfetch'));
    fireEvent.error(view.container.querySelector('img')!);
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute('src', '/logos/issuer.svg'),
    );
    expect(view.container.querySelector('.company-avatar')).toHaveAttribute(
      'data-logo-role',
      'issuer',
    );
    expect(view.container).toHaveTextContent('운용');
  });
  it('renders safe initials when keys/metadata/permissions are unavailable', async () => {
    vi.mocked(api.companyLogoPermit).mockResolvedValue({ allowed: false });
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(api.companyLogoPermit).toHaveBeenCalledTimes(2));
    expect(view.container.querySelector('img')).toBeNull();
    view.unmount();
    clearCompanyLogoMetadataCache();
    vi.mocked(api.companyLogo).mockRejectedValue(new Error('offline'));
    const offline = render(
      <CompanyAvatar
        company={{ ...logoCompany, nameKo: '<script>bad</script>', ticker: 'AAPL' }}
      />,
    );
    await act(async () => undefined);
    expect(offline.container.querySelector('img,script')).toBeNull();
    expect(offline.container).toHaveTextContent('AA');
  });
  it('waits for visibility and deduplicates metadata for the same security', async () => {
    let callback!: IntersectionObserverCallback;
    class Observer {
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', Observer);
    const view = render(<CompanyAvatar company={logoCompany} />);
    expect(api.companyLogo).not.toHaveBeenCalled();
    expect(api.companyLogoPermit).not.toHaveBeenCalled();
    act(() =>
      callback(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      ),
    );
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    vi.unstubAllGlobals();
    const second = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(second.container.querySelector('img')).not.toBeNull());
    expect(api.companyLogo).toHaveBeenCalledTimes(1);
  });
  it('does not consume pending permits because unrelated images fail', async () => {
    let complete!: (value: { allowed: boolean }) => void;
    vi.mocked(api.companyLogoPermit).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(api.companyLogoPermit).toHaveBeenCalledTimes(1));
    act(() => {
      recordLogoFailure('https://img.logo.dev/unrelated');
      recordLogoFailure('https://img.logo.dev/another');
    });
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(1);
    await act(async () => complete({ allowed: true }));
    expect(view.container.querySelector('img')?.src).toContain('/ticker/AAPL');
  });
  it('replaces a formerly loaded logo when refreshed metadata rejects it', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const view = render(<CompanyAvatar company={logoCompany} />);
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    fireEvent.load(view.container.querySelector('img')!);
    now += 300_001;
    const rejected = logoResponse();
    rejected.metadata.reviewStatus = 'rejected';
    vi.mocked(api.companyLogo).mockResolvedValue(rejected);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(view.container.querySelector('img')).toBeNull());
    expect(api.companyLogo).toHaveBeenCalledTimes(2);
  });
  it('rejects mismatched market/id/symbol metadata instead of displaying another security', async () => {
    const response = logoResponse();
    response.metadata.symbol = 'GOOGL';
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    const view = render(<CompanyAvatar company={logoCompany} />);
    await act(async () => undefined);
    expect(view.container.querySelector('img')).toBeNull();
    expect(api.companyLogoPermit).not.toHaveBeenCalled();
  });
  it.each([
    ['KOSPI', '005930', '.KS'],
    ['KOSDAQ', '035900', '.KQ'],
  ])(
    'uses the verified %s exchange for the same KRX security',
    async (exchange, symbol, suffix) => {
      const response = logoResponse();
      Object.assign(response.metadata, { market: 'KR', exchange, symbol });
      vi.mocked(api.companyLogo).mockResolvedValue(response);
      const view = render(
        <CompanyAvatar
          company={{ ...logoCompany, market: 'KRX', stockCode: symbol, ticker: null }}
        />,
      );
      await waitFor(() =>
        expect(view.container.querySelector('img')).toHaveAttribute(
          'src',
          expect.stringContaining(`img.logo.dev/ticker/${symbol}${suffix}`),
        ),
      );
      expect(api.companyLogoPermit).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ['KOSPI', 'KOSDAQ'],
    ['KOSDAQ', 'KOSPI'],
    ['KRX', 'NYSE'],
  ])('rejects a conflicting %s to %s exchange', async (market, exchange) => {
    const response = logoResponse();
    Object.assign(response.metadata, { market: 'KR', exchange, symbol: '005930' });
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    const view = render(
      <CompanyAvatar company={{ ...logoCompany, market, stockCode: '005930', ticker: null }} />,
    );
    await act(async () => undefined);
    expect(view.container.querySelector('img')).toBeNull();
    expect(api.companyLogoPermit).not.toHaveBeenCalled();
  });
});
