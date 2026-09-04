import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DisclosureFacts, exactDisclosureNumber } from './disclosure-facts';

describe('five disclosure fact domains', () => {
  it('keeps exact tender offer decimals and distinguishes results from planned quantities', () => {
    render(
      <DisclosureFacts
        data={{
          detailType: 'D004',
          parserVersion: 'v2',
          tenderOffer: {
            documentKind: 'RESULT',
            offerorName: '매수자',
            targetCompanyName: '대상사',
            purposeRaw: null,
            conditionsRaw: null,
            subscriptionStartDate: '2026-09-01',
            subscriptionEndDate: '2026-09-05',
            settlementDate: null,
            securities: [
              {
                rowIndex: 1,
                securityTypeRaw: '보통주',
                unitPrice: '9007199254740993.25',
                currency: 'KRW',
                minQuantity: null,
                maxQuantity: null,
                heldQuantity: null,
                expectedHoldingsMin: null,
                expectedHoldingsMax: null,
                offeredQuantity: '101',
                acquiredQuantity: '100',
                actualAmount: '900719925474099325',
              },
            ],
          },
          proxySolicitation: null,
          largeHolding: null,
        }}
      />,
    );
    expect(screen.getByText('9,007,199,254,740,993.25 KRW')).toBeInTheDocument();
    expect(screen.getByText('101주')).toBeInTheDocument();
    expect(screen.getByText('100주')).toBeInTheDocument();
    expect(exactDisclosureNumber('9007199254740993')).toBe('9,007,199,254,740,993');
  });

  it('labels contract-only D001 without inventing a trade', () => {
    render(
      <DisclosureFacts
        data={{
          detailType: 'D001',
          parserVersion: 'v2',
          largeHolding: {
            reporterName: '보고자',
            reportReasonRaw: '계약 변경',
            holdingPurposeRaw: null,
            reportReasonKind: 'CONTRACT_CHANGE',
            sharesBefore: null,
            sharesAfter: null,
            ownershipRateBefore: null,
            ownershipRateAfter: null,
            changes: [],
          },
          proxySolicitation: null,
          tenderOffer: null,
        }}
      />,
    );
    expect(screen.getByText(/거래가 없는 보고를 미분류 거래로 보지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByText('미분류')).not.toBeInTheDocument();
  });

  it('presents D005 quantities as a plan rather than an executed transaction', () => {
    render(
      <DisclosureFacts
        data={{
          detailType: 'D005',
          parserVersion: 'v2',
          tradePlan: {
            plannedStartDate: '2026-09-10',
            plannedEndDate: '2026-09-20',
            plannedQuantity: '1000',
            plannedAmount: '5000000',
            methodRaw: '장내매수 예정',
            planStatus: 'PLANNED',
          },
          largeHolding: null,
          proxySolicitation: null,
          tenderOffer: null,
        }}
      />,
    );
    expect(screen.getByText('1,000주')).toBeInTheDocument();
    expect(screen.getByText(/실제 체결로 계산하지 않으며/)).toBeInTheDocument();
    expect(screen.getByText('계획됨')).toBeInTheDocument();
  });
});
