import { createHash } from 'node:crypto';
import { hasParseTypeInvariant } from '@orsem/contracts';
import type { FilingEntity, ParseRunEntity } from '@orsem/database';
import { OpenDartPayloadError } from '@orsem/opendart-parser';

export function crosscheckAllowsProjection(
  detailType: string,
  crosscheck: Record<string, unknown>,
  rceptNo: string,
): boolean {
  if (detailType === 'D005') return crosscheck['status'] === 'NOT_APPLICABLE';
  return (
    crosscheck['status'] === 'OK' &&
    Array.isArray(crosscheck['exactReceiptMatches']) &&
    crosscheck['exactReceiptMatches'].some(
      (row) => row && typeof row === 'object' && row['rcept_no'] === rceptNo,
    )
  );
}

export interface ParseReuseFingerprint {
  readonly rawSha256: string;
  readonly parserVersion: string;
  readonly normalizerVersion: string;
  readonly classifierVersion: string;
  readonly extractorType: string;
}

export function parseReuseFingerprint(input: ParseReuseFingerprint): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.rawSha256,
        input.parserVersion,
        input.normalizerVersion,
        input.classifierVersion,
        input.extractorType,
      ]),
    )
    .digest('hex');
}

export function assertParseTypeInvariant(
  filing: Pick<FilingEntity, 'canonicalType' | 'classificationStatus'>,
  run: Pick<ParseRunEntity, 'inputType' | 'extractorType' | 'resultType'>,
  resultType: string | null | undefined = run.resultType,
): void {
  if (run.resultType !== resultType || !hasParseTypeInvariant({ ...filing, ...run, resultType })) {
    throw new OpenDartPayloadError(
      'Canonical filing, parse input, extractor and result types must agree before projection or notification.',
      'FILING_TYPE_INVARIANT',
    );
  }
}
