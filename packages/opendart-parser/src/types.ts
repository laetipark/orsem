import type { Direction, DisclosureDetailType, TransactionNature } from '@orsem/contracts';

export const OPENDART_PARSER_VERSION = 'opendart-xml-v1';

export interface ArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalUncompressedBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxArchiveBytes: 50 * 1024 * 1024,
  maxEntries: 200,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalUncompressedBytes: 250 * 1024 * 1024,
});

export interface OpenDartXmlCandidate {
  readonly entryName: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly xml: string;
}

export interface OpenDartArchive {
  readonly archiveSha256: string;
  readonly archiveByteLength: number;
  readonly entriesSeen: number;
  readonly totalUncompressedBytes: number;
  readonly xmlCandidates: readonly OpenDartXmlCandidate[];
}

export interface CanonicalCell {
  readonly text: string;
  readonly rowSpan: number;
  readonly colSpan: number;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface CanonicalTable {
  readonly index: number;
  readonly sourceEntryName: string;
  readonly path: readonly string[];
  readonly caption: string | null;
  readonly rows: readonly (readonly string[])[];
  readonly sourceRows: readonly (readonly CanonicalCell[])[];
}

export interface ParserWarning {
  readonly code: string;
  readonly message: string;
  readonly entryName?: string;
  readonly tableIndex?: number;
  readonly rowIndex?: number;
  readonly field?: string;
}

export interface ParseSource {
  readonly archiveSha256: string;
  readonly archiveByteLength: number;
  readonly selectedEntryName: string | null;
  readonly candidateEntries: readonly string[];
}

export interface ParsedInsiderTransaction {
  readonly rowIndex: number;
  readonly eventDate: string | null;
  readonly securityTypeRaw: string;
  readonly methodRaw: string;
  readonly nature: TransactionNature;
  readonly direction: Direction;
  readonly quantity: string | null;
  readonly quantityUnitRaw: string | null;
  readonly unitPrice: string | null;
  readonly amount: string | null;
  readonly amountSource: 'CALCULATED' | null;
  readonly currency: string | null;
  readonly sharesAfter: string | null;
  readonly confidence: number;
  readonly warnings: readonly ParserWarning[];
}

export interface ParsedD002Report {
  readonly detailType: 'D002';
  readonly parserVersion: string;
  readonly source: ParseSource;
  readonly reporterName: string | null;
  readonly relationshipRaw: string | null;
  readonly positionRaw: string | null;
  readonly transactions: readonly ParsedInsiderTransaction[];
  readonly warnings: readonly ParserWarning[];
  readonly tablesScanned: number;
}

export interface ParsedLargeHoldingChange {
  readonly rowIndex: number;
  readonly eventDate: string | null;
  readonly securityTypeRaw: string;
  readonly methodRaw: string;
  readonly direction: Direction;
  readonly quantity: string | null;
  readonly warnings: readonly ParserWarning[];
}

export interface ParsedD001Report {
  readonly detailType: 'D001';
  readonly parserVersion: string;
  readonly source: ParseSource;
  readonly reportTypeRaw: string | null;
  readonly reporterName: string | null;
  readonly reportReasonRaw: string | null;
  readonly sharesAfter: string | null;
  readonly sharesChange: string | null;
  readonly ownershipRateAfter: string | null;
  readonly ownershipRateChange: string | null;
  readonly changes: readonly ParsedLargeHoldingChange[];
  readonly warnings: readonly ParserWarning[];
  readonly tablesScanned: number;
}

export interface ParsedTradePlanItem {
  readonly rowIndex: number;
  readonly plannedStartDate: string | null;
  readonly plannedEndDate: string | null;
  readonly securityTypeRaw: string;
  readonly methodRaw: string;
  readonly nature: TransactionNature;
  readonly direction: Direction;
  readonly quantity: string | null;
  readonly priceMin: string | null;
  readonly priceMax: string | null;
  readonly warnings: readonly ParserWarning[];
}

export interface ParsedD005Report {
  readonly detailType: 'D005';
  readonly parserVersion: string;
  readonly source: ParseSource;
  readonly reporterName: string | null;
  readonly relationshipRaw: string | null;
  readonly positionRaw: string | null;
  readonly planItems: readonly ParsedTradePlanItem[];
  readonly warnings: readonly ParserWarning[];
  readonly tablesScanned: number;
}

export type ParsedOpenDartDisclosure = ParsedD001Report | ParsedD002Report | ParsedD005Report;

export interface ParseDisclosureInput {
  readonly detailType: DisclosureDetailType;
  readonly archive: Uint8Array;
  readonly parserVersion?: string;
  readonly limits?: Partial<ArchiveLimits>;
}

export interface MethodClassification {
  readonly nature: TransactionNature;
  readonly direction: Direction;
  readonly confidence: number;
  readonly warnings: readonly ParserWarning[];
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
