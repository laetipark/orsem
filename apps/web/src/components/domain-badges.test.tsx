import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EventStateBadge, EventTypeBadge, PriorityBadge, RightsBadge } from './domain-badges';

describe('domain badges', () => {
  it.each([
    ['D001', '대량보유 공시'],
    ['D002', '임원·주요주주 보유'],
    ['D005', '주식 거래계획'],
  ] as const)('uses the public label for %s while retaining domain distinctions', (type, label) => {
    const { container } = render(<EventTypeBadge type={type} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/D00[125]/);
    if (type === 'D001')
      expect(screen.getByText(label)).toHaveAttribute('title', '5% 이상 보유와 보유 목적의 변동');
  });

  it.each([
    ['P1', '중점 관찰'],
    ['P2', '관심 종목'],
    ['P3', '시장 동향'],
    ['P4', '일반 뉴스'],
  ] as const)('uses a human-readable priority label for %s', (priority, label) => {
    const { container } = render(<PriorityBadge priority={priority} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/P[1-4]/);
  });

  it('distinguishes a D005 plan from an executed ownership change', () => {
    render(<EventTypeBadge type="D005" />);
    expect(screen.getByText(/거래계획/)).toBeInTheDocument();
  });

  it('shows submission kind and effective state independently', () => {
    render(<EventStateBadge submissionKind="INITIAL" effectiveState="SUPERSEDED" />);
    expect(screen.getByText(/최초/)).toHaveTextContent('대체됨');
  });

  it('renders metadata-only rights without implying article-body rights', () => {
    render(<RightsBadge status="STORE_METADATA_ONLY" />);
    expect(screen.getByText('메타데이터만')).toBeInTheDocument();
  });
});
