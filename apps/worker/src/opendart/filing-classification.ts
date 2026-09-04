import { classifyOpenDartFiling, isSupportedFilingType } from '@orsem/contracts';
import type { FilingEntity } from '@orsem/database';

/** Preserves manual classification and never copies a polling filter into canonicalType. */
export function updateFilingClassification(
  filing: FilingEntity,
  reportName: string,
  queryDetailType?: string,
): FilingEntity {
  const priorProvenance = filing.classificationProvenanceJson;
  const manual = filing.classificationStatus === 'MANUAL_OVERRIDE';
  const classification = classifyOpenDartFiling({
    reportName,
    sourceDetailType: filing.sourceDetailType,
    queryDetailType,
    manualCanonicalType: manual ? filing.canonicalType : null,
  });
  Object.assign(filing, classification);
  if (manual && priorProvenance) {
    filing.classificationProvenanceJson = {
      ...priorProvenance,
      ...classification.classificationProvenanceJson,
    };
  }
  if (
    isSupportedFilingType(classification.canonicalType) &&
    ['CONFIRMED', 'MANUAL_OVERRIDE'].includes(classification.classificationStatus)
  ) {
    filing.detailType = classification.canonicalType;
  }
  return filing;
}

export function canProcessFiling(filing: FilingEntity): boolean {
  return (
    isSupportedFilingType(filing.canonicalType) &&
    ['CONFIRMED', 'MANUAL_OVERRIDE'].includes(filing.classificationStatus)
  );
}
