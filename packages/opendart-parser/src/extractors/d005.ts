import type { Direction, TransactionNature } from '@orsem/contracts';
import { classifyTransactionMethod } from '../classifier';
import {
  normalizeDateOnly,
  normalizeWhitespace,
  parseDecimal,
  parseInteger,
  scaleNumeric,
} from '../normalizers';
import type {
  CanonicalTable,
  ParsedTradePlanItem,
  ParserWarning,
  FieldProvenanceMap,
} from '../types';
import {
  cellAt,
  disclosureBodyTables,
  missingRequiredRowWarnings,
  findLabelCell,
  hasSourceValue,
  emptyExtractionWarning,
  rowProvenance,
  summaryProvenance,
  headerScaleForColumn,
  isDataRow,
  locateHeader,
  type HeaderAliases,
} from './shared';

type D005Field =
  | 'startDate'
  | 'endDate'
  | 'dateRange'
  | 'securityType'
  | 'method'
  | 'quantity'
  | 'priceMin'
  | 'priceMax'
  | 'plannedUnitPrice'
  | 'plannedAmount';

const HEADERS: HeaderAliases<D005Field> = {
  startDate: ['거래개시일', '거래시작일', '예정시작일', '시작일'],
  endDate: ['거래종료일', '거래종료예정일', '예정종료일', '종료일'],
  dateRange: ['거래예정기간', '거래기간', '예정기간'],
  securityType: ['특정증권등의종류', '증권의종류', '주식등의종류'],
  method: ['거래방법', '취득/처분방법', '취득처분방법', '거래구분'],
  quantity: ['거래예정수량', '예정수량', '거래수량', '특정증권등의수', '수량'],
  plannedUnitPrice: ['취득/처분단가', '취득처분단가'],
  plannedAmount: ['거래금액'],
  priceMin: ['최저가격', '최저단가', '가격하한'],
  priceMax: ['최고가격', '최고단가', '가격상한'],
};

function splitDateRange(raw: string): readonly [string | null, string | null] {
  const normalized = normalizeWhitespace(raw);
  // 2026-09-05-2026-10-04처럼 붙여 쓴 값에서는 일반 하이픈도 기간 구분자로 쓰입니다.
  // 날짜 안의 문장 부호를 기간 구분자로 오인하지 않도록,
  // 더 관대한 기존 분리기를 쓰기 전에 완전한 날짜 토큰 두 개를 먼저 찾습니다.
  const explicit =
    /^\s*(\d{4}[.\x2f-]?\d{1,2}[.\x2f-]?\d{1,2})\s*(?:~|∼|～|부터|-)\s*(\d{4}[.\x2f-]?\d{1,2}[.\x2f-]?\d{1,2})\s*$/.exec(
      normalized,
    );
  if (explicit) {
    return [normalizeDateOnly(explicit[1] ?? ''), normalizeDateOnly(explicit[2] ?? '')];
  }
  const parts = normalized.split(/\s*(?:~|∼|～|부터|\s+-\s+)\s*/);
  if (parts.length < 2) return [normalizeDateOnly(raw), null];
  return [normalizeDateOnly(parts[0] ?? ''), normalizeDateOnly(parts[1] ?? '')];
}

export interface D005Extraction {
  readonly provenance: FieldProvenanceMap;
  readonly confidence: number;
  readonly reporterName: string | null;
  readonly relationshipRaw: string | null;
  readonly positionRaw: string | null;
  readonly planItems: readonly ParsedTradePlanItem[];
  readonly warnings: readonly ParserWarning[];
  readonly score: number;
}

