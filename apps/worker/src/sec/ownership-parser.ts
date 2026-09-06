import { createHash } from 'node:crypto';
import { assertLexicalXmlComplexity, assertSafeXml } from '@orsem/opendart-parser';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const SEC_OWNERSHIP_PARSER_VERSION = 'sec-ownership-v1';
export const SEC_OWNERSHIP_MAX_BYTES = 2 * 1024 * 1024;
type XmlObject = Record<string, unknown>;
const object = (value: unknown): XmlObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlObject) : {};
const array = (value: unknown): unknown[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];
function text(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const row = object(value);
  return textScalar(row.value) ?? textScalar(row['#text']);
}
const textScalar = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;
const field = (row: unknown, key: string): string | null => text(object(row)[key]);
const flag = (v: string | null): boolean | null =>
  v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : null;
function footnoteIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.flatMap(footnoteIds))];
  const row = object(value);
  return [
    ...new Set(
      Object.entries(row).flatMap(([key, value]) =>
        key === 'footnoteId'
          ? array(value).flatMap((v) => field(v, '@_id') ?? [])
          : footnoteIds(value),
      ),
    ),
  ];
}
const kinds: Record<string, string> = {
  P: 'OPEN_MARKET_OR_PRIVATE_PURCHASE',
  S: 'OPEN_MARKET_OR_PRIVATE_SALE',
  A: 'AWARD',
  M: 'OPTION_EXERCISE',
  F: 'TAX_OR_EXERCISE_PAYMENT',
  G: 'GIFT',
  J: 'OTHER',
  C: 'CONVERSION',
  D: 'DISPOSITION_TO_ISSUER',
};
export interface OwnershipProvenance {
  accessionNumber: string;
  filingDate: string | null;
  acceptanceDateTime: string | null;
  sourceUrl: string;
  expectedCik: string;
}
export interface OwnershipTransaction {
  rowIndex: number;
  derivative: boolean;
  securityTitle: string | null;
  transactionDate: string | null;
  transactionCode: string | null;
  acquiredDisposedCode: string | null;
  transactionShares: string | null;
  transactionPrice: string | null;
  sharesOwnedAfter: string | null;
  directIndirectOwnership: string | null;
  derivedTransactionKind: string;
  footnoteReferences: string[];
  rawFields: XmlObject;
}
export interface OwnershipObservation {
  parserVersion: string;
  rawSha256: string;
  provenance: OwnershipProvenance;
  documentType: string;
  reportPeriod: string | null;
  amendment: boolean;
  issuer: { cik: string; name: string | null; ticker: string | null };
  reportingOwners: Array<{
    cik: string | null;
    name: string | null;
    isDirector: boolean | null;
    isOfficer: boolean | null;
    isTenPercentOwner: boolean | null;
    isOther: boolean | null;
    officerTitle: string | null;
    rawFields: XmlObject;
  }>;
  transactions: OwnershipTransaction[];
  holdings: Array<{ derivative: boolean; rawFields: XmlObject; footnoteReferences: string[] }>;
  footnotes: Array<{ id: string | null; text: string | null }>;
  unresolvedFootnoteReferences: string[];
}

