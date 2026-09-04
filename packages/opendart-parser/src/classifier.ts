import { Direction, TransactionNature } from '@orsem/contracts';
import { normalizeWhitespace } from './normalizers';
import type { MethodClassification, ParserWarning } from './types';

interface MethodRule {
  readonly nature: TransactionNature;
  readonly direction: Direction | null;
}

function methodKey(raw: string): string {
  return normalizeWhitespace(raw)
    .normalize('NFKC')
    .replace(/[\sㆍ·]/g, '')
    .toLowerCase();
}

const METHOD_RULES = new Map<string, MethodRule>([
  ['장내매수', { nature: TransactionNature.MARKET_BUY, direction: Direction.INCREASE }],
  ['장내매수(+)', { nature: TransactionNature.MARKET_BUY, direction: Direction.INCREASE }],
  ['장내매도', { nature: TransactionNature.MARKET_SELL, direction: Direction.DECREASE }],
  ['장내매도(-)', { nature: TransactionNature.MARKET_SELL, direction: Direction.DECREASE }],
  ['시간외대량매매(매수)', { nature: TransactionNature.BLOCK_BUY, direction: Direction.INCREASE }],
  ['시간외대량매매(매도)', { nature: TransactionNature.BLOCK_SELL, direction: Direction.DECREASE }],
  ['시간외매수', { nature: TransactionNature.BLOCK_BUY, direction: Direction.INCREASE }],
  ['시간외매도', { nature: TransactionNature.BLOCK_SELL, direction: Direction.DECREASE }],
  ['수증', { nature: TransactionNature.GIFT_IN, direction: Direction.INCREASE }],
  ['증여', { nature: TransactionNature.GIFT_OUT, direction: Direction.DECREASE }],
  [
    '주식매수선택권행사',
    { nature: TransactionNature.OPTION_EXERCISE, direction: Direction.INCREASE },
  ],
  ['스톡옵션행사', { nature: TransactionNature.OPTION_EXERCISE, direction: Direction.INCREASE }],
  ['rsu', { nature: TransactionNature.RSU_RSA, direction: Direction.INCREASE }],
  ['rsa', { nature: TransactionNature.RSU_RSA, direction: Direction.INCREASE }],
  ['양도제한조건부주식', { nature: TransactionNature.RSU_RSA, direction: Direction.INCREASE }],
  ['전환권행사', { nature: TransactionNature.CONVERSION, direction: Direction.INCREASE }],
  ['신주인수권행사', { nature: TransactionNature.CONVERSION, direction: Direction.INCREASE }],
  ['주식분할', { nature: TransactionNature.STOCK_SPLIT_MERGER, direction: null }],
  ['주식병합', { nature: TransactionNature.STOCK_SPLIT_MERGER, direction: null }],
  ['합병', { nature: TransactionNature.STOCK_SPLIT_MERGER, direction: null }],
  ['신탁이체', { nature: TransactionNature.TRUST_TRANSFER, direction: null }],
  ['신탁계약', { nature: TransactionNature.TRUST_TRANSFER, direction: null }],
  ['상속', { nature: TransactionNature.INHERITANCE, direction: Direction.INCREASE }],
]);

export function directionFromQuantity(quantity: string | null): Direction {
  if (quantity === null || !/^[+-]?\d+$/.test(quantity)) {
    return Direction.UNKNOWN;
  }
  const value = BigInt(quantity);
  if (value > 0n) return Direction.INCREASE;
  if (value < 0n) return Direction.DECREASE;
  return Direction.NEUTRAL;
}

export function classifyTransactionMethod(
  methodRaw: string,
  quantity: string | null,
  options: { readonly quantityIsAbsolute?: boolean } = {},
): MethodClassification {
  const quantityDirection = directionFromQuantity(quantity);
  const rule = METHOD_RULES.get(methodKey(methodRaw));
  if (!rule) {
    return {
      nature: TransactionNature.UNKNOWN,
      direction: options.quantityIsAbsolute ? Direction.UNKNOWN : quantityDirection,
      confidence: methodRaw.trim() ? 0.25 : 0,
      warnings: methodRaw.trim()
        ? [
            {
              code: 'UNKNOWN_METHOD',
              message: `허용 목록에 없는 변동 방법입니다: ${normalizeWhitespace(methodRaw)}`,
              field: 'methodRaw',
            },
          ]
        : [
            {
              code: 'MISSING_METHOD',
              message: '변동 방법이 비어 있습니다.',
              field: 'methodRaw',
            },
          ],
    };
  }
  const warnings: ParserWarning[] = [];
  if (
    rule.direction !== null &&
    !options.quantityIsAbsolute &&
    quantityDirection !== Direction.UNKNOWN &&
    quantityDirection !== Direction.NEUTRAL &&
    rule.direction !== quantityDirection
  ) {
    warnings.push({
      code: 'METHOD_QUANTITY_CONFLICT',
      message: '변동 방법의 방향과 수량 부호가 일치하지 않습니다.',
      field: 'quantity',
    });
    return {
      nature: TransactionNature.UNKNOWN,
      direction: quantityDirection,
      confidence: 0.2,
      warnings,
    };
  }
  return {
    nature: rule.nature,
    direction:
      rule.direction ?? (options.quantityIsAbsolute ? Direction.UNKNOWN : quantityDirection),
    confidence: 1,
    warnings,
  };
}
