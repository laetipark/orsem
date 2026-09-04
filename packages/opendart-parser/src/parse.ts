import { readOpenDartArchive } from './archive';
import { OpenDartPayloadError } from './errors';
import { extractD001, type D001Extraction } from './extractors/d001';
import { extractD002, type D002Extraction } from './extractors/d002';
import { extractD005, type D005Extraction } from './extractors/d005';
import {
  deepFreeze,
  OPENDART_PARSER_VERSION,
  type CanonicalTable,
  type ParseDisclosureInput,
  type ParsedOpenDartDisclosure,
  type ParserWarning,
} from './types';
import { canonicalizeXmlTables, createCanonicalizationBudget } from './xml-tables';

interface CandidateExtraction<T> {
  readonly entryName: string;
  readonly tables: readonly CanonicalTable[];
  readonly extraction: T & { readonly score: number };
  readonly warnings: readonly ParserWarning[];
}

async function extractCandidates<T extends { readonly score: number }>(
  input: ParseDisclosureInput,
  extractor: (tables: readonly CanonicalTable[]) => T,
): Promise<{
  readonly archive: Awaited<ReturnType<typeof readOpenDartArchive>>;
  readonly selected: CandidateExtraction<T>;
  readonly aggregateWarnings: readonly ParserWarning[];
}> {
  const archive = await readOpenDartArchive(input.archive, {
    limits: input.limits,
    operation: 'DOCUMENT',
  });
  let selected: CandidateExtraction<T> | null = null;
  const aggregateWarnings: ParserWarning[] = [];
  // 압축 파일 전체에 하나의 한도를 적용해, 개별적으로 유효한 XML이 많더라도
  // 병합 셀을 펼친 표가 메모리 보관량과 CPU 사용량을 무제한 늘리지 못하게 합니다.
  const canonicalizationBudget = createCanonicalizationBudget();
  for (const candidate of archive.xmlCandidates) {
    try {
      const canonical = canonicalizeXmlTables(
        candidate.xml,
        candidate.entryName,
        canonicalizationBudget,
      );
      const extraction = extractor(canonical.tables);
      if (extraction.score === 0) {
        aggregateWarnings.push({
          code: 'NO_RECOGNIZED_DISCLOSURE_TABLE',
          message: '지원하는 표 헤더나 요약 필드를 찾지 못했습니다.',
          entryName: candidate.entryName,
        });
      }
      const candidateExtraction: CandidateExtraction<T> = {
        entryName: candidate.entryName,
        tables: canonical.tables,
        extraction,
        warnings: canonical.warnings,
      };
      if (
        selected === null ||
        extraction.score > selected.extraction.score ||
        (extraction.score === selected.extraction.score &&
          candidate.entryName.localeCompare(selected.entryName, 'ko') < 0)
      ) {
        selected = candidateExtraction;
      }
    } catch (error) {
      if (
        error instanceof OpenDartPayloadError &&
        (error.code === 'FORBIDDEN_XML_DECLARATION' || error.code === 'XML_COMPLEXITY_LIMIT')
      ) {
        throw error;
      }
      aggregateWarnings.push({
        code: 'XML_CANDIDATE_REJECTED',
        message: error instanceof Error ? error.message : 'XML 후보 파싱 실패',
        entryName: candidate.entryName,
      });
    }
  }
  if (!selected) {
    throw new OpenDartPayloadError('해석 가능한 XML 후보가 없습니다.', 'NO_PARSEABLE_XML');
  }
  return {
    archive,
    selected,
    aggregateWarnings,
  };
}

function sourceFor(
  archive: Awaited<ReturnType<typeof readOpenDartArchive>>,
  selectedEntryName: string,
) {
  return {
    archiveSha256: archive.archiveSha256,
    archiveByteLength: archive.archiveByteLength,
    selectedEntryName,
    candidateEntries: archive.xmlCandidates.map((candidate) => candidate.entryName),
  } as const;
}

export async function parseOpenDartDisclosure(
  input: ParseDisclosureInput,
): Promise<ParsedOpenDartDisclosure> {
  const parserVersion = input.parserVersion ?? OPENDART_PARSER_VERSION;
  if (input.detailType === 'D001') {
    const { archive, selected, aggregateWarnings } = await extractCandidates<D001Extraction>(
      input,
      extractD001,
    );
    const warnings = [...aggregateWarnings, ...selected.warnings, ...selected.extraction.warnings];
    return deepFreeze({
      detailType: 'D001',
      parserVersion,
      source: sourceFor(archive, selected.entryName),
      reportTypeRaw: selected.extraction.reportTypeRaw,
      reporterName: selected.extraction.reporterName,
      reportReasonRaw: selected.extraction.reportReasonRaw,
      sharesAfter: selected.extraction.sharesAfter,
      sharesChange: selected.extraction.sharesChange,
      ownershipRateAfter: selected.extraction.ownershipRateAfter,
      ownershipRateChange: selected.extraction.ownershipRateChange,
      changes: selected.extraction.changes,
      warnings,
      tablesScanned: selected.tables.length,
    });
  }
  if (input.detailType === 'D002') {
    const { archive, selected, aggregateWarnings } = await extractCandidates<D002Extraction>(
      input,
      extractD002,
    );
    const warnings = [...aggregateWarnings, ...selected.warnings, ...selected.extraction.warnings];
    return deepFreeze({
      detailType: 'D002',
      parserVersion,
      source: sourceFor(archive, selected.entryName),
      reporterName: selected.extraction.reporterName,
      relationshipRaw: selected.extraction.relationshipRaw,
      positionRaw: selected.extraction.positionRaw,
      transactions: selected.extraction.transactions,
      warnings,
      tablesScanned: selected.tables.length,
    });
  }
  if (input.detailType === 'D005') {
    const { archive, selected, aggregateWarnings } = await extractCandidates<D005Extraction>(
      input,
      extractD005,
    );
    const warnings = [...aggregateWarnings, ...selected.warnings, ...selected.extraction.warnings];
    return deepFreeze({
      detailType: 'D005',
      parserVersion,
      source: sourceFor(archive, selected.entryName),
      reporterName: selected.extraction.reporterName,
      relationshipRaw: selected.extraction.relationshipRaw,
      positionRaw: selected.extraction.positionRaw,
      planItems: selected.extraction.planItems,
      warnings,
      tablesScanned: selected.tables.length,
    });
  }
  throw new OpenDartPayloadError(
    `지원하지 않는 OpenDART 상세유형입니다: ${String(input.detailType)}`,
    'UNSUPPORTED_DETAIL_TYPE',
  );
}
