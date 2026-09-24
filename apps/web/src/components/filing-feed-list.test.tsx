import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import type { PersonalFiling } from '../types';
import { FilingFeedList } from './filing-feed-list';

const company = {
  id: 'company-1',
  nameKo: '예시전자',
  nameEn: 'Example Electronics',
  stockCode: '005930',
  ticker: null,
  market: 'KOSPI',
};

function filing(patch: Partial<PersonalFiling> = {}): PersonalFiling {
  return {
    id: 'filing-1',
    source: 'OPENDART',
    externalId: '20260924000001',
    title: '임원ㆍ주요주주특정증권등소유상황보고서',
    summaryTitle: '[매수신호] 홍길동 대표이사 +1,000주 장내매수',
    signal: 'BUY',
    eventDate: '2026-09-21',
    filingDate: '2026-09-24',
    publishedAt: null,
    firstObservedAt: '2026-09-24T00:00:00Z',
    url: '/events/filing-1',
    relatedCompanies: [company],
    ...patch,
  };
}

function panel(item: PersonalFiling, externalCompanies = false) {
  return (
    <MemoryRouter>
      <FilingFeedList items={[item]} externalCompanies={externalCompanies} />
    </MemoryRouter>
  );
}

afterEach(cleanup);

it('shows the confirmed transaction summary, preserves the original title, and links the company badge independently', () => {
  render(panel(filing()));

  const title = screen.getByRole('link', {
    name: '[매수신호] 홍길동 대표이사 +1,000주 장내매수',
  });
  expect(title).toHaveAttribute('href', '/events/filing-1');
  expect(title).toHaveAttribute('title', '임원ㆍ주요주주특정증권등소유상황보고서');
  expect(title).not.toHaveAttribute('target');
  const badge = screen.getByRole('link', { name: '예시전자' });
  expect(badge).toHaveAttribute('href', '/companies/company-1');
  expect(badge).not.toHaveAttribute('target');
  expect(title.contains(badge)).toBe(false);
  expect(screen.getByText('거래 2026. 09. 21.')).toHaveAttribute('datetime', '2026-09-21');
  expect(screen.getByText('접수 2026. 09. 24.')).toHaveAttribute('datetime', '2026-09-24');
});

it('opens company badges in a new tab for popouts while keeping the filing detail link internal', () => {
  render(panel(filing(), true));

  expect(screen.getByRole('link', { name: '예시전자' })).toHaveAttribute('target', '_blank');
  expect(screen.getByRole('link', { name: '예시전자' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  expect(screen.getByRole('link', { name: /홍길동/ })).not.toHaveAttribute('target');
});

it('uses an explicitly labelled KST publication time if the source has no filing date', () => {
  render(
    panel(
      filing({
        filingDate: null,
        eventDate: null,
        publishedAt: '2026-09-23T16:30:00Z',
      }),
    ),
  );

  expect(screen.getByText('발행 2026. 09. 24. 01:30 KST')).toHaveAttribute(
    'datetime',
    '2026-09-23T16:30:00Z',
  );
  expect(screen.queryByText(/^거래 /)).toBeNull();
  expect(screen.queryByText(/^접수 /)).toBeNull();
  expect(screen.queryByText(/^수집 /)).toBeNull();
});

it('labels the first observation as collection time when the source supplies no date', () => {
  render(
    panel(
      filing({
        eventDate: null,
        filingDate: null,
        publishedAt: null,
        firstObservedAt: '2026-09-23T16:30:00Z',
      }),
    ),
  );

  expect(screen.getByText('수집 2026. 09. 24. 01:30 KST')).toHaveAttribute(
    'datetime',
    '2026-09-23T16:30:00Z',
  );
});

it('does not infer a trade signal or confirmation for legacy data with no summary fields', () => {
  const legacy = {
    id: 'legacy',
    source: 'OPENDART',
    externalId: 'legacy',
    title: '주식 보유수량 +1,000주 변동',
    filingDate: '2026-09-24',
    publishedAt: null,
    firstObservedAt: '2026-09-24T00:00:00Z',
    url: '/events/legacy',
    relatedCompanies: [company],
  } as PersonalFiling;
  render(panel(legacy));

  expect(screen.getByRole('link', { name: '주식 보유수량 +1,000주 변동' })).toBeVisible();
  expect(screen.queryByText(/매수신호|매도신호|확정공시/)).toBeNull();
});
