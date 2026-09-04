import {
  multiplyIntegerAndDecimal,
  parseDecimal,
  parseInteger,
  normalizeHeader,
} from '../normalizers';
import { parseUnitPrice } from './unit-price';
import type {
  CanonicalTable,
  DisclosureDocumentContext,
  FieldProvenanceMap,
  ParsedD004Report,
  ParsedTenderOfferSecurity,
  ParserWarning,
} from '../types';
import {
  disclosureBodyTables,
  fieldProvenance,
  summaryProvenance,
  type LocatedValue,
} from './shared';
import { dateTokens, documentProvenance, requiredFieldsWarning } from './narrative-shared';

type D004Facts = Omit<
  ParsedD004Report,
  'detailType' | 'parserVersion' | 'source' | 'tablesScanned'
>;
export interface D004Extraction extends D004Facts {
  readonly score: number;
}

function kindOf(name: string | null): ParsedD004Report['documentKind'] {
  const title = name?.replace(/\s/g, '') ?? '';
  if (/공개매수결과보고서/u.test(title)) return 'RESULT';
  if (/공개매수설명서/u.test(title)) return 'EXPLANATION';
  if (/공개매수신고서/u.test(title)) return 'REPORT';
  return 'OTHER';
}

// Use the last source cell only inside the uniquely identified tender summary. Parent
// rowspan labels (current / expected holdings) remain part of the field identity.
function summaryField(
  table: CanonicalTable | undefined,
  label: string,
  parent?: RegExp,
): LocatedValue | null {
  if (!table) return null;
  for (let row = 0; row < table.rows.length; row += 1) {
    const values = table.rows[row]!;
    if (!values.some((value) => normalizeHeader(value) === normalizeHeader(label))) continue;
    if (parent && !parent.test(values.map(normalizeHeader).join(' '))) continue;
    let column = values.length - 1;
    while (column >= 0 && !values[column]?.trim()) column -= 1;
    if (column < 0) continue;
    const value = values[column]?.trim() ?? '';
    if (!value || normalizeHeader(value) === normalizeHeader(label)) continue;
    return {
      value,
      provenance: fieldProvenance(table, row, column, [...new Set(values.slice(0, -1))]),
    };
  }
  return null;
}

function quantities(
  value: LocatedValue | null,
  field: string,
  warnings: ParserWarning[],
): { min: string | null; max: string | null } {
  if (!value) return { min: null, max: null };
  const raw = value.value.replace(/\s/g, '');
  const minimum = /최소[:：]?([\d,]+)주/u.exec(raw);
  const maximum = /최대[:：]?([\d,]+)주/u.exec(raw);
  const one = /^([\d,]+)주(?:\([^)]*%\))?$/u.exec(raw);
  const min = parseInteger(minimum?.[1] ?? one?.[1] ?? '', field).value;
  const max = parseInteger(maximum?.[1] ?? one?.[1] ?? '', field).value;
  if (min === null || max === null || BigInt(min) > BigInt(max))
    warnings.push({
      code: 'INVALID_TENDER_QUANTITY_RANGE',
      message: '공개매수 수량 범위를 확정할 수 없습니다.',
      field,
      tableIndex: value.provenance.tableIndex,
      rowIndex: value.provenance.rowIndex,
    });
  return { min, max };
}

function headerColumn(table: CanonicalTable, label: string): number {
  return (
    table.rows[0]?.findIndex((value) => normalizeHeader(value) === normalizeHeader(label)) ?? -1
  );
}

function exactResultTable(
  tables: readonly CanonicalTable[],
  labels: readonly string[],
): CanonicalTable | null {
  const found = tables.filter((table) => labels.every((label) => headerColumn(table, label) >= 0));
  return found.length === 1 ? found[0]! : null;
}

