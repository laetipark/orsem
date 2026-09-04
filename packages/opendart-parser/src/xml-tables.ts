import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { OpenDartPayloadError } from './errors';
import { normalizeWhitespace } from './normalizers';
import { assertSafeXml } from './security';
import { deepFreeze, type CanonicalCell, type CanonicalTable, type ParserWarning } from './types';

type OrderedNode = Record<string, unknown>;

const XML_COMPLEXITY_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: 250_000,
  maxTables: 2_000,
  maxRows: 100_000,
  maxSourceCells: 500_000,
  maxExpandedCells: 2_000_000,
  maxColumnsPerTable: 4_096,
  maxCellTextCharacters: 16_384,
  maxSourceTextCharacters: 8 * 1024 * 1024,
  maxExpandedTextCharacters: 32 * 1024 * 1024,
});

export interface CanonicalizationBudget {
  nodes: number;
  tables: number;
  rows: number;
  sourceCells: number;
  expandedCells: number;
  sourceTextCharacters: number;
  expandedTextCharacters: number;
}

export function createCanonicalizationBudget(): CanonicalizationBudget {
  return {
    nodes: 0,
    tables: 0,
    rows: 0,
    sourceCells: 0,
    expandedCells: 0,
    sourceTextCharacters: 0,
    expandedTextCharacters: 0,
  };
}

function complexityError(detail: string): OpenDartPayloadError {
  return new OpenDartPayloadError(
    `XML 표 구조가 안전 처리 한도를 초과했습니다: ${detail}`,
    'XML_COMPLEXITY_LIMIT',
  );
}

export function assertLexicalXmlComplexity(
  xml: string,
  budget?: Pick<CanonicalizationBudget, 'nodes'>,
  limits: Readonly<{ maxDepth: number; maxNodes: number }> = XML_COMPLEXITY_LIMITS,
): void {
  let cursor = 0;
  let depth = 0;
  let nodes = 0;
  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open < 0) break;
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end < 0) return;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      if (end < 0) return;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end < 0) return;
      cursor = end + 2;
      continue;
    }
    let end = open + 1;
    let quote: '"' | "'" | null = null;
    for (; end < xml.length; end += 1) {
      const character = xml[end];
      if (quote) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= xml.length) return;
    const token = xml.slice(open + 1, end).trim();
    if (!token || token.startsWith('!')) {
      cursor = end + 1;
      continue;
    }
    if (token.startsWith('/')) {
      depth = Math.max(0, depth - 1);
    } else {
      nodes += 1;
      if (nodes > limits.maxNodes) {
        throw complexityError(`노드 ${limits.maxNodes}개 초과`);
      }
      if (!token.endsWith('/')) depth += 1;
      if (depth > limits.maxDepth) {
        throw complexityError(`깊이 ${limits.maxDepth}단계 초과`);
      }
    }
    cursor = end + 1;
  }
  if (budget) {
    budget.nodes += nodes;
    if (budget.nodes > limits.maxNodes) {
      throw complexityError(`누적 노드 ${limits.maxNodes}개 초과`);
    }
  }
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
  allowBooleanAttributes: true,
});

function tagKeys(node: OrderedNode): string[] {
  return Object.keys(node).filter((key) => key !== ':@' && key !== '#text' && key !== '#comment');
}

function attributesOf(node: OrderedNode): Record<string, string> {
  const raw = node[':@'];
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key.replace(/^@_/, ''),
      String(value),
    ]),
  );
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  const value = node[tag];
  return Array.isArray(value)
    ? value.filter(
        (child): child is OrderedNode =>
          child !== null && typeof child === 'object' && !Array.isArray(child),
      )
    : [];
}

function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value);
    if (text.length > XML_COMPLEXITY_LIMITS.maxCellTextCharacters) {
      throw complexityError(`셀 텍스트 ${XML_COMPLEXITY_LIMITS.maxCellTextCharacters}자 초과`);
    }
    return text;
  }
  if (Array.isArray(value)) {
    const pieces: string[] = [];
    let length = 0;
    for (const child of value) {
      const piece = textOf(child);
      length += piece.length + (pieces.length > 0 ? 1 : 0);
      if (length > XML_COMPLEXITY_LIMITS.maxCellTextCharacters) {
        throw complexityError(`셀 텍스트 ${XML_COMPLEXITY_LIMITS.maxCellTextCharacters}자 초과`);
      }
      pieces.push(piece);
    }
    return pieces.join(' ');
  }
  if (!value || typeof value !== 'object') return '';
  const node = value as OrderedNode;
  const ownText =
    typeof node['#text'] === 'string' || typeof node['#text'] === 'number'
      ? String(node['#text'])
      : '';
  const childText = tagKeys(node)
    .flatMap((tag) => childrenOf(node, tag))
    .map(textOf)
    .join(' ');
  const result = `${ownText} ${childText}`;
  if (result.length > XML_COMPLEXITY_LIMITS.maxCellTextCharacters) {
    throw complexityError(`셀 텍스트 ${XML_COMPLEXITY_LIMITS.maxCellTextCharacters}자 초과`);
  }
  return result;
}

