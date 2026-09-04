import { createHash } from 'node:crypto';
import { XMLValidator } from 'fast-xml-parser';
import { OpenDartPayloadError } from './errors';
import type {
  XmlNormalizationAudit,
  XmlRepair,
  XmlRepairCode,
  XmlValidationIssue,
} from './parse-audit';
import { assertSafeXml } from './security';
import { deepFreeze } from './types';
import { assertLexicalXmlComplexity } from './xml-tables';

export const OPENDART_NORMALIZER_VERSION = 'opendart-dialect-v1';

export const XML_NORMALIZATION_LIMITS = Object.freeze({
  maxXmlBytes: 50 * 1024 * 1024,
  maxAttributesPerElement: 128,
  maxRepairs: 2_048,
  maxRepairedByteRatio: 0.05,
  maxLiteralAngleCharacters: 512,
});

// Only these source-dialect prose containers may contain an unescaped <text> label.
const TEXT_ELEMENTS = new Set([
  'TITLE',
  'P',
  'TD',
  'TE',
  'TU',
  'TH',
  'SPAN',
  'COVER-TITLE',
  'IMG-CAPTION',
]);
const DART_ELEMENTS = new Set([
  'DOCUMENT',
  'DOCUMENT-NAME',
  'FORMULA-VERSION',
  'COMPANY-NAME',
  'BODY',
  'COVER',
  'COVER-TITLE',
  'TABLE',
  'COLGROUP',
  'COL',
  'TBODY',
  'TR',
  'TD',
  'P',
  'PGBRK',
  'SECTION-1',
  'SECTION-2',
  'SECTION-3',
  'SECTION-4',
  'SECTION-5',
  'TITLE',
  'TABLE-GROUP',
  'TE',
  'TU',
  'LIBRARY',
  'THEAD',
  'TH',
  'SPAN',
  'IMAGE',
  'IMG',
  'IMG-CAPTION',
  'SUMMARY',
  'EXTRACTION',
  'CORRECTION',
  'BR',
  'B',
  'I',
  'U',
  'SUP',
  'SUB',
]);
// The 19 audited malformed quote variants all use TD@ENG, an English annotation.
// Never guess attribute boundaries in structural values such as ROWSPAN or COLSPAN.
const QUOTE_REPAIR_ATTRIBUTES = new Set(['TD:ENG']);
const XML_NAME = /^[:_\p{L}][:_\p{L}\p{N}.\-\u00b7]*/u;
const ENTITY = /^&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/u;

function validationIssue(xml: string): XmlValidationIssue | null {
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  return validation === true
    ? null
    : {
        code: validation.err.code,
        message: validation.err.msg,
        line: validation.err.line,
        column: validation.err.col,
      };
}

function hash(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex');
}

interface PendingRepair extends XmlRepair {
  readonly replacement: string;
}

