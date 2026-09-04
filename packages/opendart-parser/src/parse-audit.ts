export type XmlRepairCode = 'BARE_AMPERSAND' | 'LITERAL_ANGLE_BRACKET' | 'ATTRIBUTE_QUOTE';

export type XmlRootCause = XmlRepairCode | 'INVALID_TAG_NAME' | 'OTHER_XML';

export interface XmlValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface XmlRepair {
  readonly code: XmlRepairCode;
  /** UTF-16 offsets in the original decoded XML; end is exclusive. */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
  readonly column: number;
  readonly originalBytes: number;
  readonly replacementBytes: number;
}

export interface XmlNormalizationAudit {
  readonly candidateName: string;
  readonly candidateSha256?: string;
  readonly normalizerVersion: string;
  /** These hashes cover decoded UTF-8 XML; candidateSha256 covers the archived entry bytes. */
  readonly originalXmlSha256: string;
  readonly normalizedXmlSha256: string | null;
  readonly originalBytes: number;
  readonly normalizedBytes: number | null;
  readonly status: 'UNCHANGED' | 'NORMALIZED' | 'REVIEW_REQUIRED';
  readonly repairs: readonly XmlRepair[];
  readonly repairCounts: Readonly<Record<XmlRepairCode, number>>;
  readonly repairedSourceBytes: number;
  readonly repairedByteRatio: number;
  readonly originalValidation: XmlValidationIssue | null;
  readonly normalizedValidation: XmlValidationIssue | null;
}

export interface ParseCandidateError {
  readonly candidateName: string;
  readonly candidateSha256?: string;
  readonly errorCode: string;
  readonly rootCause: XmlRootCause;
  readonly line?: number;
  readonly column?: number;
  readonly originalMessage: string;
  readonly repairAttempted: boolean;
  readonly repairCodes: readonly XmlRepairCode[];
  readonly normalizationAudit?: XmlNormalizationAudit;
  /** The source XML was invalid but its bounded normalization passed strict validation. */
  readonly recovered?: boolean;
}

export function xmlRootCause(message: string): XmlRootCause {
  if (/char '&' is not expected|entity|ampersand/i.test(message)) return 'BARE_AMPERSAND';
  if (/attribute|quote/i.test(message)) return 'ATTRIBUTE_QUOTE';
  if (/invalid name|invalid tag name/i.test(message)) return 'INVALID_TAG_NAME';
  if (/closing tag|angle bracket/i.test(message)) return 'LITERAL_ANGLE_BRACKET';
  return 'OTHER_XML';
}

/** Preserve original candidate failures first, then expose recovered source defects explicitly. */
export function mergeCandidateErrorsWithNormalizationAudits(
  errors: readonly ParseCandidateError[] = [],
  audits: readonly XmlNormalizationAudit[] = [],
): readonly ParseCandidateError[] {
  const key = (item: { candidateName: string; candidateSha256?: string }): string =>
    JSON.stringify([item.candidateName, item.candidateSha256 ?? null]);
  const merged = new Map<string, ParseCandidateError>();
  for (const error of errors) {
    if (!merged.has(key(error))) merged.set(key(error), error);
  }
  for (const audit of audits) {
    const original = audit.originalValidation;
    if (
      merged.has(key(audit)) ||
      audit.status !== 'NORMALIZED' ||
      !original ||
      audit.normalizedValidation !== null ||
      !audit.normalizedXmlSha256
    )
      continue;
    const repairCodes = [...new Set(audit.repairs.map((repair) => repair.code))];
    const reportedRootCause = xmlRootCause(original.message);
    // An unescaped prose label containing spaces can look like an invalid attribute to the
    // strict validator. A recovered candidate's actual repairs disambiguate that diagnosis.
    const rootCause =
      reportedRootCause === 'INVALID_TAG_NAME' ||
      repairCodes.some((code) => code === reportedRootCause)
        ? reportedRootCause
        : (repairCodes[0] ?? reportedRootCause);
    merged.set(
      key(audit),
      Object.freeze({
        candidateName: audit.candidateName,
        ...(audit.candidateSha256 ? { candidateSha256: audit.candidateSha256 } : {}),
        errorCode: 'XML_NORMALIZED',
        rootCause,
        ...(original.line === undefined ? {} : { line: original.line }),
        ...(original.column === undefined ? {} : { column: original.column }),
        originalMessage: original.message,
        repairAttempted: true,
        repairCodes: Object.freeze(repairCodes),
        normalizationAudit: audit,
        recovered: true,
      }),
    );
  }
  return Object.freeze([...merged.values()]);
}
