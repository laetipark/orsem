import { validateTranslationLanguage } from '../src/ai/news-translation-language';

describe('Korean translation coverage', () => {
  it.each([
    [
      'Samsung Electronics announced a new product with improved sound and battery life.',
      '삼성전자 announced a new product with improved sound and battery life.',
    ],
    [
      'The Galaxy series makes it easier to capture and create.',
      '갤럭시系列让用户能够更容易地捕捉创作和连接世界',
    ],
    ['The company announced a new product.', '회사가 新しい製品を発表しました'],
    ['The company announced a new product.', '회사가 أعلنت منتجًا جديدًا'],
    [
      'The committee approved the proposal while preserving the existing restrictions on bank lending and shareholder transactions.',
      '위원회 소식',
    ],
    ['The board approved the proposal.', 'The board approved the proposal.'],
  ])('rejects incomplete/mixed-language prose', (before, after) => {
    expect(() => validateTranslationLanguage(before, after)).toThrow();
  });

  it.each([
    ['Bank of America published FOMC minutes.', 'Bank of America가 FOMC 의사록을 공개했다.'],
    [
      'Samsung Galaxy S26 Ultra includes AI features.',
      'Samsung Galaxy S26 Ultra에는 AI 기능이 포함된다.',
    ],
    ['The S&P 500 rose by 2 percent.', 'S&P 500 지수는 2% 상승했다.'],
    [
      'See https://example.com/very/long/english/path for details.',
      '자세한 내용은 https://example.com/very/long/english/path 를 확인하세요.',
    ],
    [
      'Contact press@example.com for more information.',
      '자세한 내용은 press@example.com 으로 문의하세요.',
    ],
    ['The company disclosed its results.', '회사가 실적(實績)을 공개했다.'],
    [
      'Aurora Bancshares, Inc., Salem, Illinois and The Aurora State Bank, Salem, Illinois signed an agreement.',
      'Aurora Bancshares, Inc., Salem, Illinois와 The Aurora State Bank, Salem, Illinois가 합의서에 서명했다.',
    ],
    [
      'Maria A. Torres, former employee of Banco Popular de Puerto Rico, San Juan, Puerto Rico, received an order.',
      'Banco Popular de Puerto Rico, San Juan, Puerto Rico의 전 직원 Maria A. Torres에게 명령이 내려졌다.',
    ],
    ['PDF', 'PDF'],
    ['2026', '2026'],
    ['https://example.com/news', 'https://example.com/news'],
  ])('preserves Korean prose, names and standalone technical labels', (before, after) => {
    expect(() => validateTranslationLanguage(before, after)).not.toThrow();
  });

  it('does not exempt unchanged English sentences or altered technical labels', () => {
    expect(() => validateTranslationLanguage('Press Release', 'Press Release')).toThrow();
    expect(() => validateTranslationLanguage('PDF', 'HTML')).toThrow();
  });
});
