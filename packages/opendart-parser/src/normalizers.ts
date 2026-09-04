import type { ParserWarning } from './types';

const UNICODE_MINUS = /[−–—]/g;
const DATE_PATTERN = /^(\d{4})[.\x2f-]?(\d{1,2})[.\x2f-]?(\d{1,2})$/;
const MAX_NUMERIC_SOURCE_CHARACTERS = 128;
const MAX_DECIMAL_INTEGER_DIGITS = 32;
const MAX_DECIMAL_PRECISION = 38;
const MAX_DECIMAL_SCALE = 6;

function numericWarning(
  code: 'NUMERIC_OUT_OF_RANGE' | 'NUMERIC_SCALE_EXCEEDED',
  original: string,
  field: string,
): ParserWarning {
  return {
    code,
    message:
      code === 'NUMERIC_SCALE_EXCEEDED'
        ? `소수점 이하 ${MAX_DECIMAL_SCALE}자리를 초과했습니다: ${original.slice(0, 128)}`
        : `DECIMAL(38,6) 범위로 안전하게 저장할 수 없습니다: ${original.slice(0, 128)}`,
    field,
  };
}

function fitsDatabaseDecimal(value: string): boolean {
  const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return false;
  const integerDigits = (match[1]!.replace(/^0+(?=\d)/, '') || '0').length;
  const fractionDigits = (match[2] ?? '').replace(/0+$/, '').length;
  return (
    integerDigits <= MAX_DECIMAL_INTEGER_DIGITS &&
    fractionDigits <= MAX_DECIMAL_SCALE &&
    integerDigits + fractionDigits <= MAX_DECIMAL_PRECISION
  );
}

export function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

export function normalizeHeader(value: string): string {
  return normalizeWhitespace(value)
    .normalize('NFKC')
    .replace(/[\s·ㆍ:：()（）\u005b\u005d{}]/g, '')
    .toLowerCase();
}

export function normalizeDateOnly(raw: string): string | null {
  const normalized = normalizeWhitespace(raw)
    .normalize('NFKC')
    .replace(/년|월/g, '-')
    .replace(/일/g, '')
    .replace(/\s/g, '')
    .replace(/\.+$/g, '');
  const match = DATE_PATTERN.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface ParsedNumeric {
  readonly value: string | null;
  readonly unitRaw: string | null;
  readonly warning: ParserWarning | null;
}

export function parseInteger(raw: string, field: string): ParsedNumeric {
  const original = normalizeWhitespace(raw);
  if (!original || /^[-―—–]+$/.test(original)) {
    return { value: null, unitRaw: null, warning: null };
  }
  if (original.length > MAX_NUMERIC_SOURCE_CHARACTERS) {
    return {
      value: null,
      unitRaw: null,
      warning: numericWarning('NUMERIC_OUT_OF_RANGE', original, field),
    };
  }
  const invalidMoneyUnit = original.match(/(억원|백만원|천원|원)$/)?.[1];
  if (invalidMoneyUnit) {
    return {
      value: null,
      unitRaw: invalidMoneyUnit,
      warning: {
        code: 'INVALID_SHARE_UNIT',
        message: `주식 수량 필드에 금액 단위를 적용할 수 없습니다: ${original}`,
        field,
      },
    };
  }
  const unitMatch = original.match(/(백만주|천주|주|개|좌)$/);
  const unitRaw = unitMatch?.[1] ?? null;
  let normalized = original
    .normalize('NFKC')
    .replace(UNICODE_MINUS, '-')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/(백만주|천주|주|개|좌)$/u, '');
  let negative = false;
  if (/^\(.*\)$/.test(normalized)) {
    negative = true;
    normalized = normalized.slice(1, -1);
  }
  if (!/^[+-]?\d+$/.test(normalized)) {
    return {
      value: null,
      unitRaw,
      warning: {
        code: 'INVALID_INTEGER',
        message: `숫자로 안전하게 해석할 수 없습니다: ${original}`,
        field,
      },
    };
  }
  let value = BigInt(normalized);
  if (negative && value > 0n) value = -value;
  const multiplier = unitRaw === '백만주' ? 1_000_000n : unitRaw === '천주' ? 1_000n : 1n;
  value *= multiplier;
  const canonical = value.toString();
  if (!fitsDatabaseDecimal(canonical)) {
    return {
      value: null,
      unitRaw,
      warning: numericWarning('NUMERIC_OUT_OF_RANGE', original, field),
    };
  }
  return { value: canonical, unitRaw, warning: null };
}