/** Create a bounded parsing copy, never changing the archived bytes or making network requests. */
export function normalizeOpenDartXml(
  xml: string,
  candidateName = 'payload',
  candidateSha256?: string,
): { readonly xml: string; readonly audit: XmlNormalizationAudit } {
  const originalBytes = Buffer.byteLength(xml, 'utf8');
  if (originalBytes > XML_NORMALIZATION_LIMITS.maxXmlBytes)
    throw new OpenDartPayloadError(
      'XML 사본이 크기 한도를 초과했습니다.',
      'XML_NORMALIZATION_LIMIT',
    );
  assertSafeXml(xml, candidateName);
  assertLexicalXmlComplexity(xml);
  const originalValidation = validationIssue(xml);
  const originalXmlSha256 = hash(xml);
  const pending: PendingRepair[] = [];
  const repairCounts: Record<XmlRepairCode, number> = {
    BARE_AMPERSAND: 0,
    LITERAL_ANGLE_BRACKET: 0,
    ATTRIBUTE_QUOTE: 0,
  };
  let repairedSourceBytes = 0;
  const lineStarts = [0];
  for (let index = 0; index < xml.length; index += 1) {
    if (xml[index] === '\n') lineStarts.push(index + 1);
  }
  const location = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - lineStarts[low]! + 1 };
  };
  const audit = (
    status: XmlNormalizationAudit['status'],
    normalized: string | null,
    normalizedValidation: XmlValidationIssue | null = null,
  ): XmlNormalizationAudit =>
    deepFreeze({
      candidateName,
      ...(candidateSha256 ? { candidateSha256 } : {}),
      normalizerVersion: OPENDART_NORMALIZER_VERSION,
      originalXmlSha256,
      normalizedXmlSha256: normalized === null ? null : hash(normalized),
      originalBytes,
      normalizedBytes: normalized === null ? null : Buffer.byteLength(normalized, 'utf8'),
      status,
      repairs: pending.map((repair) => ({
        code: repair.code,
        startOffset: repair.startOffset,
        endOffset: repair.endOffset,
        line: repair.line,
        column: repair.column,
        originalBytes: repair.originalBytes,
        replacementBytes: repair.replacementBytes,
      })),
      repairCounts: { ...repairCounts },
      repairedSourceBytes,
      repairedByteRatio: originalBytes === 0 ? 0 : repairedSourceBytes / originalBytes,
      originalValidation,
      normalizedValidation,
    });
  const fail: (message: string, code?: string) => never = (
    message,
    code = 'XML_NORMALIZATION_AMBIGUOUS',
  ) => {
    throw new OpenDartPayloadError(message, code, {
      normalizationAudit: audit('REVIEW_REQUIRED', null),
    });
  };
  const repair = (start: number, replacement: string, code: XmlRepairCode): void => {
    // A strict-valid input must be byte-for-byte unchanged, including unknown dialect entities.
    if (originalValidation === null) fail('유효한 XML을 변경하려는 정규화를 중단했습니다.');
    if (pending.length >= XML_NORMALIZATION_LIMITS.maxRepairs)
      fail('XML 보정 횟수가 한도를 초과했습니다.', 'XML_NORMALIZATION_LIMIT');
    const original = xml[start]!;
    const size = Buffer.byteLength(original, 'utf8');
    repairedSourceBytes += size;
    pending.push({
      code,
      startOffset: start,
      endOffset: start + 1,
      ...location(start),
      originalBytes: size,
      replacementBytes: Buffer.byteLength(replacement, 'utf8'),
      replacement,
    });
    repairCounts[code] += 1;
  };
  const bareAmpersand = (offset: number): void => {
    if (xml[offset] !== '&') return;
    if (ENTITY.test(xml.slice(offset, offset + 64))) return;
    // A named entity requires a declaration. Preserve it on already valid input, otherwise
    // leave unknown entity semantics to review instead of silently interpreting HTML entities.
    if (/^&[A-Za-z_:][\w.:-]*;/u.test(xml.slice(offset, offset + 128))) {
      if (originalValidation) fail('선언되지 않은 이름 엔티티의 의미를 추정하지 않습니다.');
      return;
    }
    if (originalValidation) repair(offset, '&amp;', 'BARE_AMPERSAND');
  };
  const closingNames = new Set<string>();
  for (const match of xml.matchAll(/<\/([:_\p{L}][:_\p{L}\p{N}.\-\u00b7]*)\s*>/gu))
    closingNames.add(match[1]!);
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    if (xml[cursor] === '&') {
      bareAmpersand(cursor);
      cursor += 1;
      continue;
    }
    if (xml[cursor] !== '<') {
      cursor += 1;
      continue;
    }
    if (
      xml.startsWith('<!--', cursor) ||
      xml.startsWith('<![CDATA[', cursor) ||
      xml.startsWith('<?xml', cursor)
    ) {
      const close = xml.startsWith('<!--', cursor)
        ? '-->'
        : xml.startsWith('<![CDATA[', cursor)
          ? ']]>'
          : '?>';
      const end = xml.indexOf(close, cursor + 2);
      if (end < 0) fail('종료되지 않은 XML 주석·CDATA·선언입니다.');
      cursor = end + close.length;
      continue;
    }
    if (xml.startsWith('<!', cursor) || xml.startsWith('<?', cursor))
      fail('허용하지 않는 XML 선언입니다.', 'FORBIDDEN_XML_DECLARATION');
    if (xml.startsWith('</', cursor)) {
      const name = XML_NAME.exec(xml.slice(cursor + 2))?.[0];
      const end = xml.indexOf('>', cursor + 2);
      if (
        !name ||
        end < 0 ||
        xml.slice(cursor + 2 + name.length, end).trim() ||
        stack.pop() !== name
      )
        fail('실제 요소의 닫는 태그가 맞지 않아 XML 구조를 복구하지 않습니다.');
      cursor = end + 1;
      continue;
    }

    const name = XML_NAME.exec(xml.slice(cursor + 1))?.[0];
    const element = name?.toUpperCase() ?? '';
    const tokenEnd = xml.indexOf('>', cursor + 1);
    const inText = TEXT_ELEMENTS.has(stack.at(-1)?.toUpperCase() ?? '');
    if (
      originalValidation &&
      inText &&
      !DART_ELEMENTS.has(element) &&
      (!name || !closingNames.has(name))
    ) {
      const token = tokenEnd < 0 ? '' : xml.slice(cursor + 1, tokenEnd);
      const isLiteral =
        token.length > 0 &&
        token.length <= XML_NORMALIZATION_LIMITS.maxLiteralAngleCharacters &&
        !/[<>\r\n=]/u.test(token) &&
        (/^(?:\s+)?(?:[가-힣]|\d)/u.test(token) ||
          /^\s+[A-Za-z]/u.test(token) ||
          /^(?:I|V|X)+\./u.test(token));
      if (isLiteral) {
        repair(cursor, '&lt;', 'LITERAL_ANGLE_BRACKET');
        for (let offset = cursor + 1; offset < tokenEnd; offset += 1) bareAmpersand(offset);
        repair(tokenEnd, '&gt;', 'LITERAL_ANGLE_BRACKET');
        cursor = tokenEnd + 1;
        continue;
      }
    }
    if (!name) fail('구조인지 본문인지 구분할 수 없는 꺾쇠 표현입니다.');
    let position = cursor + 1 + name.length;
    let attributeCount = 0;
    const attributeNames = new Set<string>();
    let selfClosing = false;
    let closed = false;
    while (position < xml.length) {
      const whitespaceStart = position;
      while (/\s/u.test(xml[position] ?? '') && position < xml.length) position += 1;
      if (xml[position] === '>' || xml.startsWith('/>', position)) {
        selfClosing = xml[position] === '/';
        position += selfClosing ? 2 : 1;
        closed = true;
        break;
      }
      if (position === whitespaceStart) fail('속성 경계를 구분할 공백이 없습니다.');
      const attribute = XML_NAME.exec(xml.slice(position))?.[0];
      if (!attribute || attributeNames.has(attribute)) fail('모호하거나 중복된 XML 속성입니다.');
      attributeNames.add(attribute);
      attributeCount += 1;
      if (attributeCount > XML_NORMALIZATION_LIMITS.maxAttributesPerElement)
        fail('XML 요소의 속성 수가 한도를 초과했습니다.', 'XML_NORMALIZATION_LIMIT');
      position += attribute.length;
      while (/\s/u.test(xml[position] ?? '') && position < xml.length) position += 1;
      if (xml[position] !== '=') fail('값이 없는 XML 속성의 의미는 추정하지 않습니다.');
      position += 1;
      while (/\s/u.test(xml[position] ?? '') && position < xml.length) position += 1;
      const quote = xml[position];
      if (quote !== '"' && quote !== "'") fail('따옴표 없는 속성값은 추정하지 않습니다.');
      position += 1;
      let valueClosed = false;
      while (position < xml.length) {
        const character = xml[position];
        if (character === quote) {
          const rest = xml.slice(position + 1);
          const boundary =
            /^\s*(?:\/?>)/u.test(rest) || /^\s+[:_\p{L}][:_\p{L}\p{N}.\-\u00b7]*\s*=/u.test(rest);
          if (originalValidation === null || boundary) {
            position += 1;
            valueClosed = true;
            break;
          }
          if (
            quote !== '"' ||
            !QUOTE_REPAIR_ATTRIBUTES.has(`${element}:${attribute.toUpperCase()}`)
          )
            fail('알려진 본문 주석 이외의 속성 따옴표는 자동 보정하지 않습니다.');
          repair(position, '&quot;', 'ATTRIBUTE_QUOTE');
        } else if (character === '<') {
          if (!originalValidation) fail('유효한 XML의 속성값 안에 잘못된 꺾쇠가 있습니다.');
          repair(position, '&lt;', 'LITERAL_ANGLE_BRACKET');
        } else if (character === '&') bareAmpersand(position);
        position += 1;
      }
      if (!valueClosed) fail('닫히지 않은 XML 속성값입니다.');
    }
    if (!closed) fail('닫히지 않은 XML 시작 태그입니다.');
    if (!selfClosing) stack.push(name);
    cursor = position;
  }
  if (stack.length > 0) fail('닫히지 않은 실제 XML 요소가 남았습니다.');
  if (
    repairedSourceBytes / Math.max(1, originalBytes) >
    XML_NORMALIZATION_LIMITS.maxRepairedByteRatio
  )
    fail('보정된 원문 바이트 비율이 한도를 초과했습니다.', 'XML_NORMALIZATION_LIMIT');
  if (!originalValidation) return deepFreeze({ xml, audit: audit('UNCHANGED', xml) });
  const pieces: string[] = [];
  let last = 0;
  for (const item of pending) {
    pieces.push(xml.slice(last, item.startOffset), item.replacement);
    last = item.endOffset;
  }
  pieces.push(xml.slice(last));
  const normalized = pieces.join('');
  if (Buffer.byteLength(normalized, 'utf8') > XML_NORMALIZATION_LIMITS.maxXmlBytes)
    fail('정규화 사본이 XML 크기 한도를 초과했습니다.', 'XML_NORMALIZATION_LIMIT');
  assertSafeXml(normalized, candidateName);
  assertLexicalXmlComplexity(normalized);
  const normalizedValidation = validationIssue(normalized);
  if (normalizedValidation)
    throw new OpenDartPayloadError(
      `XML 호환 보정 후에도 엄격한 문법 검증을 통과하지 못했습니다: ${normalizedValidation.message}`,
      'INVALID_XML',
      { normalizationAudit: audit('REVIEW_REQUIRED', normalized, normalizedValidation) },
    );
  return deepFreeze({ xml: normalized, audit: audit('NORMALIZED', normalized) });
}
