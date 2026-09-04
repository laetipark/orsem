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

describe('expanded source method aliases', () => {
  it.each([
    ['장외매수(+)', '10', TransactionNature.OFF_MARKET_BUY],
    ['장외매도(-)', '-10', TransactionNature.OFF_MARKET_SELL],
    ['시간외매매(+)', '10', TransactionNature.AFTER_HOURS_BUY],
    ['자사주상여금(+)', '10', TransactionNature.STOCK_COMPENSATION],
    ['제3자배정유상증자(+)', '10', TransactionNature.NEW_SHARE_SUBSCRIPTION],
    ['대여(-)', '-10', TransactionNature.STOCK_LENDING],
    ['신규선임(+)', '10', TransactionNature.REPORTING_STATUS_CHANGE],
    ['주식배당(+)', '10', TransactionNature.STOCK_DIVIDEND],
    ['자본감소', '-10', TransactionNature.CAPITAL_REDUCTION],
    ['공개매수청약(-)', '-10', TransactionNature.TENDER_OFFER_APPLICATION],
  ])('%s uses an exact source alias', (method, quantity, nature) => {
    expect(classifyTransactionMethod(method, quantity)).toMatchObject({ nature });
  });

  it('rejects a suffix that contradicts the signed quantity', () => {
    expect(classifyTransactionMethod('장외매수(+)', '-10')).toMatchObject({
      nature: TransactionNature.UNKNOWN,
      warnings: [expect.objectContaining({ code: 'METHOD_QUANTITY_CONFLICT' })],
    });
  });
});

describe('semantic direction handling for non-trade ownership methods', () => {
  it.each([
    ['전환등(-)', '10', TransactionNature.RIGHTS_CHANGE, Direction.DECREASE],
    ['주식매수선택권(+)', '10', TransactionNature.RIGHTS_CHANGE, Direction.INCREASE],
    ['증여취소(+)', '10', TransactionNature.GIFT_CANCELLATION, Direction.INCREASE],
    ['공개매수청약(-)', '10', TransactionNature.TENDER_OFFER_APPLICATION, Direction.DECREASE],
  ])(
    '%s retains the explicit source direction for an absolute quantity',
    (method, quantity, nature, direction) => {
      expect(
        classifyTransactionMethod(method, quantity, { quantityIsAbsolute: true }),
      ).toMatchObject({ nature, direction });
    },
  );

  it.each([
    ['신규선임(+)', '10'],
    ['신규보고(+)', '10'],
    ['임원퇴임(-)', '-10'],
  ])('%s remains UNKNOWN direction because it changes reporting status', (method, quantity) =>
    expect(classifyTransactionMethod(method, quantity)).toMatchObject({
      nature: TransactionNature.REPORTING_STATUS_CHANGE,
      direction: Direction.UNKNOWN,
    }),
  );
});