function sourceInteger(
  table: CanonicalTable,
  row: number,
  label: string,
  warnings: ParserWarning[],
): string | null {
  const column = headerColumn(table, label);
  const parsed = parseInteger(column < 0 ? '' : (table.rows[row]?.[column] ?? ''), label);
  if (parsed.warning) warnings.push({ ...parsed.warning, tableIndex: table.index, rowIndex: row });
  return parsed.value;
}

function extractD004Result(
  tables: readonly CanonicalTable[],
  context: DisclosureDocumentContext,
): D004Extraction {
  const warnings: ParserWarning[] = [];
  const terms = exactResultTable(tables, ['주식등의 종류', '매수가격', '매수예정수량', '결제수단']);
  const results = exactResultTable(tables, [
    '주식등의 종류',
    '예정주식 수',
    '응모주식 수',
    '매수주식 수',
  ]);
  const offeror = summaryField(
    tables.find((table) => table.path.some((tag) => tag.toUpperCase() === 'COVER')),
    '보고자',
  );
  const offerorName = /성\s*명\s*[:：]\s*(.+)$/u.exec(offeror?.value ?? '')?.[1]?.trim() ?? null;
  const targetCompanyName = context.companyName;
  const securities: ParsedTenderOfferSecurity[] = [];
  if (terms && results && terms.rows.length === 2 && results.rows.length === 2) {
    const termsTypeColumn = headerColumn(terms, '주식등의 종류');
    const resultsTypeColumn = headerColumn(results, '주식등의 종류');
    const termsType = terms.rows[1]?.[termsTypeColumn]?.trim() ?? '';
    const resultsType = results.rows[1]?.[resultsTypeColumn]?.trim() ?? '';
    if (termsType && termsType === resultsType) {
      const priceColumn = headerColumn(terms, '매수가격');
      const price = parseUnitPrice((terms.rows[1]?.[priceColumn] ?? '').replace(/^주당\s*/u, ''));
      if (price.warning) warnings.push({ ...price.warning, tableIndex: terms.index, rowIndex: 1 });
      const maxQuantity = sourceInteger(terms, 1, '매수예정수량', warnings);
      const offeredQuantity = sourceInteger(results, 1, '응모주식 수', warnings);
      const acquiredQuantity = sourceInteger(results, 1, '매수주식 수', warnings);
      const actualAmount =
        acquiredQuantity && price.value
          ? multiplyIntegerAndDecimal(acquiredQuantity, price.value)
          : null;
      if (acquiredQuantity !== null && price.value !== null && actualAmount === null)
        warnings.push({
          code: 'NUMERIC_OUT_OF_RANGE',
          message: '실제 공개매수 금액을 안전한 범위에서 계산할 수 없습니다.',
          field: 'actualAmount',
          tableIndex: results.index,
          rowIndex: 1,
        });
      const provenance: FieldProvenanceMap = {
        securityTypeRaw: fieldProvenance(results, 1, resultsTypeColumn, ['주식등의 종류']),
        unitPrice: fieldProvenance(terms, 1, priceColumn, ['매수가격']),
        maxQuantity: fieldProvenance(terms, 1, headerColumn(terms, '매수예정수량'), [
          '매수예정수량',
        ]),
        offeredQuantity: fieldProvenance(results, 1, headerColumn(results, '응모주식 수'), [
          '응모주식 수',
        ]),
        acquiredQuantity: fieldProvenance(results, 1, headerColumn(results, '매수주식 수'), [
          '매수주식 수',
        ]),
      };
      securities.push({
        rowIndex: 1,
        securityTypeRaw: resultsType,
        unitPrice: price.value,
        currency:
          price.unitRaw && /^(원|천원|백만원|억원|krw)$/iu.test(price.unitRaw)
            ? 'KRW'
            : price.unitRaw && /^(달러|usd)$/iu.test(price.unitRaw)
              ? 'USD'
              : null,
        minQuantity: null,
        maxQuantity,
        heldQuantity: null,
        expectedHoldingsMin: null,
        expectedHoldingsMax: null,
        offeredQuantity,
        acquiredQuantity,
        actualAmount,
        provenance,
      });
    }
  }
  if (!securities.length)
    warnings.push({
      code: 'UNVERIFIED_TENDER_RESULT_TEMPLATE',
      message: '검증된 공개매수 결과표 구조와 일치하지 않아 실제 수량을 추출하지 않았습니다.',
      field: 'securities',
    });
  requiredFieldsWarning({ offerorName, targetCompanyName }, warnings);
  return {
    documentKind: 'RESULT',
    offerorName,
    targetCompanyName,
    purposeRaw: null,
    conditionsRaw: null,
    subscriptionStartDate: null,
    subscriptionEndDate: null,
    settlementDate: null,
    securities,
    confidence: warnings.length ? 0.5 : 0.95,
    provenance: {
      ...(offeror ? { offerorName: offeror.provenance } : {}),
      ...(targetCompanyName
        ? { targetCompanyName: documentProvenance(context, 'COMPANY-NAME', targetCompanyName) }
        : {}),
      ...(context.documentName
        ? { documentKind: documentProvenance(context, 'DOCUMENT-NAME', context.documentName) }
        : {}),
    },
    warnings,
    score: terms && results ? 100 + securities.length : 0,
  };
}

