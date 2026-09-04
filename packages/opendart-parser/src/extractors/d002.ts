import { TransactionNature, type Direction } from '@orsem/contracts';
import { classifyTransactionMethod } from '../classifier';
import {
  multiplyIntegerAndDecimal,
  normalizeDateOnly,
  normalizeHeader,
  parseInteger,
  scaleNumeric,
} from '../normalizers';
import { parseUnitPrice } from './unit-price';
import type {
  CanonicalTable,
  ParsedInsiderTransaction,
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

type D002Field = 'eventDate' | 'securityType' | 'method' | 'quantity' | 'unitPrice' | 'sharesAfter';

const HEADERS: HeaderAliases<D002Field> = {
  eventDate: ['소유상황변동일', '변동일자', '변동일', '거래일'],
  securityType: ['특정증권등의종류', '특정증권등 종류', '증권의종류', '주식등의종류', '증권종류'],
  method: ['취득/처분방법', '취득처분방법', '변동사유', '거래종류', '보고사유'],
  quantity: ['취득/처분수량', '취득처분수량', '변동수량', '증감수량', '소유주식수>증감'],
  unitPrice: ['취득/처분단가', '취득처분단가', '주당거래단가', '거래단가', '주당단가', '단가'],
  sharesAfter: ['변동후수량', '거래후보유수량', '소유수량', '잔고', '소유주식수>변동후'],
};

function warningForInvalidDate(
  raw: string,
  tableIndex: number,
  rowIndex: number,
): ParserWarning | null {
  if (!raw || normalizeDateOnly(raw)) return null;
  return {
    code: 'INVALID_DATE',
    message: `날짜를 안전하게 해석할 수 없습니다: ${raw}`,
    tableIndex,
    rowIndex,
    field: 'eventDate',
  };
}

function currencyFromUnit(unitRaw: string | null): string | null {
  if (!unitRaw) return null;
  if (/^(억원|백만원|천원|원|krw)$/i.test(unitRaw)) return 'KRW';
  if (/^(달러|usd)$/i.test(unitRaw)) return 'USD';
  return null;
}

function canCalculateShareAmount(securityTypeRaw: string): boolean {
  const normalized = normalizeHeader(securityTypeRaw);
  return /(보통주|우선주|주식)/.test(normalized);
}

const AMOUNT_BEARING_NATURES = new Set<TransactionNature>([
  TransactionNature.MARKET_BUY,
  TransactionNature.MARKET_SELL,
  TransactionNature.BLOCK_BUY,
  TransactionNature.BLOCK_SELL,
  TransactionNature.OFF_MARKET_BUY,
  TransactionNature.OFF_MARKET_SELL,
  TransactionNature.AFTER_HOURS_BUY,
  TransactionNature.AFTER_HOURS_SELL,
]);

export interface D002Extraction {
  readonly provenance: FieldProvenanceMap;
  readonly confidence: number;
  readonly reporterName: string | null;
  readonly relationshipRaw: string | null;
  readonly positionRaw: string | null;
  readonly transactions: readonly ParsedInsiderTransaction[];
  readonly warnings: readonly ParserWarning[];
  readonly score: number;
}

export function extractD002(tables: readonly CanonicalTable[]): D002Extraction {
  tables = disclosureBodyTables(tables);
  const warnings: ParserWarning[] = [];
  let headersFound = 0;
  let rowsFound = 0;
  const transactions: ParsedInsiderTransaction[] = [];
  for (const table of tables) {
    const header = locateHeader<D002Field>(table, HEADERS, ['method', 'quantity']);
    if (!header) continue;
    headersFound += 1;
    const quantityHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.quantity,
      'SHARES',
    );
    const priceHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.unitPrice,
      'MONEY',
    );
    const sharesAfterHeaderUnit = headerScaleForColumn(
      table,
      header.headerEndRow,
      header.columns.sharesAfter,
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
      const unitPrice = parseUnitPrice(cellAt(row, header.columns, 'unitPrice'));
      const sharesAfter = parseInteger(cellAt(row, header.columns, 'sharesAfter'), 'sharesAfter');
      const quantityValue = quantity.unitRaw
        ? quantity.value
        : scaleNumeric(quantity.value, quantityHeaderUnit.multiplier);
      const unitPriceValue = unitPrice.unitRaw
        ? unitPrice.value
        : scaleNumeric(unitPrice.value, priceHeaderUnit.multiplier);
      const sharesAfterValue = sharesAfter.unitRaw
        ? sharesAfter.value
        : scaleNumeric(sharesAfter.value, sharesAfterHeaderUnit.multiplier);
      const classification = classifyTransactionMethod(methodRaw, quantityValue);
      const rowWarnings: ParserWarning[] = [
        ...missingRequiredRowWarnings(quantityValue, methodRaw, table.index, rowIndex),
        quantity.warning,
        unitPrice.warning,
        sharesAfter.warning,
        warningForInvalidDate(eventDateRaw, table.index, rowIndex),
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
          'unitPrice',
          unitPrice.value,
          unitPrice.unitRaw,
          priceHeaderUnit.multiplier,
          unitPriceValue,
        ],
        [
          'sharesAfter',
          sharesAfter.value,
          sharesAfter.unitRaw,
          sharesAfterHeaderUnit.multiplier,
          sharesAfterValue,
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
      const amount =
        quantityValue &&
        unitPriceValue &&
        AMOUNT_BEARING_NATURES.has(classification.nature) &&
        canCalculateShareAmount(securityTypeRaw)
          ? multiplyIntegerAndDecimal(quantityValue.replace(/^-/, ''), unitPriceValue)
          : null;
      if (
        quantityValue &&
        unitPriceValue &&
        AMOUNT_BEARING_NATURES.has(classification.nature) &&
        canCalculateShareAmount(securityTypeRaw) &&
        amount === null
      ) {
        rowWarnings.push({
          code: 'NUMERIC_OUT_OF_RANGE',
          message: '계산 거래금액이 DECIMAL(38,6) 범위를 초과했습니다.',
          field: 'amount',
          tableIndex: table.index,
          rowIndex,
        });
      }
      const transaction: ParsedInsiderTransaction = {
        rowIndex,
        provenance: rowProvenance(table, header, rowIndex),
        eventDate: normalizeDateOnly(eventDateRaw),
        securityTypeRaw,
        methodRaw,
        nature: classification.nature as TransactionNature,
        direction: classification.direction as Direction,
        quantity: quantityValue,
        quantityUnitRaw: quantity.unitRaw ?? quantityHeaderUnit.unitRaw,
        unitPrice: unitPriceValue,
        amount,
        amountSource: amount === null ? null : 'CALCULATED',
        currency: currencyFromUnit(unitPrice.unitRaw) ?? (priceHeaderUnit.unitRaw ? 'KRW' : null),
        sharesAfter: sharesAfterValue,
        confidence:
          quantityValue === null || !hasSourceValue(methodRaw)
            ? 0
            : rowWarnings.length === 0
              ? classification.confidence
              : Math.min(classification.confidence, 0.75),
        warnings: rowWarnings,
      };
      transactions.push(transaction);
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
  const validRows = transactions.filter((row) => (row.confidence ?? 0) > 0);
  if (validRows.length === 0)
    warnings.push(emptyExtractionWarning(tables, headersFound, rowsFound));
  return {
    provenance: summaryProvenance(located),
    confidence:
      validRows.length === 0 ? 0 : Math.min(...transactions.map((row) => row.confidence ?? 0)),
    reporterName,
    relationshipRaw,
    positionRaw,
    transactions,
    warnings,
    score:
      transactions.length * 100 +
      [reporterName, relationshipRaw, positionRaw].filter(Boolean).length * 5,
  };
}
