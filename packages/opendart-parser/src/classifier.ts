import { Direction, TransactionNature } from '@orsem/contracts';
import { normalizeWhitespace } from './normalizers';
import type { MethodClassification, ParserWarning } from './types';

interface MethodRule {
  readonly nature: TransactionNature;
  readonly direction: Direction | null;
  readonly inferDirectionFromQuantity?: boolean;
}

function methodKey(raw: string): string {
  return normalizeWhitespace(raw)
    .normalize('NFKC')
    .replace(/[\sㆍ·ᆞ]/g, '')
    .replace(/[−–]/g, '-')
    .toLowerCase();
}

const METHOD_RULES = new Map<string, MethodRule>([
  ['장내매수', { nature: TransactionNature.MARKET_BUY, direction: Direction.INCREASE }],
  ['장내매수(+)', { nature: TransactionNature.MARKET_BUY, direction: Direction.INCREASE }],
  ['장내매도', { nature: TransactionNature.MARKET_SELL, direction: Direction.DECREASE }],
  ['장내매도(-)', { nature: TransactionNature.MARKET_SELL, direction: Direction.DECREASE }],
  ['시간외대량매매(매수)', { nature: TransactionNature.BLOCK_BUY, direction: Direction.INCREASE }],
  ['시간외대량매매(매도)', { nature: TransactionNature.BLOCK_SELL, direction: Direction.DECREASE }],
  ['시간외매수', { nature: TransactionNature.AFTER_HOURS_BUY, direction: Direction.INCREASE }],
  ['시간외매도', { nature: TransactionNature.AFTER_HOURS_SELL, direction: Direction.DECREASE }],
  ['장외매수', { nature: TransactionNature.OFF_MARKET_BUY, direction: Direction.INCREASE }],
  ['장외매도', { nature: TransactionNature.OFF_MARKET_SELL, direction: Direction.DECREASE }],
  ['시간외매매(+)', { nature: TransactionNature.AFTER_HOURS_BUY, direction: Direction.INCREASE }],
  ['시간외매매(-)', { nature: TransactionNature.AFTER_HOURS_SELL, direction: Direction.DECREASE }],
  ['신고대량매매(-)', { nature: TransactionNature.BLOCK_SELL, direction: Direction.DECREASE }],
  ['신고대량매매(+)', { nature: TransactionNature.BLOCK_BUY, direction: Direction.INCREASE }],
  ['자사주상여금', { nature: TransactionNature.STOCK_COMPENSATION, direction: Direction.INCREASE }],
  [
    '제3자배정유상증자',
    { nature: TransactionNature.NEW_SHARE_SUBSCRIPTION, direction: Direction.INCREASE },
  ],
  [
    '유상신주취득',
    { nature: TransactionNature.NEW_SHARE_SUBSCRIPTION, direction: Direction.INCREASE },
  ],
  ['cb인수', { nature: TransactionNature.SECURITIES_SUBSCRIPTION, direction: Direction.INCREASE }],
  ['대여', { nature: TransactionNature.STOCK_LENDING, direction: Direction.DECREASE }],
  ['대여회수', { nature: TransactionNature.STOCK_LENDING, direction: Direction.INCREASE }],
  [
    '신규선임',
    {
      inferDirectionFromQuantity: false,
      nature: TransactionNature.REPORTING_STATUS_CHANGE,
      direction: null,
    },
  ],
  [
    '신규보고',
    {
      inferDirectionFromQuantity: false,
      nature: TransactionNature.REPORTING_STATUS_CHANGE,
      direction: null,
    },
  ],
  [
    '신규주요주주',
    {
      inferDirectionFromQuantity: false,
      nature: TransactionNature.REPORTING_STATUS_CHANGE,
      direction: null,
    },
  ],
  [
    '임원퇴임',
    {
      inferDirectionFromQuantity: false,
      nature: TransactionNature.REPORTING_STATUS_CHANGE,
      direction: null,
    },
  ],
  [
    '행사가액조정',
    { inferDirectionFromQuantity: false, nature: TransactionNature.RIGHTS_CHANGE, direction: null },
  ],
  ['전환권등소멸', { nature: TransactionNature.RIGHTS_CHANGE, direction: Direction.DECREASE }],
  ['전환등', { nature: TransactionNature.RIGHTS_CHANGE, direction: Direction.DECREASE }],
  ['주식매수선택권', { nature: TransactionNature.RIGHTS_CHANGE, direction: Direction.INCREASE }],
  ['전환사채의권리행사', { nature: TransactionNature.CONVERSION, direction: Direction.INCREASE }],
  [
    '신주인수권증권의권리행사',
    { nature: TransactionNature.CONVERSION, direction: Direction.INCREASE },
  ],
  ['주식배당', { nature: TransactionNature.STOCK_DIVIDEND, direction: Direction.INCREASE }],
  ['자본감소', { nature: TransactionNature.CAPITAL_REDUCTION, direction: Direction.DECREASE }],
  ['증여취소', { nature: TransactionNature.GIFT_CANCELLATION, direction: Direction.INCREASE }],
  [
    '공개매수청약',
    { nature: TransactionNature.TENDER_OFFER_APPLICATION, direction: Direction.DECREASE },
  ],
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
  const key = methodKey(methodRaw);
  const suffix = /\(([+-])\)$/u.exec(key)?.[1];
  const rule =
    METHOD_RULES.get(key) ?? (suffix ? METHOD_RULES.get(key.replace(/\([+-]\)$/u, '')) : undefined);
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
  const suffixDirection =
    suffix === '+' ? Direction.INCREASE : suffix === '-' ? Direction.DECREASE : null;
  if (
    suffixDirection &&
    ((rule.direction && rule.direction !== suffixDirection) ||
      (!options.quantityIsAbsolute &&
        quantityDirection !== Direction.UNKNOWN &&
        quantityDirection !== Direction.NEUTRAL &&
        quantityDirection !== suffixDirection))
  ) {
    return {
      nature: TransactionNature.UNKNOWN,
      direction: quantityDirection,
      confidence: 0.2,
      warnings: [
        {
          code: 'METHOD_QUANTITY_CONFLICT',
          message: '변동 방법의 부호 표기와 방향 또는 수량이 일치하지 않습니다.',
          field: 'methodRaw',
        },
      ],
    };
  }
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
      rule.direction ??
      (rule.inferDirectionFromQuantity === false || options.quantityIsAbsolute
        ? Direction.UNKNOWN
        : quantityDirection),
    confidence: 1,
    warnings,
  };
}