export function extractD004(
  tables: readonly CanonicalTable[],
  context: DisclosureDocumentContext,
): D004Extraction {
  tables = disclosureBodyTables(tables);
  const warnings: ParserWarning[] = [];
  const documentKind = kindOf(context.documentName);
  if (documentKind === 'RESULT') return extractD004Result(tables, context);
  const summaries = tables.filter((table) => {
    const labels = table.rows.flat().map(normalizeHeader);
    return (
      labels.includes('공개매수대상회사명') &&
      labels.includes('공개매수목적') &&
      labels.includes('공개매수기간')
    );
  });
  const summary = summaries.length === 1 ? summaries[0] : undefined;
  if (summaries.length > 1)
    warnings.push({
      code: 'AMBIGUOUS_DISCLOSURE_SUMMARY',
      message: '공개매수 요약표가 여러 개여서 하나를 선택하지 않았습니다.',
    });
  if (documentKind === 'OTHER')
    warnings.push({
      code: 'UNRECOGNIZED_TENDER_DOCUMENT_KIND',
      message: '공개매수 문서 단계를 확정할 수 없습니다.',
      field: 'documentKind',
    });
  const located = {
    offerorName: summaryField(summary, '공개매수자'),
    targetCompanyName: summaryField(summary, '공개매수 대상회사명'),
    purposeRaw: summaryField(summary, '공개매수 목적'),
    conditionsRaw: summaryField(summary, '공개매수조건'),
    subscriptionPeriod: summaryField(summary, '공개매수기간'),
    securityTypeRaw: summaryField(summary, '주식등의 종류'),
    quantityRange: summaryField(summary, '매수 예정 수량(비율)'),
    unitPrice: summaryField(summary, '매수 가격'),
    heldQuantity: summaryField(summary, '보유 수량', /신고서제출일현재/u),
    expectedHoldings: summaryField(summary, '보유 수량', /공개매수후/u),
  };
  const rawOfferor = located.offerorName?.value ?? '';
  const named = /성명\s*[:：]\s*([^□■]+)/u.exec(rawOfferor)?.[1]?.trim();
  const offerorName = named ?? (rawOfferor && !/[□■:：]/u.test(rawOfferor) ? rawOfferor : null);
  const targetCompanyName = located.targetCompanyName?.value ?? null;
  const purposeRaw = located.purposeRaw?.value ?? null;
  const conditionsRaw = located.conditionsRaw?.value ?? null;
  const period = located.subscriptionPeriod?.value ?? '';
  const dates = dateTokens(period.replace(/\([^)]*결제일[^)]*\)/gu, ''));
  const subscriptionStartDate = dates.length === 2 ? dates[0]! : null;
  const subscriptionEndDate = dates.length === 2 ? dates[1]! : null;
  const settlement = /결제일\s*[:：]?\s*([^)]*)/u.exec(period)?.[1] ?? '';
  const settlementDates = dateTokens(settlement);
  const settlementDate = settlementDates.length === 1 ? settlementDates[0]! : null;
  if (
    (subscriptionStartDate && subscriptionEndDate && subscriptionStartDate > subscriptionEndDate) ||
    (settlementDate && subscriptionEndDate && settlementDate < subscriptionEndDate)
  )
    warnings.push({
      code: 'INVALID_DATE_RANGE',
      message: '공개매수 기간 또는 결제일 순서를 확인해야 합니다.',
      field: 'subscriptionEndDate',
    });
  const securities: ParsedTenderOfferSecurity[] = [];
  if (summary && located.securityTypeRaw) {
    const range = quantities(located.quantityRange, 'quantityRange', warnings);
    const expected = quantities(located.expectedHoldings, 'expectedHoldings', warnings);
    const price = parseDecimal(
      (located.unitPrice?.value ?? '').replace(/^주당\s*/u, ''),
      'unitPrice',
    );
    const held = parseInteger(located.heldQuantity?.value ?? '', 'heldQuantity');
    if (price.warning) warnings.push(price.warning);
    if (held.warning) warnings.push(held.warning);
    const unitPrice = price.value !== null && !price.value.startsWith('-') ? price.value : null;
    const currency =
      price.unitRaw && /^(원|천원|백만원|억원|krw)$/iu.test(price.unitRaw)
        ? 'KRW'
        : price.unitRaw && /^(달러|usd)$/iu.test(price.unitRaw)
          ? 'USD'
          : null;
    const provenance: FieldProvenanceMap = {
      ...summaryProvenance(located),
      ...(located.quantityRange
        ? {
            minQuantity: located.quantityRange.provenance,
            maxQuantity: located.quantityRange.provenance,
          }
        : {}),
      ...(located.expectedHoldings
        ? {
            expectedHoldingsMin: located.expectedHoldings.provenance,
            expectedHoldingsMax: located.expectedHoldings.provenance,
          }
        : {}),
    };
    securities.push({
      rowIndex: located.securityTypeRaw.provenance.rowIndex,
      securityTypeRaw: located.securityTypeRaw.value,
      unitPrice,
      currency,
      minQuantity: range.min,
      maxQuantity: range.max,
      heldQuantity: held.value,
      expectedHoldingsMin: expected.min,
      expectedHoldingsMax: expected.max,
      offeredQuantity: null,
      acquiredQuantity: null,
      actualAmount: null,
      provenance,
    });
    requiredFieldsWarning({ unitPrice, minQuantity: range.min, maxQuantity: range.max }, warnings);
  }
  // Result figures are deliberately not inferred from planned quantities. Until the
  // result layout is verified against real source material, it always stays reviewable.
  requiredFieldsWarning(
    { offerorName, targetCompanyName, subscriptionStartDate, subscriptionEndDate },
    warnings,
  );
  if (!securities.length)
    warnings.push({
      code: 'MISSING_TENDER_SECURITIES',
      message: '검증된 공개매수 대상 증권 행이 없습니다.',
      field: 'securities',
    });
  return {
    documentKind,
    offerorName,
    targetCompanyName,
    purposeRaw,
    conditionsRaw,
    subscriptionStartDate,
    subscriptionEndDate,
    settlementDate,
    securities,
    confidence: warnings.length ? 0.5 : 0.95,
    provenance: {
      ...summaryProvenance(located),
      ...(context.documentName
        ? { documentKind: documentProvenance(context, 'DOCUMENT-NAME', context.documentName) }
        : {}),
      ...(located.subscriptionPeriod
        ? {
            subscriptionStartDate: located.subscriptionPeriod.provenance,
            subscriptionEndDate: located.subscriptionPeriod.provenance,
            settlementDate: located.subscriptionPeriod.provenance,
          }
        : {}),
    },
    warnings,
    score: summary ? 100 + securities.length : 0,
  };
}
