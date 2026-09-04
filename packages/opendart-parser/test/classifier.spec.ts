import { Direction, TransactionNature } from '@orsem/contracts';
import { classifyTransactionMethod } from '../src';

describe('strict OpenDART method allowlist', () => {
  it.each([
    ['장내매수', '10', TransactionNature.MARKET_BUY, Direction.INCREASE],
    ['장내매도', '-10', TransactionNature.MARKET_SELL, Direction.DECREASE],
    ['시간외 대량매매(매수)', '10', TransactionNature.BLOCK_BUY, Direction.INCREASE],
    ['시간외 대량매매(매도)', '-10', TransactionNature.BLOCK_SELL, Direction.DECREASE],
    ['수증', '10', TransactionNature.GIFT_IN, Direction.INCREASE],
    ['증여', '-10', TransactionNature.GIFT_OUT, Direction.DECREASE],
    ['주식매수선택권 행사', '10', TransactionNature.OPTION_EXERCISE, Direction.INCREASE],
    ['RSU', '10', TransactionNature.RSU_RSA, Direction.INCREASE],
    ['전환권 행사', '10', TransactionNature.CONVERSION, Direction.INCREASE],
    ['주식분할', '10', TransactionNature.STOCK_SPLIT_MERGER, Direction.INCREASE],
    ['신탁이체', '-10', TransactionNature.TRUST_TRANSFER, Direction.DECREASE],
    ['상속', '10', TransactionNature.INHERITANCE, Direction.INCREASE],
  ])('%s maps only through an explicit rule', (method, quantity, nature, direction) => {
    expect(classifyTransactionMethod(method, quantity)).toMatchObject({
      nature,
      direction,
    });
  });

  it('downgrades a method/sign contradiction to UNKNOWN', () => {
    expect(classifyTransactionMethod('장내매수', '-10')).toMatchObject({
      nature: TransactionNature.UNKNOWN,
      direction: Direction.DECREASE,
      warnings: [expect.objectContaining({ code: 'METHOD_QUANTITY_CONFLICT' })],
    });
  });

  it('allows an unsigned planned quantity when D005 supplies direction by method', () => {
    expect(
      classifyTransactionMethod('장내매도', '10', {
        quantityIsAbsolute: true,
      }),
    ).toMatchObject({
      nature: TransactionNature.MARKET_SELL,
      direction: Direction.DECREASE,
    });
  });

  it('does not infer direction from an unsigned D005 quantity for an unknown method', () => {
    expect(
      classifyTransactionMethod('기타 예정', '10', {
        quantityIsAbsolute: true,
      }),
    ).toMatchObject({
      nature: TransactionNature.UNKNOWN,
      direction: Direction.UNKNOWN,
    });
  });

  it('does not fuzzy-match narrative text containing an allowlisted phrase', () => {
    expect(classifyTransactionMethod('장내매수로 추정', '10')).toMatchObject({
      nature: TransactionNature.UNKNOWN,
      direction: Direction.INCREASE,
    });
  });
});
