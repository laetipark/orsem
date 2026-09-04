import { Direction } from '@orsem/contracts';
import { directionFromQuantity } from '../classifier';
import { normalizeDateOnly, parseDecimal, parseInteger, scaleNumeric } from '../normalizers';
import type { CanonicalTable, ParsedLargeHoldingChange, ParserWarning } from '../types';
import {
  cellAt,
  findLabelValue,
  headerScaleForColumn,
  isDataRow,
  locateHeader,
  type HeaderAliases,
} from './shared';

type D001Field = 'eventDate' | 'securityType' | 'method' | 'quantity';

const HEADERS: HeaderAliases<D001Field> = {
  eventDate: ['변동일', '변동일자', '계약체결일', '거래일'],
  securityType: ['주식등의종류', '증권의종류', '특정증권등의종류'],
  method: ['변동방법', '취득/처분방법', '취득처분방법', '보고사유'],
  quantity: ['변동수량', '증감수량', '취득/처분수량'],
};

function parseOptionalIntegerLabel(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
  field: string,
  warnings: ParserWarning[],
): string | null {
  const raw = findLabelValue(tables, labels);
  if (!raw) return null;
  const parsed = parseInteger(raw, field);
  if (parsed.warning) warnings.push(parsed.warning);
  return parsed.value;
}

function parseOptionalDecimalLabel(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
  field: string,
  warnings: ParserWarning[],
): string | null {
  const raw = findLabelValue(tables, labels);
  if (!raw) return null;
  const parsed = parseDecimal(raw, field);
  if (parsed.warning) warnings.push(parsed.warning);
  return parsed.value;
}

export interface D001Extraction {
  readonly reportTypeRaw: string | null;
  readonly reporterName: string | null;
  readonly reportReasonRaw: string | null;
  readonly sharesAfter: string | null;
  readonly sharesChange: string | null;
  readonly ownershipRateAfter: string | null;
  readonly ownershipRateChange: string | null;
  readonly changes: readonly ParsedLargeHoldingChange[];
  readonly warnings: readonly ParserWarning[];
  readonly score: number;
}

export function extractD001(tables: readonly CanonicalTable[]): D001Extraction {
  const warnings: ParserWarning[] = [];
  const changes: ParsedLargeHoldingChange[] = [];
  for (const table of tables) {
    const header = locateHeader<D001Field>(table, HEADERS, ['method', 'quantity']);
    if (!header) continue;
    const quantityHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.quantity,
      'SHARES',
    );
    for (let rowIndex = header.headerEndRow + 1; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex];
      if (!row || !isDataRow(row)) continue;
      const eventDateRaw = cellAt(row, header.columns, 'eventDate');
      const securityTypeRaw = cellAt(row, header.columns, 'securityType');
      const methodRaw = cellAt(row, header.columns, 'method');
      const quantityRaw = cellAt(row, header.columns, 'quantity');
      if (!methodRaw && !quantityRaw) continue;
      const quantity = parseInteger(quantityRaw, 'quantity');
      const quantityValue = quantity.unitRaw
        ? quantity.value
        : scaleNumeric(quantity.value, quantityHeaderUnit.multiplier);
      const rowWarnings: ParserWarning[] = [];
      if (quantity.warning) rowWarnings.push(quantity.warning);
      if (
        quantity.value !== null &&
        !quantity.unitRaw &&
        quantityHeaderUnit.multiplier > 1 &&
        quantityValue === null
      ) {
        rowWarnings.push({
          code: 'NUMERIC_OUT_OF_RANGE',
          message: '헤더 단위를 적용한 수량이 DECIMAL(38,6) 범위를 초과했습니다.',
          field: 'quantity',
        });
      }
      const eventDate = normalizeDateOnly(eventDateRaw);
      if (eventDateRaw && !eventDate) {
        rowWarnings.push({
          code: 'INVALID_DATE',
          message: `날짜를 안전하게 해석할 수 없습니다: ${eventDateRaw}`,
          field: 'eventDate',
        });
      }
      const change: ParsedLargeHoldingChange = {
        rowIndex,
        eventDate,
        securityTypeRaw,
        methodRaw,
        direction: (quantityValue
          ? directionFromQuantity(quantityValue)
          : Direction.UNKNOWN) as Direction,
        quantity: quantityValue,
        warnings: rowWarnings.map((warning) => ({
          ...warning,
          tableIndex: table.index,
          rowIndex,
        })),
      };
      changes.push(change);
      warnings.push(...change.warnings);
    }
  }
  const reportTypeRaw = findLabelValue(tables, ['보고구분', '보고유형']);
  const reporterName = findLabelValue(tables, ['대표보고자', '보고자', '성명']);
  const reportReasonRaw = findLabelValue(tables, ['보고사유', '변동사유']);
  const sharesAfter = parseOptionalIntegerLabel(
    tables,
    ['보유주식등의수', '보유수량'],
    'sharesAfter',
    warnings,
  );
  const sharesChange = parseOptionalIntegerLabel(
    tables,
    ['보유주식등의증감', '보유수량증감'],
    'sharesChange',
    warnings,
  );
  const ownershipRateAfter = parseOptionalDecimalLabel(
    tables,
    ['보유비율', '보유비율합계'],
    'ownershipRateAfter',
    warnings,
  );
  const ownershipRateChange = parseOptionalDecimalLabel(
    tables,
    ['보유비율증감', '증감비율'],
    'ownershipRateChange',
    warnings,
  );
  const populated = [
    reportTypeRaw,
    reporterName,
    reportReasonRaw,
    sharesAfter,
    sharesChange,
    ownershipRateAfter,
    ownershipRateChange,
  ].filter(Boolean).length;
  return {
    reportTypeRaw,
    reporterName,
    reportReasonRaw,
    sharesAfter,
    sharesChange,
    ownershipRateAfter,
    ownershipRateChange,
    changes,
    warnings,
    score: changes.length * 100 + populated * 5,
  };
}
