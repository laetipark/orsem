import { normalizeDateOnly, normalizeHeader, normalizeWhitespace } from '../normalizers';
import type {
  CanonicalTable,
  DisclosureDocumentContext,
  FieldProvenance,
  ParserWarning,
} from '../types';
import { fieldProvenance, hasSourceValue, locateHeader, type LocatedValue } from './shared';

function labelKey(value: string): string {
  return normalizeHeader(value)
    .replace(/^(?:[가-힣]|\d+)\./u, '')
    .replace(/^[□■]/u, '');
}

export function findField(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): LocatedValue | null {
  for (const label of labels.map(labelKey))
    for (const table of tables) {
      for (let row = 0; row < table.rows.length; row += 1) {
        const values = table.rows[row]!;
        for (let column = 0; column < values.length; column += 1) {
          if (labelKey(values[column] ?? '') !== label) continue;
          const cell = table.grid[row]?.[column];
          if (!cell || cell.sourceRowIndex !== row) continue;
          let next = column + 1;
          while (next < values.length && table.grid[row]?.[next] === cell) next += 1;
          const value = normalizeWhitespace(values[next] ?? '');
          if (!hasSourceValue(value) || value === values[column]) continue;
          return { value, provenance: fieldProvenance(table, row, next, [values[column]!]) };
        }
      }
    }
  return null;
}

export function findCodedField(
  tables: readonly CanonicalTable[],
  codes: readonly string[],
): LocatedValue | null {
  for (const code of codes)
    for (const table of tables) {
      for (let row = 0; row < table.rows.length; row += 1) {
        const column =
          table.grid[row]?.findIndex(
            (cell) => cell?.attributes.ACODE === code && cell.sourceRowIndex === row,
          ) ?? -1;
        if (column < 0) continue;
        const value = normalizeWhitespace(table.rows[row]?.[column] ?? '');
        if (hasSourceValue(value))
          return { value, provenance: fieldProvenance(table, row, column, [code]) };
      }
    }
  return null;
}

export function findColumnField(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): LocatedValue | null {
  for (const table of tables) {
    const header = locateHeader(table, { value: labels }, ['value']);
    const column = header?.columns.value;
    if (!header || column === undefined) continue;
    for (let row = header.headerEndRow + 1; row < table.rows.length; row += 1) {
      const value = table.rows[row]?.[column] ?? '';
      if (hasSourceValue(value))
        return { value, provenance: fieldProvenance(table, row, column, labels) };
    }
  }
  return null;
}

export function documentProvenance(
  context: DisclosureDocumentContext,
  tag: string,
  value: string,
): FieldProvenance {
  return {
    sourcePath: ['DOCUMENT', tag],
    sourceEntryName: context.sourceEntryName,
    tableIndex: -1,
    rowIndex: -1,
    columnIndex: -1,
    sourceRowIndex: -1,
    sourceColumnIndex: -1,
    headerPath: [tag],
    rawText: value,
  };
}

export function dateTokens(raw: string): string[] {
  const dates: string[] = [];
  for (const match of raw.matchAll(
    /(\d{4})\s*(?:년|[./-])\s*(\d{1,2})\s*(?:월|[./-])\s*(\d{1,2})\s*일?/gu,
  )) {
    const date = normalizeDateOnly(`${match[1]}-${match[2]}-${match[3]}`);
    if (date) dates.push(date);
  }
  return dates;
}

export function singleDate(
  value: LocatedValue | null,
  field: string,
  warnings: ParserWarning[],
): string | null {
  if (!value) return null;
  const dates = dateTokens(value.value);
  if (dates.length === 1) return dates[0]!;
  warnings.push({
    code: 'INVALID_DATE',
    message: '하나의 유효한 날짜를 확인할 수 없습니다.',
    field,
    tableIndex: value.provenance.tableIndex,
    rowIndex: value.provenance.rowIndex,
  });
  return null;
}

export function requiredFieldsWarning(
  fields: Readonly<Record<string, unknown>>,
  warnings: ParserWarning[],
): void {
  for (const [field, value] of Object.entries(fields))
    if (value === null || value === '')
      warnings.push({
        code: 'MISSING_DISCLOSURE_FIELD',
        message: '공시 핵심 항목이 없거나 확정할 수 없습니다.',
        field,
      });
}