export function extractD005(tables: readonly CanonicalTable[]): D005Extraction {
  tables = disclosureBodyTables(tables);
  const warnings: ParserWarning[] = [];
  let headersFound = 0;
  let rowsFound = 0;
  const planItems: ParsedTradePlanItem[] = [];
  for (const table of tables) {
    const header = locateHeader<D005Field>(table, HEADERS, ['method', 'quantity']);
    if (
      !header ||
      !(
        (header.columns.startDate !== undefined && header.columns.endDate !== undefined) ||
        header.columns.dateRange !== undefined
      )
    )
      continue;
    headersFound += 1;
    const quantityHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.quantity,
      'SHARES',
    );
    const priceMinHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.priceMin,
      'MONEY',
    );
    const priceMaxHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.priceMax,
      'MONEY',
    );
    const plannedPriceHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.plannedUnitPrice,
      'MONEY',
    );
    const plannedAmountHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.plannedAmount,
      'MONEY',
    );
    for (let rowIndex = header.headerEndRow + 1; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex];
      if (!row || !isDataRow(row)) continue;
      const methodRaw = cellAt(row, header.columns, 'method');
      const securityTypeRaw = cellAt(row, header.columns, 'securityType');
      const quantityRaw = cellAt(row, header.columns, 'quantity');
      if (!hasSourceValue(methodRaw) && !hasSourceValue(quantityRaw)) continue;
      rowsFound += 1;
      const rangeRaw = cellAt(row, header.columns, 'dateRange');
      const [rangeStart, rangeEnd] = splitDateRange(rangeRaw);
      const startRaw = cellAt(row, header.columns, 'startDate');
      const endRaw = cellAt(row, header.columns, 'endDate');
      const plannedStartDate = normalizeDateOnly(startRaw) ?? rangeStart;
      const plannedEndDate = normalizeDateOnly(endRaw) ?? rangeEnd;
      const quantity = parseInteger(quantityRaw, 'quantity');
      const priceMin = parseDecimal(cellAt(row, header.columns, 'priceMin'), 'priceMin');
      const priceMax = parseDecimal(cellAt(row, header.columns, 'priceMax'), 'priceMax');
      const plannedUnitPrice = parseDecimal(
        cellAt(row, header.columns, 'plannedUnitPrice'),
        'plannedUnitPrice',
      );
      const plannedAmount = parseDecimal(
        cellAt(row, header.columns, 'plannedAmount'),
        'plannedAmount',
      );
      const quantityValue = quantity.unitRaw
        ? quantity.value
        : scaleNumeric(quantity.value, quantityHeaderUnit.multiplier);
      const priceMinValue = priceMin.unitRaw
        ? priceMin.value
        : scaleNumeric(priceMin.value, priceMinHeaderUnit.multiplier);
      const priceMaxValue = priceMax.unitRaw
        ? priceMax.value
        : scaleNumeric(priceMax.value, priceMaxHeaderUnit.multiplier);
      const plannedUnitPriceValue = plannedUnitPrice.unitRaw
        ? plannedUnitPrice.value
        : scaleNumeric(plannedUnitPrice.value, plannedPriceHeaderUnit.multiplier);
      const plannedAmountValue = plannedAmount.unitRaw
        ? plannedAmount.value
        : scaleNumeric(plannedAmount.value, plannedAmountHeaderUnit.multiplier);
      const classification = classifyTransactionMethod(methodRaw, quantityValue, {
        quantityIsAbsolute: true,
      });
      const rowWarnings: ParserWarning[] = [
        ...missingRequiredRowWarnings(quantityValue, methodRaw, table.index, rowIndex),
        quantity.warning,
        priceMin.warning,
        priceMax.warning,
        plannedUnitPrice.warning,
        plannedAmount.warning,
        ...classification.warnings,
      ]
        .filter((warning): warning is ParserWarning => warning !== null)
        .map((warning) => ({ ...warning, tableIndex: table.index, rowIndex }));
      for (const [field, parsedValue, inlineUnit, headerMultiplier, scaledValue] of [
        [
          'quantity',
          quantity.value,
          quantity.unitRaw,
          quantityHeaderUnit.multiplier,
          quantityValue,
        ],
        [
          'priceMin',
          priceMin.value,
          priceMin.unitRaw,
          priceMinHeaderUnit.multiplier,
          priceMinValue,
        ],
        [
          'priceMax',
          priceMax.value,
          priceMax.unitRaw,
          priceMaxHeaderUnit.multiplier,
          priceMaxValue,
        ],
        [
          'plannedUnitPrice',
          plannedUnitPrice.value,
          plannedUnitPrice.unitRaw,
          plannedPriceHeaderUnit.multiplier,
          plannedUnitPriceValue,
        ],
        [
          'plannedAmount',
          plannedAmount.value,
          plannedAmount.unitRaw,
          plannedAmountHeaderUnit.multiplier,
          plannedAmountValue,
        ],
      ] as const) {
        if (parsedValue !== null && !inlineUnit && headerMultiplier > 1 && scaledValue === null) {
          rowWarnings.push({
            code: 'NUMERIC_OUT_OF_RANGE',
            message: `헤더 단위를 적용한 ${field} 값이 DECIMAL(38,6) 범위를 초과했습니다.`,
            field,
            tableIndex: table.index,
            rowIndex,
          });
        }
      }
      if ((startRaw || rangeRaw) && !plannedStartDate) {
        rowWarnings.push({
          code: 'INVALID_DATE',
          message: '거래계획 시작일을 안전하게 해석할 수 없습니다.',
          tableIndex: table.index,
          rowIndex,
          field: 'plannedStartDate',
        });
      }
      if ((endRaw || rangeRaw) && !plannedEndDate) {
        rowWarnings.push({
          code: 'INVALID_DATE',
          message: '거래계획 종료일을 안전하게 해석할 수 없습니다.',
          tableIndex: table.index,
          rowIndex,
          field: 'plannedEndDate',
        });
      }
      const item: ParsedTradePlanItem = {
        rowIndex,
        provenance: rowProvenance(table, header, rowIndex),
        confidence:
          quantityValue === null ||
          !hasSourceValue(methodRaw) ||
          !plannedStartDate ||
          !plannedEndDate
            ? 0
            : Math.min(classification.confidence, rowWarnings.length ? 0.75 : 1),
        plannedStartDate,
        plannedEndDate,
        securityTypeRaw,
        methodRaw,
        nature: classification.nature as TransactionNature,
        direction: classification.direction as Direction,
        quantity: quantityValue,
        priceMin: priceMinValue,
        priceMax: priceMaxValue,
        plannedUnitPrice: plannedUnitPriceValue,
        plannedAmount: plannedAmountValue,
        currency:
          (plannedUnitPrice.unitRaw &&
            /^(억원|백만원|천원|원|krw)$/i.test(plannedUnitPrice.unitRaw)) ||
          plannedPriceHeaderUnit.unitRaw
            ? 'KRW'
            : null,
        warnings: rowWarnings,
      };
      planItems.push(item);
      warnings.push(...rowWarnings);
    }
  }
  const located = {
    reporterName: findLabelCell(tables, ['보고자', '보고자성명', '성명']),
    relationshipRaw: findLabelCell(tables, [
      '임원(등기여부)',
      '주요주주',
      '발행회사와의관계',
      '발행회사관계',
      '관계',
    ]),
    positionRaw: findLabelCell(tables, ['직위명', '임원직위', '직위']),
  };
  const reporterName = located.reporterName?.value ?? null;
  const relationshipRaw = located.relationshipRaw?.value ?? null;
  const positionRaw = located.positionRaw?.value ?? null;
  const validRows = planItems.filter((row) => (row.confidence ?? 0) > 0);
  if (validRows.length === 0)
    warnings.push(emptyExtractionWarning(tables, headersFound, rowsFound));
  return {
    provenance: summaryProvenance(located),
    confidence:
      validRows.length === 0 ? 0 : Math.min(...planItems.map((row) => row.confidence ?? 0)),
    reporterName,
    relationshipRaw,
    positionRaw,
    planItems,
    warnings,
    score:
      planItems.length * 100 +
      [reporterName, relationshipRaw, positionRaw].filter(Boolean).length * 5,
  };
}