/** Never coerces XML numeric text into JS numbers. Raw transaction fields remain authoritative. */
export function parseSecOwnership(
  xml: string,
  provenance: OwnershipProvenance,
): OwnershipObservation {
  const started = performance.now();
  if (Buffer.byteLength(xml) > SEC_OWNERSHIP_MAX_BYTES)
    throw new Error('SEC ownership XML size limit');
  assertSafeXml(xml, 'SEC ownership');
  assertLexicalXmlComplexity(xml, undefined, { maxDepth: 32, maxNodes: 30000 });
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed SEC ownership XML');
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  }).parse(xml);
  const doc = object(object(parsed).ownershipDocument);
  const documentType = field(doc, 'documentType')?.trim() ?? '';
  if (!/^[345](?:\/A)?$/.test(documentType))
    throw new Error('Unsupported SEC ownership document type');
  const issuer = object(doc.issuer);
  const cik = field(issuer, 'issuerCik')?.trim().padStart(10, '0') ?? '';
  if (cik !== provenance.expectedCik || !/^\d{10}$/.test(cik) || cik === '0000000000')
    throw new Error('SEC ownership issuer mismatch');
  if (!/^\d{10}-\d{2}-\d{6}$/.test(provenance.accessionNumber))
    throw new Error('Invalid ownership accession');
  const transactions: OwnershipTransaction[] = [];
  const holdings: OwnershipObservation['holdings'] = [];
  for (const [tableName, prefix, derivative] of [
    ['nonDerivativeTable', 'nonDerivative', false],
    ['derivativeTable', 'derivative', true],
  ] as const) {
    const table = object(doc[tableName]);
    for (const value of array(table[`${prefix}Transaction`])) {
      const row = object(value),
        amounts = object(row.transactionAmounts);
      const code = field(row.transactionCoding, 'transactionCode');
      transactions.push({
        rowIndex: transactions.length,
        derivative,
        securityTitle: field(row, 'securityTitle'),
        transactionDate: field(row, 'transactionDate'),
        transactionCode: code,
        acquiredDisposedCode: field(amounts, 'transactionAcquiredDisposedCode'),
        transactionShares: field(amounts, 'transactionShares'),
        transactionPrice: field(amounts, 'transactionPricePerShare'),
        sharesOwnedAfter: field(row.postTransactionAmounts, 'sharesOwnedFollowingTransaction'),
        directIndirectOwnership: field(row.ownershipNature, 'directOrIndirectOwnership'),
        derivedTransactionKind: code ? (kinds[code] ?? 'UNKNOWN') : 'UNKNOWN',
        footnoteReferences: footnoteIds(row),
        rawFields: row,
      });
    }
    for (const value of array(table[`${prefix}Holding`]))
      holdings.push({
        derivative,
        rawFields: object(value),
        footnoteReferences: footnoteIds(value),
      });
  }
  const reportingOwners = array(doc.reportingOwner).map((value) => {
    const row = object(value),
      relationship = object(row.reportingOwnerRelationship);
    return {
      cik: field(row.reportingOwnerId, 'rptOwnerCik'),
      name: field(row.reportingOwnerId, 'rptOwnerName'),
      isDirector: flag(field(relationship, 'isDirector')),
      isOfficer: flag(field(relationship, 'isOfficer')),
      isTenPercentOwner: flag(field(relationship, 'isTenPercentOwner')),
      isOther: flag(field(relationship, 'isOther')),
      officerTitle: field(relationship, 'officerTitle'),
      rawFields: row,
    };
  });
  const footnotes = array(object(doc.footnotes).footnote).map((value) => ({
    id: field(value, '@_id'),
    text: text(value),
  }));
  const ids = new Set(footnotes.map((note) => note.id));
  if (performance.now() - started > 1000)
    throw new Error('SEC ownership parse time budget exceeded');
  return {
    parserVersion: SEC_OWNERSHIP_PARSER_VERSION,
    rawSha256: createHash('sha256').update(xml).digest('hex'),
    provenance,
    documentType,
    amendment: documentType.endsWith('/A'),
    reportPeriod: field(doc, 'periodOfReport'),
    issuer: {
      cik,
      name: field(issuer, 'issuerName'),
      ticker: field(issuer, 'issuerTradingSymbol'),
    },
    reportingOwners,
    transactions,
    holdings,
    footnotes,
    unresolvedFootnoteReferences: [...new Set(footnoteIds(doc).filter((id) => !ids.has(id)))],
  };
}

/** Quarterly data only reconciles SEC observations; it must not emit live notifications. */
export interface SecInsiderQuarterReconciler {
  reconcile(input: {
    year: number;
    quarter: 1 | 2 | 3 | 4;
    datasetSha256: string;
    datasetSourceUrl: string;
    suppressAlerts: true;
  }): Promise<{
    checked: number;
    missingAccessions: readonly string[];
    discrepancies: readonly string[];
  }>;
}
