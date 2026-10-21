import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { marketFixtures } from '../lib/market-fixtures';
import type { MarketQuote } from '../types';
import { MarketCard } from './market-card';

afterEach(cleanup);

it.each(['ETF', 'FUTURE_CATEGORY', '__proto__', 'constructor'])(
  'keeps a %s market quote visible when its category needs a default icon',
  (category) => {
    const item: MarketQuote = {
      ...marketFixtures.find((quote) => quote.id === 'sp500')!,
      id: 'new-market-instrument',
      name: '시장 상품',
      category: category as MarketQuote['category'],
      displayKind: 'NATIVE',
      widgetSymbol: null,
      value: '123.45',
      currency: 'USD',
    };
    const { container } = render(
      <MemoryRouter>
        <MarketCard item={item} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: '시장 상품' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '시장 상품 상세 차트' })).toHaveAttribute(
      'href',
      '/markets/new-market-instrument',
    );
    expect(screen.getByText('$123.45')).toBeInTheDocument();
    expect(container.querySelector('.market-card__icon svg')).not.toBeNull();
  },
);
