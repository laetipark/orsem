import {
  classifyOpenDartFiling,
  hasParseTypeInvariant,
  OPENDART_CLASSIFIER_VERSION,
} from '@orsem/contracts';
import type { FilingEntity } from '@orsem/database';
import { updateFilingClassification } from '../src/opendart/filing-classification';
import { crosscheckAllowsProjection, parseReuseFingerprint } from '../src/opendart/parse-reuse';

describe('canonical OpenDART document classification', () => {
  it('never treats a missing offline crosscheck as projection approval', () => {
    expect(
      crosscheckAllowsProjection('D002', { status: 'OK', exactReceiptMatches: [] }, 'receipt'),
    ).toBe(false);
    expect(
      crosscheckAllowsProjection(
        'D002',
        { status: 'OK', exactReceiptMatches: [{ rcept_no: 'another' }] },
        'receipt',
      ),
    ).toBe(false);
    for (const status of ['NOT_RUN', 'MISSING', 'NO_CORP_CODE', 'FAILED', undefined]) {
      expect(crosscheckAllowsProjection('D002', { status }, 'receipt')).toBe(false);
    }
    expect(
      crosscheckAllowsProjection(
        'D001',
        { status: 'OK', exactReceiptMatches: [{ rcept_no: 'receipt' }] },
        'receipt',
      ),
    ).toBe(true);
    expect(crosscheckAllowsProjection('D002', { status: 'NOT_APPLICABLE' }, 'receipt')).toBe(false);
    expect(crosscheckAllowsProjection('D005', { status: 'NOT_APPLICABLE' }, 'receipt')).toBe(true);
  });
  it.each([
    ['주식등의대량보유상황보고서(일반)', 'D001'],
    ['[기재정정]주식등의대량보유상황보고서(약식)', 'D001'],
    ['임원ㆍ주요주주특정증권등소유상황보고서', 'D002'],
    ['[첨부정정]임원·주요주주 특정증권등 소유상황보고서', 'D002'],
    ['임원ㆍ주요주주특정증권등거래계획보고서', 'D005'],
    ['[기재정정]임원ㆍ주요주주특정증권등거래계획보고서', 'D005'],
  ])('classifies %s from its title regardless of the list query', (reportName, expected) => {
    const result = classifyOpenDartFiling({ reportName, queryDetailType: 'D005' });
    expect(result.canonicalType).toBe(expected);
    expect(result.titleDetectedType).toBe(expected);
    expect(result.sourceDetailType).toBeNull();
    expect(result.classificationStatus).toBe('CONFIRMED');
    expect(result.classifierVersion).toBe(OPENDART_CLASSIFIER_VERSION);
    expect(result.classificationProvenanceJson.queryDetailType).toBe('D005');
  });

  it.each([
    ['의결권대리행사권유참고서류', 'D003'],
    ['[기재정정]공개매수신고서', 'D004'],
    ['[첨부정정]공개매수신고서', 'D004'],
    ['[기재정정]공개매수설명서', 'D004'],
  ])('selects the dedicated family for %s without selecting D005', (reportName, expected) => {
    expect(classifyOpenDartFiling({ reportName, queryDetailType: 'D005' })).toMatchObject({
      canonicalType: expected,
      classificationStatus: 'CONFIRMED',
    });
  });

  it('keeps unknown titles unknown and explicit source conflicts reviewable', () => {
    expect(
      classifyOpenDartFiling({ reportName: '확인되지 않은 문서', queryDetailType: 'D005' }),
    ).toMatchObject({ canonicalType: null, classificationStatus: 'UNKNOWN' });
    expect(
      classifyOpenDartFiling({
        reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
        sourceDetailType: 'D005',
      }),
    ).toMatchObject({ canonicalType: 'D002', classificationStatus: 'CONFLICT' });
  });

  it('does not overwrite a corrected canonical type with the polling filter or replace a manual override', () => {
    const filing = {
      detailType: 'D005',
      sourceDetailType: null,
      classificationStatus: 'UNKNOWN',
    } as FilingEntity;
    updateFilingClassification(filing, '주식등의대량보유상황보고서(일반)', 'D005');
    expect(filing.detailType).toBe('D001');
    updateFilingClassification(filing, '[기재정정]주식등의대량보유상황보고서(일반)', 'D002');
    expect(filing.detailType).toBe('D001');
    filing.classificationStatus = 'MANUAL_OVERRIDE';
    filing.canonicalType = 'D002';
    updateFilingClassification(filing, '주식등의대량보유상황보고서(일반)', 'D005');
    expect(filing.detailType).toBe('D002');
    expect(filing.classificationStatus).toBe('MANUAL_OVERRIDE');
    expect(filing.titleDetectedType).toBe('D001');
  });

  it('changes the reuse identity with any parser, classifier, normalizer or extractor input', () => {
    const input = {
      rawSha256: 'a'.repeat(64),
      parserVersion: 'parser1',
      normalizerVersion: 'normal1',
      classifierVersion: 'class1',
      extractorType: 'D005',
    };
    const original = parseReuseFingerprint(input);
    expect(parseReuseFingerprint({ ...input })).toBe(original);
    for (const field of Object.keys(input) as Array<keyof typeof input>) {
      expect(parseReuseFingerprint({ ...input, [field]: `${input[field]}2` })).not.toBe(original);
    }
    for (const extractorType of ['D001', 'D002']) {
      expect(parseReuseFingerprint({ ...input, extractorType })).not.toBe(original);
    }
  });

  it('requires the four supported types to agree even for manual overrides', () => {
    const valid = {
      canonicalType: 'D002',
      inputType: 'D002',
      extractorType: 'D002',
      resultType: 'D002',
      classificationStatus: 'CONFIRMED',
    };
    expect(hasParseTypeInvariant(valid)).toBe(true);
    for (const key of ['canonicalType', 'inputType', 'extractorType', 'resultType']) {
      expect(hasParseTypeInvariant({ ...valid, [key]: 'D005' })).toBe(false);
    }
    expect(hasParseTypeInvariant({ ...valid, classificationStatus: 'UNKNOWN' })).toBe(false);
    expect(hasParseTypeInvariant({ ...valid, classificationStatus: 'MANUAL_OVERRIDE' })).toBe(true);
    expect(
      hasParseTypeInvariant({
        canonicalType: 'D004',
        inputType: 'D004',
        extractorType: 'D004',
        resultType: 'D004',
        classificationStatus: 'MANUAL_OVERRIDE',
      }),
    ).toBe(true);
  });
});
