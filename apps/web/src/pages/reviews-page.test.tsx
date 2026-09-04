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

describe('staged parse review', () => {
  it('asks for official evidence first and leaves final activation as a separate action', () => {
    const onResolve = vi.fn();
    render(
      <MemoryRouter>
        <ReviewCard
          review={{
            ...review,
            planExecutionCandidates: [],
            staged: true,
            crosscheckStatus: 'NOT_RUN',
            crosscheckReady: false,
            validationStatus: 'REVIEW_REQUIRED',
            candidateRowCount: 8,
            candidateEvidence: ['수량: 4500 · 원문 방법: 장내매수'],
          }}
          onResolve={onResolve}
          pending={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/앞의 5행만 표시/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '검토 확정' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '공식 요약 검증' }));
    expect(onResolve).toHaveBeenCalledWith('CONFIRMED', null, undefined);
  });

  it('does not allow rejected extraction to be confirmed but preserves an unknown review decision', () => {
    const onResolve = vi.fn();
    render(
      <MemoryRouter>
        <ReviewCard
          review={{
            ...review,
            planExecutionCandidates: [],
            staged: true,
            validationStatus: 'REJECTED',
          }}
          onResolve={onResolve}
          pending={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '추출 검증 필요' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /UNKNOWN 유지/ }));
    fireEvent.click(screen.getByRole('button', { name: '검토 확정' }));
    expect(onResolve).toHaveBeenCalledWith('UNKNOWN', null, undefined);
  });
});