export function parseDecimal(raw: string, field: string): ParsedNumeric {
  const original = normalizeWhitespace(raw);
  if (!original || /^[-―—–]+$/.test(original)) {
    return { value: null, unitRaw: null, warning: null };
  }
  if (original.length > MAX_NUMERIC_SOURCE_CHARACTERS) {
    return {
      value: null,
      unitRaw: null,
      warning: numericWarning('NUMERIC_OUT_OF_RANGE', original, field),
    };
  }
  const unitMatch = original.match(/(억원|백만원|천원|원|%|달러|USD|KRW)$/i);
  const unitRaw = unitMatch?.[1] ?? null;
  let normalized = original
    .normalize('NFKC')
    .replace(UNICODE_MINUS, '-')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/(억원|백만원|천원|원|%|달러|USD|KRW)$/i, '');
  let negative = false;
  if (/^\(.*\)$/.test(normalized)) {
    negative = true;
    normalized = normalized.slice(1, -1);
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    return {
      value: null,
      unitRaw,
      warning: {
        code: 'INVALID_DECIMAL',
        message: `소수로 안전하게 해석할 수 없습니다: ${original}`,
        field,
      },
    };
  }
  const sign = normalized.startsWith('-') || negative ? '-' : '';
  const unsigned = normalized.replace(/^[+-]/, '');
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const canonicalInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const canonicalFraction = fraction.replace(/0+$/, '');
  if (canonicalFraction.length > MAX_DECIMAL_SCALE) {
    return {
      value: null,
      unitRaw,
      warning: numericWarning('NUMERIC_SCALE_EXCEEDED', original, field),
    };
  }
  const isZero = canonicalInteger === '0' && !canonicalFraction;
  const canonical = `${isZero ? '' : sign}${canonicalInteger}${canonicalFraction ? `.${canonicalFraction}` : ''}`;
  const multiplier =
    unitRaw === '억원'
      ? '100000000'
      : unitRaw === '백만원'
        ? '1000000'
        : unitRaw === '천원'
          ? '1000'
          : '1';
  const value = multiplier === '1' ? canonical : multiplyIntegerAndDecimal(multiplier, canonical);
  if (value === null || !fitsDatabaseDecimal(value)) {
    return {
      value: null,
      unitRaw,
      warning: numericWarning('NUMERIC_OUT_OF_RANGE', original, field),
    };
  }
  return { value, unitRaw, warning: null };
}

export function multiplyIntegerAndDecimal(
  integerValue: string,
  decimalValue: string,
): string | null {
  if (
    integerValue.length > MAX_NUMERIC_SOURCE_CHARACTERS ||
    decimalValue.length > MAX_NUMERIC_SOURCE_CHARACTERS
  ) {
    return null;
  }
  if (!/^[+-]?\d+$/.test(integerValue)) return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(decimalValue)) return null;
  const negative = (integerValue.startsWith('-') ? 1 : 0) ^ (decimalValue.startsWith('-') ? 1 : 0);
  const integer = BigInt(integerValue.replace(/^[+-]/, ''));
  const [whole = '0', fraction = ''] = decimalValue.replace(/^[+-]/, '').split('.');
  const scale = fraction.length;
  const scaledDecimal = BigInt(`${whole}${fraction}`);
  const product = integer * scaledDecimal;
  const digits = product.toString().padStart(scale + 1, '0');
  const result =
    scale === 0
      ? digits
      : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '');
  const signed = result === '0' ? '0' : `${negative ? '-' : ''}${result}`;
  return fitsDatabaseDecimal(signed) ? signed : null;
}

export function scaleNumeric(value: string | null, multiplier: number): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(multiplier) || multiplier < 1) return null;
  return multiplyIntegerAndDecimal(String(multiplier), value);
}
