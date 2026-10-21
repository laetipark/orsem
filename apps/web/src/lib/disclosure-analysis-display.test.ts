import { describe, expect, it } from 'vitest';
import { analysisNumber, analysisSourceUrl } from './disclosure-analysis-display';

describe('analysis source display', () => {
  it('preserves exact large decimals, trailing decimal precision and zero versus missing', () => {
    expect(analysisNumber('12345678901234567890.00100')).toBe('12,345,678,901,234,567,890.00100');
    expect(analysisNumber('-1234.00')).toBe('-1,234.00');
    expect(analysisNumber('0')).toBe('0');
    expect(analysisNumber(null)).toBe('—');
  });
  it('rejects active, local and credential-bearing evidence URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,<script>',
      'file:///tmp/a',
      '/secret',
      'https://user:pass@example.com',
    ])
      expect(analysisSourceUrl(value)).toBeNull();
    expect(analysisSourceUrl('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=123')).toContain(
      'https://dart.fss.or.kr/',
    );
  });
});
