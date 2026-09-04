import type { CanonicalTable, FieldProvenance, FieldProvenanceMap, ParserWarning } from '../types';
import { normalizeHeader, normalizeWhitespace } from '../normalizers';

export type HeaderAliases<TField extends string> = Readonly<Record<TField, readonly string[]>>;

export interface HeaderMatch<TField extends string> {
  readonly headerStartRow: number;
  readonly headerEndRow: number;
  readonly columns: Readonly<Partial<Record<TField, number>>>;
  readonly matchedFields: number;
}

function headerKey(value: string): string {
  return normalizeHeader(value).replace(/[*※]+\d*$/g, '');
}

export function headerPathFor(
  table: CanonicalTable,
  start: number,
  end: number,
  column: number,
): string[] {
  const path: string[] = [];
  let previousSource: string | null = null;
  for (let row = start; row <= end; row += 1) {
    const cell = table.grid[row]?.[column];
    const source = cell ? `${cell.sourceRowIndex}:${cell.sourceColumnIndex}` : null;
    const text = table.rows[row]?.[column] ?? '';
    if (text && (source === null || source !== previousSource)) path.push(text);
    previousSource = source;
  }
  return path;
}

function exactLeaf(key: string, name: string): boolean {
  if (!key.startsWith(name)) return false;
  return /^(?:주식수|백만주|천주|주|%)?[0-9]*$/.test(key.slice(name.length));
}

function matchesHeader(path: readonly string[], alias: string): boolean {
  const parts = alias.split('>').map(headerKey);
  const keys = path.map(headerKey);
  // Contextual aliases bind a leaf such as 증감 to its actual share-count parent.
  if (parts.length > 1) {
    let next = 0;
    for (const key of keys) {
      const part = parts[next];
      if (part && (next === parts.length - 1 ? exactLeaf(key, part) : key.startsWith(part)))
        next += 1;
    }
    return next === parts.length;
  }
  return keys.some((key) =>
    parts[0] === '수량' ? exactLeaf(key, parts[0]) : key === parts[0] || key.startsWith(parts[0]!),
  );
}

