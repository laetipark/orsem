import { describe, expect, it } from 'vitest';
import { displayDomainText } from './domain-labels';

describe('display-only domain terminology', () => {
  it('replaces standalone codes in application explanations without changing the source string', () => {
    const original = 'P1 · D001 / D002 / D005 연결 확인';
    expect(displayDomainText(original)).toBe(
      '중점 관찰 · 대량보유 공시 / 임원·주요주주 보유 / 주식 거래계획 연결 확인',
    );
    expect(original).toBe('P1 · D001 / D002 / D005 연결 확인');
  });

  it('preserves adjacent identifiers while labeling all supported disclosure domains', () => {
    const value = 'XP1 P10 P2_label D00100 한P3 D002공시 D003 D004 D099';
    expect(displayDomainText(value)).toBe(value.replace('D003 D004', '의결권 위임 권유 공개매수'));
    expect(displayDomainText('(P4) [D005]')).toBe('(일반 뉴스) [주식 거래계획]');
  });
});
