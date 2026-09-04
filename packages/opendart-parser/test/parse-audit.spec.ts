import {
  mergeCandidateErrorsWithNormalizationAudits,
  normalizeOpenDartXml,
  type ParseCandidateError,
} from '../src';

const recoveredAudit = (candidate = 'main.xml', sha = 'a'.repeat(64)) =>
  normalizeOpenDartXml(
    `<DOCUMENT><P>${'safe source text '.repeat(20)}A & B</P></DOCUMENT>`,
    candidate,
    sha,
  ).audit;

describe('candidate normalization audit merge', () => {
  it('uses proven prose repairs when the validator mistakes a literal label for attributes', () => {
    const audit = normalizeOpenDartXml(
      `<DOCUMENT><P>${'safe source text '.repeat(20)}<한글 설명 내용></P></DOCUMENT>`,
    ).audit;
    expect(mergeCandidateErrorsWithNormalizationAudits([], [audit])[0]).toMatchObject({
      errorCode: 'XML_NORMALIZED',
      rootCause: 'LITERAL_ANGLE_BRACKET',
      repairCodes: ['LITERAL_ANGLE_BRACKET'],
      originalMessage: audit.originalValidation?.message,
    });
  });

  it('records recovered original failures with their source position and repair evidence once', () => {
    const audit = recoveredAudit();
    const result = mergeCandidateErrorsWithNormalizationAudits([], [audit, audit]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      candidateName: 'main.xml',
      candidateSha256: 'a'.repeat(64),
      errorCode: 'XML_NORMALIZED',
      rootCause: 'BARE_AMPERSAND',
      line: audit.originalValidation?.line,
      column: audit.originalValidation?.column,
      originalMessage: audit.originalValidation?.message,
      repairAttempted: true,
      repairCodes: ['BARE_AMPERSAND'],
      recovered: true,
      normalizationAudit: audit,
    });
    expect(mergeCandidateErrorsWithNormalizationAudits(result, [audit])).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('keeps existing failures first and skips unchanged or unsuccessful normalization audits', () => {
    const audit = recoveredAudit();
    const failure: ParseCandidateError = {
      candidateName: audit.candidateName,
      candidateSha256: audit.candidateSha256,
      errorCode: 'EXTRACTION_FAILED',
      rootCause: 'OTHER_XML',
      originalMessage: 'preserve the existing root cause',
      repairAttempted: false,
      repairCodes: [],
    };
    const existing = Object.freeze([failure]);
    const sameNameDifferentSource = recoveredAudit('main.xml', 'b'.repeat(64));
    const result = mergeCandidateErrorsWithNormalizationAudits(existing, [
      audit,
      { ...recoveredAudit('review.xml'), status: 'REVIEW_REQUIRED' },
      normalizeOpenDartXml('<DOCUMENT/>', 'valid.xml').audit,
      sameNameDifferentSource,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(failure);
    expect(result[1]?.candidateSha256).toBe('b'.repeat(64));
    expect(existing).toEqual([failure]);
    expect(mergeCandidateErrorsWithNormalizationAudits([failure, failure], [])).toEqual([failure]);
  });
});