export function locateHeader<TField extends string>(
  table: CanonicalTable,
  aliases: HeaderAliases<TField>,
  required: readonly TField[],
): HeaderMatch<TField> | null {
  let best: HeaderMatch<TField> | null = null;
  for (let start = 0; start < Math.min(12, table.rows.length); start += 1) {
    for (let end = start; end < Math.min(start + 6, table.rows.length); end += 1) {
      const cells = table.sourceRows[end] ?? [];
      // TU/TE are typed source data. Never let their values become header aliases.
      if (cells.some((cell) => cell.tag === 'TU' || cell.tag === 'TE')) break;
      if (end > start && !cells.some((cell) => cell.tag === 'TH')) break;
      const width = table.rows[end]?.length ?? 0;
      const columns: Partial<Record<TField, number>> = {};
      for (const [field, fieldAliases] of Object.entries(aliases) as [
        TField,
        readonly string[],
      ][]) {
        for (const alias of fieldAliases) {
          const candidates = Array.from({ length: width }, (_, column) => column).filter(
            (column) => {
              const path = headerPathFor(table, start, end, column);
              const leaf = path.at(-1)?.normalize('NFKC').replace(/\s/g, '') ?? '';
              if (
                (field === 'quantity' || field === 'sharesAfter') &&
                /금액|가격|단가|비율|%|[([{](?:억원|백만원|천원|원)[)\]}]/.test(leaf)
              )
                return false;
              return matchesHeader(path, alias);
            },
          );
          // An ambiguous parent spanning several columns is not a field value.
          if (candidates.length === 1) {
            columns[field] = candidates[0];
            break;
          }
        }
      }
      const matchedFields = Object.keys(columns).length;
      if (!required.every((field) => columns[field] !== undefined)) continue;
      if (
        !best ||
        matchedFields > best.matchedFields ||
        (matchedFields === best.matchedFields &&
          start === best.headerStartRow &&
          end > best.headerEndRow &&
          cells.some((cell) => cell.tag === 'TH'))
      ) {
        best = { headerStartRow: start, headerEndRow: end, columns, matchedFields };
      }
    }
    if (best) break;
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

export function hasSourceValue(value: string): boolean {
  return Boolean(value) && !/^[-―—–\s]+$/.test(value);
}

export function isDataRow(row: readonly string[]): boolean {
  const first = normalizeHeader(row.find((value) => hasSourceValue(value)) ?? '');
  return Boolean(first) && !/^(합계|총계|소계)$/.test(first) && first !== '계';
}

export function fieldProvenance(
  table: CanonicalTable,
  rowIndex: number,
  columnIndex: number,
  headerPath: readonly string[] = [],
): FieldProvenance {
  const cell = table.grid[rowIndex]?.[columnIndex];
  return {
    sourcePath: table.path,
    sourceEntryName: table.sourceEntryName,
    tableIndex: table.index,
    rowIndex,
    columnIndex,
    sourceRowIndex: cell?.sourceRowIndex ?? rowIndex,
    sourceColumnIndex: cell?.sourceColumnIndex ?? columnIndex,
    headerPath,
    rawText: cell?.rawText ?? table.rows[rowIndex]?.[columnIndex] ?? '',
  };
}

export function rowProvenance<TField extends string>(
  table: CanonicalTable,
  header: HeaderMatch<TField>,
  rowIndex: number,
): FieldProvenanceMap {
  const names: Readonly<Record<string, string>> = {
    method: 'methodRaw',
    securityType: 'securityTypeRaw',
    startDate: 'plannedStartDate',
    endDate: 'plannedEndDate',
  };
  return Object.fromEntries(
    Object.entries(header.columns).map(([field, column]) => [
      names[field] ?? field,
      fieldProvenance(
        table,
        rowIndex,
        column as number,
        headerPathFor(table, header.headerStartRow, header.headerEndRow, column as number),
      ),
    ]),
  );
}

export function emptyExtractionWarning(
  tables: readonly CanonicalTable[],
  headersFound: number,
  rowsFound: number,
): ParserWarning {
  const code =
    tables.length === 0
      ? 'TABLE_NOT_FOUND'
      : headersFound === 0
        ? 'REQUIRED_HEADER_NOT_FOUND'
        : rowsFound === 0
          ? 'NO_DATA_ROWS'
          : 'ROWS_FOUND_BUT_INVALID';
  const messages = {
    TABLE_NOT_FOUND: '추출할 표가 없습니다.',
    REQUIRED_HEADER_NOT_FOUND: '필수 거래 표 헤더를 찾지 못했습니다.',
    NO_DATA_ROWS: '거래 표에 실제 데이터 행이 없습니다.',
    ROWS_FOUND_BUT_INVALID: '데이터 행은 있으나 유효한 필수 거래값을 추출하지 못했습니다.',
  };
  return { code, message: messages[code] };
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
  if (match) return { unitRaw: match[0], multiplier: match[1] };
  return { multiplier: 1, unitRaw: kind === 'MONEY' && /\(\s*원\s*\)/.test(raw) ? '원' : null };
}

export interface LocatedValue {
  readonly value: string;
  readonly provenance: FieldProvenance;
}

const LABEL_ONLY_VALUES = new Set([
  '보유비율',
  '보유주식등의수',
  '임원등기여부',
  '직위명',
  '한글',
  '한자영문',
  '주요주주',
]);

export function findLabelCell(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): LocatedValue | null {
  // Alias order expresses specificity: reporter 직위명 must precede contact 직위.
  for (const candidate of labels.map(headerKey)) {
    for (const table of tables) {
      for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
        const row = table.rows[rowIndex]!;
        if (row.some((text) => /업무상연락처|담당자/.test(headerKey(text)))) continue;
        for (let column = 0; column < row.length - 1; column += 1) {
          if (headerKey(row[column] ?? '') !== candidate) continue;
          const labelCell = table.grid[rowIndex]?.[column];
          if (!labelCell || labelCell.sourceRowIndex !== rowIndex) continue;
          let next = column + 1;
          while (next < row.length && table.grid[rowIndex]?.[next] === labelCell) next += 1;
          const valueCell = table.grid[rowIndex]?.[next];
          const value = normalizeWhitespace(row[next] ?? '');
          if (
            !valueCell ||
            valueCell.tag === 'TH' ||
            !hasSourceValue(value) ||
            LABEL_ONLY_VALUES.has(headerKey(value)) ||
            headerKey(value) === candidate
          )
            continue;
          return { value, provenance: fieldProvenance(table, rowIndex, next, [row[column]!]) };
        }
      }
    }
  }
  return null;
}

export function findLabelValue(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): string | null {
  return findLabelCell(tables, labels)?.value ?? null;
}

/** Summary matrices explicitly identify the current report or the change row. */
export function findSummaryCell(
  tables: readonly CanonicalTable[],
  aliases: readonly string[],
  rowLabels: readonly string[],
): LocatedValue | null {
  for (const table of tables) {
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex]!;
      if (!row.some((text) => rowLabels.includes(headerKey(text)))) continue;
      for (let column = 0; column < row.length; column += 1) {
        const path = headerPathFor(table, Math.max(0, rowIndex - 4), rowIndex - 1, column);
        if (!aliases.some((alias) => matchesHeader(path, alias))) continue;
        const cell = table.grid[rowIndex]?.[column];
        if (!cell || cell.sourceRowIndex !== rowIndex || cell.tag === 'TH') continue;
        const value = row[column] ?? '';
        if (!hasSourceValue(value)) continue;
        return { value, provenance: fieldProvenance(table, rowIndex, column, path) };
      }
    }
  }
  return null;
}

export function summaryProvenance(
  values: Readonly<Record<string, LocatedValue | null>>,
): FieldProvenanceMap {
  return Object.fromEntries(
    Object.entries(values).flatMap(([field, located]) =>
      located ? [[field, located.provenance]] : [],
    ),
  );
}

/** DART comparison sections quote both the old and corrected rows. The report body is authoritative. */
export function disclosureBodyTables(tables: readonly CanonicalTable[]): readonly CanonicalTable[] {
  return tables.filter((table) => !table.path.some((tag) => tag.toUpperCase() === 'CORRECTION'));
}

export function missingRequiredRowWarnings(
  quantity: string | null,
  methodRaw: string,
  tableIndex: number,
  rowIndex: number,
): ParserWarning[] {
  const warnings: ParserWarning[] = [];
  if (quantity === null)
    warnings.push({
      code: 'MISSING_REQUIRED_QUANTITY',
      message: '필수 변동 수량이 없거나 유효한 숫자가 아닙니다.',
      field: 'quantity',
      tableIndex,
      rowIndex,
    });
  if (!hasSourceValue(methodRaw))
    warnings.push({
      code: 'MISSING_REQUIRED_METHOD',
      message: '필수 변동 방법이 없습니다.',
      field: 'methodRaw',
      tableIndex,
      rowIndex,
    });
  return warnings;
}