function collectDescendants(
  nodes: readonly OrderedNode[],
  wanted: ReadonlySet<string>,
  stopAt: ReadonlySet<string> = new Set(),
): OrderedNode[] {
  const found: OrderedNode[] = [];
  const visit = (node: OrderedNode): void => {
    for (const tag of tagKeys(node)) {
      const normalized = tag.toUpperCase();
      if (wanted.has(normalized)) found.push(node);
      if (stopAt.has(normalized) && !wanted.has(normalized)) continue;
      for (const child of childrenOf(node, tag)) visit(child);
    }
  };
  for (const node of nodes) visit(node);
  return found;
}

function assertTreeComplexity(nodes: readonly OrderedNode[]): void {
  const stack = nodes.map((node) => ({ node, depth: 1 }));
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    seen += 1;
    if (seen > XML_COMPLEXITY_LIMITS.maxNodes) {
      throw complexityError(`노드 ${XML_COMPLEXITY_LIMITS.maxNodes}개 초과`);
    }
    if (current.depth > XML_COMPLEXITY_LIMITS.maxDepth) {
      throw complexityError(`깊이 ${XML_COMPLEXITY_LIMITS.maxDepth}단계 초과`);
    }
    for (const tag of tagKeys(current.node)) {
      for (const child of childrenOf(current.node, tag)) {
        stack.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
}

function parseSpan(
  attributes: Readonly<Record<string, string>>,
  name: 'ROWSPAN' | 'COLSPAN',
): number {
  const pair = Object.entries(attributes).find(([key]) => key.toUpperCase() === name);
  const parsed = pair ? Number(pair[1]) : 1;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 256 ? parsed : 1;
}

function extractCells(rowNode: OrderedNode, budget: CanonicalizationBudget): CanonicalCell[] {
  const rowTag = tagKeys(rowNode).find((tag) => tag.toUpperCase() === 'TR');
  if (!rowTag) return [];
  const rowChildren = childrenOf(rowNode, rowTag);
  const cellNodes = collectDescendants(
    rowChildren,
    new Set(['TD', 'TH', 'TE']),
    new Set(['TR', 'TABLE']),
  );
  return cellNodes.map((cellNode) => {
    const tag = tagKeys(cellNode).find((key) => ['TD', 'TH', 'TE'].includes(key.toUpperCase()));
    const attributes = attributesOf(cellNode);
    const text = normalizeWhitespace(tag ? textOf(childrenOf(cellNode, tag)) : '');
    const attributeCharacters = Object.entries(attributes).reduce(
      (total, [key, value]) => total + key.length + value.length,
      0,
    );
    if (attributeCharacters > XML_COMPLEXITY_LIMITS.maxCellTextCharacters) {
      throw complexityError(`셀 속성 ${XML_COMPLEXITY_LIMITS.maxCellTextCharacters}자 초과`);
    }
    budget.sourceTextCharacters += text.length + attributeCharacters;
    if (budget.sourceTextCharacters > XML_COMPLEXITY_LIMITS.maxSourceTextCharacters) {
      throw complexityError(
        `누적 원본 텍스트 ${XML_COMPLEXITY_LIMITS.maxSourceTextCharacters}자 초과`,
      );
    }
    return {
      text,
      rowSpan: parseSpan(attributes, 'ROWSPAN'),
      colSpan: parseSpan(attributes, 'COLSPAN'),
      attributes,
    };
  });
}

function expandSpans(
  sourceRows: readonly (readonly CanonicalCell[])[],
  budget: CanonicalizationBudget,
): string[][] {
  const rows: string[][] = [];
  const carry = new Map<number, { text: string; remaining: number }>();
  let tableWidth = 0;
  for (const sourceRow of sourceRows) {
    const row: string[] = [];
    for (const [column, span] of [...carry.entries()].sort(([left], [right]) => left - right)) {
      row[column] = span.text;
      if (span.remaining <= 1) carry.delete(column);
      else carry.set(column, { ...span, remaining: span.remaining - 1 });
    }
    let column = 0;
    for (const cell of sourceRow) {
      while (row[column] !== undefined) column += 1;
      if (column + cell.colSpan > XML_COMPLEXITY_LIMITS.maxColumnsPerTable) {
        throw complexityError(`표 열 ${XML_COMPLEXITY_LIMITS.maxColumnsPerTable}개 초과`);
      }
      for (let offset = 0; offset < cell.colSpan; offset += 1) {
        const target = column + offset;
        row[target] = cell.text;
        if (cell.rowSpan > 1) {
          carry.set(target, {
            text: cell.text,
            remaining: cell.rowSpan - 1,
          });
        }
      }
      column += cell.colSpan;
    }
    const prospectiveWidth = Math.max(tableWidth, row.length);
    const prospectiveCells = prospectiveWidth * (rows.length + 1);
    if (budget.expandedCells + prospectiveCells > XML_COMPLEXITY_LIMITS.maxExpandedCells) {
      throw complexityError(`확장 셀 ${XML_COMPLEXITY_LIMITS.maxExpandedCells}개 초과`);
    }
    tableWidth = prospectiveWidth;
    const expandedCharacters = row.reduce((total, value) => total + (value?.length ?? 0), 0);
    budget.expandedTextCharacters += expandedCharacters;
    if (budget.expandedTextCharacters > XML_COMPLEXITY_LIMITS.maxExpandedTextCharacters) {
      throw complexityError(
        `누적 확장 텍스트 ${XML_COMPLEXITY_LIMITS.maxExpandedTextCharacters}자 초과`,
      );
    }
    rows.push(row.map((cell) => cell ?? ''));
  }
  const width = tableWidth;
  if (width > XML_COMPLEXITY_LIMITS.maxColumnsPerTable) {
    throw complexityError(`표 열 ${XML_COMPLEXITY_LIMITS.maxColumnsPerTable}개 초과`);
  }
  budget.expandedCells += width * rows.length;
  return rows.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ''));
}

