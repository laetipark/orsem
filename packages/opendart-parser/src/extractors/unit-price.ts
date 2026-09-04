import { normalizeWhitespace, parseDecimal, type ParsedNumeric } from '../normalizers';

/** DART's price field is an unsigned price, with an optional acquisition/disposal
 * label or empty second slot. This is intentionally separate from the generic
 * decimal parser, where parentheses continue to mean a negative number. */
export function parseUnitPrice(raw: string): ParsedNumeric {
  let text = normalizeWhitespace(raw).normalize('NFKC');
  if (/^(?:-\s*)?(?:\(\s*-?\s*\))?$/u.test(text)) return parseDecimal('', 'unitPrice');
  const labeled = /^(?:취득|처분|장내취득|장내처분)\s*\(\s*([^()]+)\s*\)$/u.exec(text);
  if (labeled) text = labeled[1]!.trim();
  const wrapped = /^\(\s*([\d,]+(?:\.\d+)?\s*(?:원|KRW|달러|USD)?)\s*\)$/iu.exec(text);
  if (wrapped) text = wrapped[1]!;
  text = text.replace(/\s*\(\s*(원|KRW|달러|USD)\s*\)$/iu, '$1').replace(/\s*\(\s*-?\s*\)$/u, '');
  const parsed = parseDecimal(text, 'unitPrice');
  if (parsed.value?.startsWith('-'))
    return {
      value: null,
      unitRaw: parsed.unitRaw,
      warning: {
        code: 'INVALID_UNIT_PRICE',
        message: '단가는 음수일 수 없습니다.',
        field: 'unitPrice',
      },
    };
  return parsed;
}
