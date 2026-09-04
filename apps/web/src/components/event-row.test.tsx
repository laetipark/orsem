import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventCompanyIdentity } from './event-row';

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
