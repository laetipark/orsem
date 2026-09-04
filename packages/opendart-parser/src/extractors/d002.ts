import { TransactionNature, type Direction } from '@orsem/contracts';
import { classifyTransactionMethod } from '../classifier';
import {
  multiplyIntegerAndDecimal,
  normalizeDateOnly,
  normalizeHeader,
  parseDecimal,
  parseInteger,
  scaleNumeric,
} from '../normalizers';
import type { CanonicalTable, ParsedInsiderTransaction, ParserWarning } from '../types';
import {
  cellAt,
  findLabelValue,
  headerScaleForColumn,
  isDataRow,
  locateHeader,
  type HeaderAliases,
} from './shared';

type D002Field = 'eventDate' | 'securityType' | 'method' | 'quantity' | 'unitPrice' | 'sharesAfter';

const HEADERS: HeaderAliases<D002Field> = {
  eventDate: ['소유상황변동일', '변동일자', '변동일', '거래일'],
  securityType: ['특정증권등의종류', '특정증권등 종류', '증권의종류', '주식등의종류', '증권종류'],
  method: ['취득/처분방법', '취득처분방법', '변동사유', '거래종류'],
  quantity: ['취득/처분수량', '취득처분수량', '변동수량', '증감수량'],
  unitPrice: ['주당거래단가', '거래단가', '주당단가', '단가'],
  sharesAfter: ['변동후수량', '거래후보유수량', '소유수량', '잔고'],
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
]);

export interface D002Extraction {
  readonly reporterName: string | null;
  readonly relationshipRaw: string | null;
  readonly positionRaw: string | null;
  readonly transactions: readonly ParsedInsiderTransaction[];
  readonly warnings: readonly ParserWarning[];
  readonly score: number;
}

export function extractD002(tables: readonly CanonicalTable[]): D002Extraction {
  const warnings: ParserWarning[] = [];
  const transactions: ParsedInsiderTransaction[] = [];
  for (const table of tables) {
    const header = locateHeader<D002Field>(table, HEADERS, ['method', 'quantity']);
    if (!header) continue;
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
      if (!methodRaw && !quantityRaw) continue;
      const quantity = parseInteger(quantityRaw, 'quantity');
      const unitPrice = parseDecimal(cellAt(row, header.columns, 'unitPrice'), 'unitPrice');
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
          rowWarnings.length === 0
            ? classification.confidence
            : Math.min(classification.confidence, 0.75),
        warnings: rowWarnings,
      };
      transactions.push(transaction);
      warnings.push(...rowWarnings);
    }
  }
  const reporterName = findLabelValue(tables, ['보고자', '성명', '보고자성명']);
  const relationshipRaw = findLabelValue(tables, ['발행회사와의관계', '발행회사관계', '관계']);
  const positionRaw = findLabelValue(tables, ['직위', '임원직위']);
  return {
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