function tableCaption(tableChildren: readonly OrderedNode[]): string | null {
  const captions = collectDescendants(
    tableChildren,
    new Set(['CAPTION', 'TITLE', 'TU']),
    new Set(['TR', 'TABLE']),
  );
  for (const caption of captions) {
    const text = normalizeWhitespace(textOf(caption));
    if (text) return text;
  }
  return null;
}

export interface CanonicalizeResult {
  readonly tables: readonly CanonicalTable[];
  readonly warnings: readonly ParserWarning[];
}

export function canonicalizeXmlTables(
  xml: string,
  sourceEntryName: string,
  sharedBudget?: CanonicalizationBudget,
): CanonicalizeResult {
  const budget = sharedBudget ?? createCanonicalizationBudget();
  assertSafeXml(xml, sourceEntryName);
  // 악의적으로 깊거나 큰 XML로부터 검증기와 파서 자체를 보호합니다.
  assertLexicalXmlComplexity(xml, budget);
  const validation = XMLValidator.validate(xml, {
    allowBooleanAttributes: true,
  });
  if (validation !== true) {
    const detail = validation.err?.msg ?? 'invalid XML';
    throw new OpenDartPayloadError(
      `유효하지 않은 XML입니다 (${sourceEntryName}): ${detail}`,
      'INVALID_XML',
    );
  }
  const parsed = parser.parse(xml) as OrderedNode[];
  assertTreeComplexity(parsed);
  const tables: CanonicalTable[] = [];

  const visit = (nodes: readonly OrderedNode[], path: readonly string[]): void => {
    for (const node of nodes) {
      for (const tag of tagKeys(node)) {
        const children = childrenOf(node, tag);
        const nextPath = [...path, tag];
        if (tag.toUpperCase() === 'TABLE') {
          budget.tables += 1;
          if (budget.tables > XML_COMPLEXITY_LIMITS.maxTables) {
            throw complexityError(`표 ${XML_COMPLEXITY_LIMITS.maxTables}개 초과`);
          }
          const rowNodes = collectDescendants(children, new Set(['TR']), new Set(['TABLE']));
          const sourceRows = rowNodes
            .map((rowNode) => extractCells(rowNode, budget))
            .filter((row) => row.length > 0);
          budget.rows += sourceRows.length;
          budget.sourceCells += sourceRows.reduce((total, row) => total + row.length, 0);
          if (budget.rows > XML_COMPLEXITY_LIMITS.maxRows) {
            throw complexityError(`행 ${XML_COMPLEXITY_LIMITS.maxRows}개 초과`);
          }
          if (budget.sourceCells > XML_COMPLEXITY_LIMITS.maxSourceCells) {
            throw complexityError(`원본 셀 ${XML_COMPLEXITY_LIMITS.maxSourceCells}개 초과`);
          }
          if (sourceRows.length > 0) {
            tables.push({
              index: tables.length,
              sourceEntryName,
              path: nextPath,
              caption: tableCaption(children),
              rows: expandSpans(sourceRows, budget),
              sourceRows,
            });
          }
          // DART 문서는 실제 보고 표를 배치용 표의 셀 안에 넣기도 합니다.
          // 바깥쪽 행 수집은 중첩 TABLE에서 의도적으로 멈추므로,
          // 여기서 안쪽으로 내려가 해당 표를 독립 후보로 한 번 정규화합니다.
          // 이렇게 해야 중첩된 보고 표가 누락되지 않습니다.
          visit(children, nextPath);
          continue;
        }
        visit(children, nextPath);
      }
    }
  };
  visit(parsed, []);
  return deepFreeze({ tables, warnings: [] });
}
