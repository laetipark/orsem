import type { CanonicalTable } from '../types';
import { normalizeHeader, normalizeWhitespace } from '../normalizers';

export type HeaderAliases<TField extends string> = Readonly<Record<TField, readonly string[]>>;

export interface HeaderMatch<TField extends string> {
  readonly headerEndRow: number;
  readonly columns: Readonly<Partial<Record<TField, number>>>;
  readonly matchedFields: number;
}

export function locateHeader<TField extends string>(
  table: CanonicalTable,
  aliases: HeaderAliases<TField>,
  required: readonly TField[],
): HeaderMatch<TField> | null {
  const maxHeaderEnd = Math.min(4, table.rows.length - 1);
  let best: HeaderMatch<TField> | null = null;
  for (let end = 0; end <= maxHeaderEnd; end += 1) {
    const width = Math.max(0, ...table.rows.slice(0, end + 1).map((row) => row.length));
    const columns: Partial<Record<TField, number>> = {};
    for (let column = 0; column < width; column += 1) {
      const combined = normalizeHeader(
        table.rows
          .slice(0, end + 1)
          .map((row) => row[column] ?? '')
          .filter(Boolean)
          .join(' '),
      );
      for (const [field, fieldAliases] of Object.entries(aliases) as [
        TField,
        readonly string[],
      ][]) {
        if (columns[field] !== undefined) continue;
        if (fieldAliases.some((alias) => combined.includes(normalizeHeader(alias)))) {
          columns[field] = column;
        }
      }
    }
    const matchedFields = Object.keys(columns).length;
    if (!required.every((field) => columns[field] !== undefined)) continue;
    if (!best || matchedFields > best.matchedFields) {
      best = { headerEndRow: end, columns, matchedFields };
    }
  }
  return best;
}

export function cellAt<TField extends string>(
  row: readonly string[],
  columns: Readonly<Partial<Record<TField, number>>>,
  field: TField,
): string {
  const column = columns[field];
  return column === undefined ? '' : normalizeWhitespace(row[column] ?? '');
}

export function isDataRow(row: readonly string[]): boolean {
  const text = normalizeHeader(row.join(' '));
  return Boolean(text) && !/^(합계|계|총계|소계)/.test(text);
}

export function headerScaleForColumn(
  table: CanonicalTable,
  headerEndRow: number,
  column: number | undefined,
  kind: 'SHARES' | 'MONEY',
): { readonly multiplier: number; readonly unitRaw: string | null } {
  if (column === undefined) return { multiplier: 1, unitRaw: null };
  const raw = table.rows
    .slice(0, headerEndRow + 1)
    .map((row) => row[column] ?? '')
    .join(' ')
    .normalize('NFKC');
  const units =
    kind === 'SHARES'
      ? ([
          ['백만주', 1_000_000],
          ['천주', 1_000],
        ] as const)
      : ([
          ['억원', 100_000_000],
          ['백만원', 1_000_000],
          ['천원', 1_000],
        ] as const);
  const match = units.find(([unit]) => raw.includes(unit));
  return match ? { unitRaw: match[0], multiplier: match[1] } : { multiplier: 1, unitRaw: null };
}

export function findLabelValue(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): string | null {
  const normalizedLabels = labels.map(normalizeHeader);
  for (const table of tables) {
    for (const row of table.rows) {
      for (let index = 0; index < row.length - 1; index += 1) {
        const label = normalizeHeader(row[index] ?? '');
        if (!normalizedLabels.some((candidate) => label === candidate)) continue;
        for (let valueIndex = index + 1; valueIndex < row.length; valueIndex += 1) {
          const value = normalizeWhitespace(row[valueIndex] ?? '');
          if (value && normalizeHeader(value) !== label) return value;
        }
      }
    }
  }
  return null;
}
