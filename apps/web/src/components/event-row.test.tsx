import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { clearCompanyLogoMetadataCache } from '../lib/use-company-logo';
import { clearLogoFailures } from '../lib/logo-failures';
import { logoCompany, logoCompanyId, logoResponse, reviewedMapping } from '../test/logo-fixtures';
import type { EventSummary } from '../types';
import { CompanyAvatar } from './company-avatar';
import {
  EventCompactRow,
  EventCompanyIdentity,
  EventMobileCard,
  hasObservedOwnershipSemantics,
} from './event-row';

beforeEach(() => {
  clearCompanyLogoMetadataCache();
  clearLogoFailures();
  vi.spyOn(api, 'companyLogo').mockResolvedValue(logoResponse());
  vi.spyOn(api, 'companyLogoPermit').mockResolvedValue({ allowed: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('이벤트의 기업 식별과 로고', () => {
  it.each([
    ['삼성전자', '005930', null, 'KOSPI', '005930.KS'],
    ['엔비디아', null, 'NVDA', 'NASDAQ', 'NVDA'],
  ] as const)(
    '저장된 시장과 종목 식별자로 %s 로고를 표시한다',
    async (companyName, stockCode, ticker, market, providerTicker) => {
      const response = logoResponse();
      response.metadata.market = market === 'KOSPI' ? 'KR' : 'US';
      response.metadata.exchange = market;
      response.metadata.symbol = stockCode ?? ticker;
      response.metadata.providers.logoDev.ticker = reviewedMapping(providerTicker);
      vi.mocked(api.companyLogo).mockResolvedValue(response);
      const { container } = render(
        <EventCompanyIdentity
          event={{ companyId: logoCompanyId, companyName, stockCode, ticker, market }}
        />,
      );
      await waitFor(() =>
        expect(container.querySelector('img')).toHaveAttribute(
          'src',
          `https://img.logo.dev/ticker/${providerTicker}?token=pk_test_only&size=128&format=webp&fallback=404`,
        ),
      );
      expect(api.companyLogo).toHaveBeenCalledWith(logoCompanyId, expect.any(AbortSignal));
      expect(api.companyLogoPermit).toHaveBeenCalledWith(
        response.metadata.companyId,
        'logoDev',
        expect.any(AbortSignal),
      );
      expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'origin');
      expect(container.querySelector('.company-avatar')).toHaveAttribute(
        'data-review-status',
        'reviewed',
      );
      expect(screen.getByText(companyName)).toBeVisible();
      expect(screen.getByText((stockCode ?? ticker)!)).toBeVisible();
    },
  );

  it.each([
    { companyName: '엔비디아', stockCode: null, market: 'NASDAQ' },
    { companyName: '삼성전자', stockCode: '005930', market: 'OTHER' },
    { companyName: '다른 기업', stockCode: null, ticker: 'MSFT', market: 'NASDAQ' },
  ])('확인된 식별자가 없으면 기업명으로 로고를 추정하지 않는다: $companyName', async (event) => {
    const { container } = render(
      <EventCompanyIdentity event={{ companyId: logoCompanyId, ...event }} />,
    );
    if (event.market === 'NASDAQ' && event.ticker)
      await waitFor(() => expect(api.companyLogo).toHaveBeenCalled());
    else await act(async () => undefined);
    expect(container.querySelector('img')).toBeNull();
    expect(api.companyLogoPermit).not.toHaveBeenCalled();
    expect(screen.getByText(event.companyName)).toBeVisible();
  });

  it('이미지 로딩 실패 후에도 기업명과 티커를 유지하고 글자 아이콘으로 전환한다', async () => {
    const response = logoResponse();
    response.metadata.symbol = 'NVDA';
    response.metadata.providers.logoDev.ticker = reviewedMapping('NVDA');
    response.metadata.providers.brandfetch.ticker = reviewedMapping('NVDA');
    vi.mocked(api.companyLogo).mockResolvedValue(response);
    const { container } = render(
      <EventCompanyIdentity
        event={{
          companyId: logoCompanyId,
          companyName: '엔비디아',
          stockCode: null,
          ticker: 'NVDA',
          market: 'NASDAQ',
        }}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector('img')?.src).toContain('img.logo.dev/ticker/NVDA'),
    );
    fireEvent.error(container.querySelector('img')!);
    await waitFor(() =>
      expect(container.querySelector('img')?.src).toContain('cdn.brandfetch.io/ticker/NVDA/'),
    );
    fireEvent.error(container.querySelector('img')!);
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
    expect(screen.getByText('엔비디아')).toBeVisible();
    expect(screen.getByText('NVDA')).toBeVisible();
    expect(container.querySelector('.company-avatar')).toHaveTextContent('NV');
    expect(container.querySelector('.company-avatar')).toHaveAttribute('aria-hidden', 'true');
  });

  it('이벤트와 종목 아바타가 같은 회사 ID의 로고 메타데이터를 공유한다', async () => {
    const { container } = render(
      <>
        <EventCompanyIdentity
          event={{
            companyId: logoCompanyId,
            companyName: logoCompany.nameKo,
            stockCode: logoCompany.stockCode,
            ticker: logoCompany.ticker,
            market: logoCompany.market,
          }}
        />
        <CompanyAvatar company={logoCompany} />
      </>,
    );
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    expect(api.companyLogo).toHaveBeenCalledTimes(1);
    expect(api.companyLogo).toHaveBeenCalledWith(logoCompanyId, expect.any(AbortSignal));
    // Each physical image still reserves its own request; only metadata is shared.
    expect(api.companyLogoPermit).toHaveBeenCalledTimes(2);
    expect(screen.getByText(logoCompany.ticker)).toBeVisible();
  });
});

describe('거래계획 표시 의미', () => {
  const plan = {
    id: 'event-plan',
    companyId: 'company',
    companyName: '테스트기업',
    stockCode: '000001',
    ticker: '000001',
    market: 'KOSPI',
    priority: 'P2',
    detailType: 'D005',
    title: '임원·주요주주 거래계획보고서',
    summary: '향후 주식 거래계획',
    nature: 'UNKNOWN',
    direction: 'UNKNOWN',
    eventAt: '2026-09-10',
    rceptDate: '2026-09-05',
    publishedAt: null,
    firstObservedAt: '2026-09-05T00:00:00.000Z',
    processedAt: '2026-09-05T00:01:00.000Z',
    submissionKind: 'INITIAL',
    effectiveState: 'ACTIVE',
    evidenceGrade: 'A',
    classificationStatus: 'RULE_CONFIRMED',
    sourceName: 'OpenDART',
    rightsMode: 'OFFICIAL_PUBLIC_DATA',
    officialUrl: 'https://dart.fss.or.kr/',
  } as EventSummary;

  it('does not present D005 as an observed trade in compact or mobile views', async () => {
    render(
      <MemoryRouter>
        <EventCompactRow event={plan} />
        <EventMobileCard event={plan} />
      </MemoryRouter>,
    );
    await act(async () => undefined);

    expect(hasObservedOwnershipSemantics('D005')).toBe(false);
    expect(screen.queryByText('미분류')).not.toBeInTheDocument();
    expect(screen.queryByText('방향 미확인')).not.toBeInTheDocument();
    expect(screen.queryByText(/사건 2026/)).not.toBeInTheDocument();
    expect(screen.getByText(/계획 시작/)).toBeInTheDocument();
    expect(screen.getByText('향후 거래계획 · 실제 체결 아님')).toBeInTheDocument();
  });
});
