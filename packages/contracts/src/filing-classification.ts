import type { DisclosureDetailType } from './enums';

export const OPENDART_CLASSIFIER_VERSION = 'opendart-title-v1';
export type FilingClassificationStatus =
  'CONFIRMED' | 'UNKNOWN' | 'UNSUPPORTED' | 'MANUAL_OVERRIDE' | 'CONFLICT';

export interface FilingClassification {
  readonly sourceDetailType: string | null;
  readonly titleDetectedType: string | null;
  readonly canonicalType: string | null;
  readonly classificationStatus: FilingClassificationStatus;
  readonly classifierVersion: string;
  readonly classificationProvenanceJson: Record<string, unknown>;
}

export function isSupportedFilingType(
  value: string | null | undefined,
): value is DisclosureDetailType {
  return value === 'D001' || value === 'D002' || value === 'D005';
}

/** Query filters are observations, never evidence of a filing's canonical type. */
export function classifyOpenDartFiling(input: {
  readonly reportName: string;
  readonly sourceDetailType?: string | null;
  readonly queryDetailType?: string | null;
  readonly manualCanonicalType?: string | null;
}): FilingClassification {
  const normalized = input.reportName.normalize('NFKC').replace(/[\s·ㆍ\u119e.]/gu, '');
  // These document families follow the official DS001 list guide, including corrections.
  const detected = [
    ['D001', '주식등의대량보유상황보고서'],
    ['D002', '임원주요주주특정증권등소유상황보고서'],
    ['D003', '의결권대리행사권유'],
    ['D004', '공개매수'],
    ['D005', '임원주요주주특정증권등거래계획보고서'],
  ]
    .filter(([, title]) => normalized.includes(title!))
    .map(([type]) => type!);
  const titleDetectedType = detected.length === 1 ? detected[0]! : null;
  const sourceDetailType = input.sourceDetailType?.trim() || null;
  const sourceKnown =
    sourceDetailType && /^D00[1-5]$/u.test(sourceDetailType) ? sourceDetailType : null;
  const manual = input.manualCanonicalType?.trim() || null;
  const canonicalType = manual ?? titleDetectedType ?? sourceKnown;
  const classificationStatus: FilingClassificationStatus = manual
    ? 'MANUAL_OVERRIDE'
    : detected.length > 1 || (titleDetectedType && sourceKnown && titleDetectedType !== sourceKnown)
      ? 'CONFLICT'
      : !canonicalType
        ? 'UNKNOWN'
        : !isSupportedFilingType(canonicalType)
          ? 'UNSUPPORTED'
          : 'CONFIRMED';
  return {
    sourceDetailType,
    titleDetectedType,
    canonicalType,
    classificationStatus,
    classifierVersion: OPENDART_CLASSIFIER_VERSION,
    classificationProvenanceJson: {
      reportName: input.reportName,
      normalizedTitle: normalized,
      matchedTypes: detected,
      sourceDetailType,
      queryDetailType: input.queryDetailType ?? null,
      manualCanonicalType: manual,
      queryTypeUsedAsCanonical: false,
    },
  };
}

export function hasParseTypeInvariant(input: {
  readonly canonicalType: string | null | undefined;
  readonly classificationStatus: string | null | undefined;
  readonly inputType: string | null | undefined;
  readonly extractorType: string | null | undefined;
  readonly resultType: string | null | undefined;
}): boolean {
  return (
    (input.classificationStatus === 'CONFIRMED' ||
      input.classificationStatus === 'MANUAL_OVERRIDE') &&
    isSupportedFilingType(input.canonicalType) &&
    input.canonicalType === input.inputType &&
    input.canonicalType === input.extractorType &&
    input.canonicalType === input.resultType
  );
}
