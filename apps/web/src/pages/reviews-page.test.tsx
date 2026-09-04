import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReviewItem } from '../types';
import { ReviewCard } from './reviews-page';

const review: ReviewItem = {
  id: 'review-plan-match',
  eventId: 'event-1',
  companyName: '테스트전자',
  detailType: 'D002',
  reason: 'D005 계획과 D002 실행 후보를 확인해야 합니다.',
  methodRaw: '장내매수',
  extractedText: '유가증권시장 장내매수',
  proposedNature: 'MARKET_BUY',
  parserConfidence: 0.82,
  createdAt: '2026-09-03T00:00:00.000Z',
  status: 'OPEN',
  planExecutionCandidates: [
    {
      matchId: 'match-a',
      transactionId: 'transaction-1',
      planItemId: 'plan-a',
      eventDate: '2026-09-01',
      actualQuantity: '1000',
      plannedQuantity: '1000',
      actualMethodRaw: '장내매수',
      plannedMethodRaw: '장내매수',
      confidence: 0.91,
      matchedFields: ['quantity'],
    },
    {
      matchId: 'match-b',
      transactionId: 'transaction-1',
      planItemId: 'plan-b',
      eventDate: '2026-09-01',
      actualQuantity: '1000',
      plannedQuantity: '1200',
      actualMethodRaw: '장내매수',
      plannedMethodRaw: '장내매수',
      confidence: 0.7,
      matchedFields: ['reporter'],
    },
  ],
};

describe('plan execution review', () => {
  it('sends the explicitly selected D005↔D002 match id', () => {
    const onResolve = vi.fn();
    render(
      <MemoryRouter>
        <ReviewCard review={review} onResolve={onResolve} pending={false} />
      </MemoryRouter>,
    );

    expect(
      screen.getByText('주식 거래계획과 임원·주요주주 보유 공시 연결 후보'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/D005|D002/)).not.toBeInTheDocument();
    expect(review.reason).toBe('D005 계획과 D002 실행 후보를 확인해야 합니다.');
    fireEvent.click(screen.getByDisplayValue('match-b'));
    fireEvent.click(screen.getByRole('button', { name: '검토 확정' }));

    expect(onResolve).toHaveBeenCalledWith('CONFIRMED', null, 'match-b');
  });
});
