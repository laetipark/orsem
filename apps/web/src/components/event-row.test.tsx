import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EventSummary } from '../types';
import {
  EventCompactRow,
  EventCompanyIdentity,
  EventMobileCard,
  hasObservedOwnershipSemantics,
} from './event-row';

describe('이벤트의 기업 식별과 로고', () => {
  it.each([
    ['삼성전자', '005930', null, 'KOSPI', 'https://cdn.tickerlogos.com/samsung.com'],
    ['엔비디아', null, 'NVDA', 'NASDAQ', 'https://cdn.tickerlogos.com/nvidia.com'],
  ])(
    '저장된 시장과 종목 식별자로 %s 로고를 표시한다',
    (companyName, stockCode, ticker, market, url) => {
      const { container } = render(
        <EventCompanyIdentity event={{ companyName, stockCode, ticker, market: market! }} />,
      );
      expect(container.querySelector('img')).toHaveAttribute('src', url);
      expect(container.querySelector('img')).toHaveAttribute('referrerpolicy', 'no-referrer');
      expect(screen.getByText(companyName!)).toBeVisible();
      expect(screen.getByText((stockCode ?? ticker)!)).toBeVisible();
    },
  );

  it.each([
    { companyName: '엔비디아', stockCode: null, market: 'NASDAQ' },
    { companyName: '삼성전자', stockCode: '005930', market: 'OTHER' },
    { companyName: '다른 기업', stockCode: null, ticker: 'MSFT', market: 'NASDAQ' },
  ])('확인된 식별자가 없으면 기업명으로 로고를 추정하지 않는다: $companyName', (event) => {
    const { container } = render(<EventCompanyIdentity event={event} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(event.companyName)).toBeVisible();
  });

  it('이미지 로딩 실패 후에도 기업명과 티커를 유지하고 글자 아이콘으로 전환한다', () => {
    const { container } = render(
      <EventCompanyIdentity
        event={{ companyName: '엔비디아', stockCode: null, ticker: 'NVDA', market: 'NASDAQ' }}
      />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('엔비디아')).toBeVisible();
    expect(screen.getByText('NVDA')).toBeVisible();
    expect(container.querySelector('.company-avatar')).toHaveTextContent('NV');
    expect(container.querySelector('.company-avatar')).toHaveAttribute('aria-hidden', 'true');
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

  it('does not present D005 as an observed trade in compact or mobile views', () => {
    render(
      <MemoryRouter>
        <EventCompactRow event={plan} />
        <EventMobileCard event={plan} />
      </MemoryRouter>,
    );

    expect(hasObservedOwnershipSemantics('D005')).toBe(false);
    expect(screen.queryByText('미분류')).not.toBeInTheDocument();
    expect(screen.queryByText('방향 미확인')).not.toBeInTheDocument();
    expect(screen.queryByText(/사건 2026/)).not.toBeInTheDocument();
    expect(screen.getByText(/계획 시작/)).toBeInTheDocument();
    expect(screen.getByText('향후 거래계획 · 실제 체결 아님')).toBeInTheDocument();
  });
});
