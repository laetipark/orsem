import { describe, expect, it } from 'vitest';
import { formatRecent, formatStatus } from './commands';

describe('Discord message formatting', () => {
  it('states that events are observations, not recommendations', () => {
    const text = formatRecent({
      items: [
        {
          company: '예시전자',
          type: 'D002',
          summary: '대표이사 장내매수 원문 확인',
          observedAt: '2026-09-03 10:10 KST',
        },
      ],
    });
    expect(text).toContain('단독 매매 신호가 아닙니다');
  });

  it('renders an operational timestamp', () => {
    expect(formatStatus({ summary: '정상', asOf: '2026-09-03 12:00 KST' })).toContain('기준:');
  });
});
