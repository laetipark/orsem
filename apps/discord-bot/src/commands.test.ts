import { describe, expect, it } from 'vitest';
import { formatMarket, formatNews, formatRecent, formatStatus, orsemCommand } from './commands';

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

  it('registers regional market and metadata news queries without replacing filing commands', () => {
    const commands = orsemCommand.toJSON().options ?? [];
    expect(commands.map((item) => item.name)).toEqual(
      expect.arrayContaining(['status', 'recent', 'company', 'market', 'news']),
    );
    expect(commands.find((item) => item.name === 'news')).toMatchObject({
      description: expect.stringContaining('원문'),
    });
  });

  it('formats exactly the ranked top 20, keeping Korean zeroes and monthly basis', () => {
    const text = formatMarket({
      region: 'kr',
      label: '국내',
      basisDate: '2026-08-31',
      selectionMonth: '2026-09',
      nextRefreshAt: '2026-09-30T15:00:00Z',
      refreshCadence: 'MONTHLY',
      status: 'VALIDATION_PENDING',
      reason: '월간 자료 검증 대기 · 마지막 정상 목록 유지',
      items: Array.from({ length: 21 }, (_, i) => ({
        rank: i + 1,
        id: String(i),
        nameKo: `기업${i + 1}`,
        market: 'KOSPI',
        stockCode: '005930',
        ticker: null,
      })).reverse(),
    });
    expect(text).toContain('1. 기업1 (005930)');
    expect(text).not.toContain('21. 기업21');
    expect(text).toContain('월간 갱신');
    expect(text).toContain('마지막 정상 목록 유지');
    expect(text).toContain('2026-10-01 00:00 KST');
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('renders news metadata, related stocks and original links with KST, never body fields', () => {
    const item = {
      title: '새 소식',
      description: '제공 요약\n한 줄',
      sourceName: '출처',
      publishedAt: '2026-09-06T17:30:00Z',
      url: 'https://example.com/original',
      translationStatus: 'FAILED' as const,
      relatedCompanies: [{ nameKo: '삼성전자', stockCode: '005930', ticker: null }],
      content: '기사 본문 비밀',
      body: '본문 사본',
    };
    const [text] = formatNews({ items: [item] });
    expect(text).toContain('제공 요약 한 줄');
    expect(text).toContain('관련 종목: 삼성전자');
    expect(text).toContain('원문 <https://example.com/original>');
    expect(text).toContain('2026-09-07 02:30 KST');
    expect(text).toContain('번역 실패');
    expect(text).not.toContain('본문');
    expect(formatNews({ items: [{ ...item, url: 'javascript:alert(1)' }] })).toEqual([
      '시장 상위 종목 뉴스\n표시할 뉴스가 없습니다.',
    ]);
  });

  it('keeps each news message within Discord limits without truncating the original URL', () => {
    const url = `https://example.com/${'a'.repeat(1450)}`;
    const messages = formatNews({
      items: Array.from({ length: 5 }, () => ({
        title: '*제목'.repeat(100),
        description: '*요약'.repeat(100),
        sourceName: '출처'.repeat(100),
        publishedAt: null,
        url,
        relatedCompanies: Array.from({ length: 3 }, () => ({
          nameKo: '기업'.repeat(100),
          stockCode: null,
          ticker: 'TEST',
        })),
      })),
    });
    expect(messages).toHaveLength(5);
    for (const text of messages) {
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text).toContain(url);
    }
  });
});
