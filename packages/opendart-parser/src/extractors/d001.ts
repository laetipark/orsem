import { Direction } from '@orsem/contracts';
import { directionFromQuantity } from '../classifier';
import { normalizeDateOnly, parseDecimal, parseInteger, scaleNumeric } from '../normalizers';
import type {
  CanonicalTable,
  ParsedLargeHoldingChange,
  ParserWarning,
  FieldProvenanceMap,
} from '../types';
import {
  cellAt,
  disclosureBodyTables,
  missingRequiredRowWarnings,
  findLabelCell,
  findSummaryCell,
  hasSourceValue,
  emptyExtractionWarning,
  rowProvenance,
  summaryProvenance,
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
  quantity: ['변동수량', '증감수량', '취득/처분수량', '변동내역>증감'],
};

export interface D001Extraction {
  readonly provenance: FieldProvenanceMap;
  readonly confidence: number;
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
  tables = disclosureBodyTables(tables);
  const warnings: ParserWarning[] = [];
  let headersFound = 0;
  let rowsFound = 0;
  const changes: ParsedLargeHoldingChange[] = [];
  for (const table of tables) {
    const header = locateHeader<D001Field>(table, HEADERS, ['method', 'quantity']);
    if (!header) continue;
    headersFound += 1;
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
      if (!hasSourceValue(methodRaw) && !hasSourceValue(quantityRaw)) continue;
      rowsFound += 1;
      const quantity = parseInteger(quantityRaw, 'quantity');
      const quantityValue = quantity.unitRaw
        ? quantity.value
        : scaleNumeric(quantity.value, quantityHeaderUnit.multiplier);
      const rowWarnings: ParserWarning[] = missingRequiredRowWarnings(
        quantityValue,
        methodRaw,
        table.index,
        rowIndex,
      );
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
        provenance: rowProvenance(table, header, rowIndex),
        confidence:
          quantityValue === null || !hasSourceValue(methodRaw) ? 0 : rowWarnings.length ? 0.5 : 1,
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
  const located = {
    reportTypeRaw: findLabelCell(tables, ['보고구분', '보고유형']),
    reporterName: findLabelCell(tables, ['대표보고자', '보고자', '성명']),
    reportReasonRaw: findLabelCell(tables, ['보고사유', '변동사유']),
    sharesAfter:
      findSummaryCell(tables, ['보유주식등의수', '주식등>주식등의수'], ['이번보고서']) ??
      findLabelCell(tables, ['보유주식등의수', '보유수량']),
    sharesChange:
      findSummaryCell(tables, ['주식등>주식등의수'], ['증감']) ??
      findLabelCell(tables, ['보유주식등의증감', '보유수량증감']),
    ownershipRateAfter:
      findSummaryCell(tables, ['보유비율', '주식등>비율'], ['이번보고서']) ??
      findLabelCell(tables, ['보유비율', '보유비율합계']),
    ownershipRateChange:
      findSummaryCell(tables, ['주식등>비율'], ['증감']) ??
      findLabelCell(tables, ['보유비율증감', '증감비율']),
  };
  const numeric = (
    field: 'sharesAfter' | 'sharesChange' | 'ownershipRateAfter' | 'ownershipRateChange',
    integer: boolean,
  ): string | null => {
    const cell = located[field];
    if (!cell) return null;
    const parsed = integer ? parseInteger(cell.value, field) : parseDecimal(cell.value, field);
    if (parsed.warning)
      warnings.push({
        ...parsed.warning,
        tableIndex: cell.provenance.tableIndex,
        rowIndex: cell.provenance.rowIndex,
      });
    return parsed.value;
  };
  const reportTypeRaw = located.reportTypeRaw?.value ?? null;
  const reporterName = located.reporterName?.value ?? null;
  const reportReasonRaw = located.reportReasonRaw?.value ?? null;
  const sharesAfter = numeric('sharesAfter', true);
  const sharesChange = numeric('sharesChange', true);
  const ownershipRateAfter = numeric('ownershipRateAfter', false);
  const ownershipRateChange = numeric('ownershipRateChange', false);
  const validRows = changes.filter((row) => (row.confidence ?? 0) > 0);
  if (validRows.length === 0)
    warnings.push(emptyExtractionWarning(tables, headersFound, rowsFound));
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
    provenance: summaryProvenance(located),
    confidence: validRows.length === 0 ? 0 : Math.min(...changes.map((row) => row.confidence ?? 0)),
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
