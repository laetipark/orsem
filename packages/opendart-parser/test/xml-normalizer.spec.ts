import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { strToU8, zipSync } from 'fflate';
import {
  normalizeOpenDartXml,
  OpenDartPayloadError,
  OPENDART_NORMALIZER_VERSION,
  parseOpenDartDisclosure,
} from '../src';

const prose = (text: string): string =>
  `<DOCUMENT><BODY><P>${'safe text '.repeat(20)}${text}</P></BODY></DOCUMENT>`;

describe('OpenDART XML dialect normalization', () => {
  it('leaves valid XML, entities, CDATA, comments and unknown elements unchanged', () => {
    const xml =
      '<DOCUMENT><P flag="true" other="ok">A &amp; B &#38; &lt;text&gt; &quot;x&quot;<![CDATA[<5 & >]]><!-- a & b --><CUSTOM>value</CUSTOM></P></DOCUMENT>';
    const result = normalizeOpenDartXml(xml, 'valid.xml', 'source-sha');
    expect(result.xml).toBe(xml);
    expect(result.audit).toMatchObject({
      normalizerVersion: OPENDART_NORMALIZER_VERSION,
      status: 'UNCHANGED',
      repairs: [],
      originalValidation: null,
    });
    expect(result.audit.originalXmlSha256).toBe(result.audit.normalizedXmlSha256);
  });

  it('repairs bare ampersands once and preserves existing XML entities', () => {
    const original = prose('A & B &amp; C &#38; D &#x26; E');
    const normalized = normalizeOpenDartXml(original);
    expect(normalized.xml).toContain('A &amp; B &amp; C &#38; D &#x26; E');
    expect(normalized.audit.repairCounts.BARE_AMPERSAND).toBe(1);
    expect(normalizeOpenDartXml(normalized.xml).xml).toBe(normalized.xml);
    expect(original).toContain('A & B');
  });

  it.each([
    '<의결권>',
    '<삭제>',
    '<III. 설명>',
    '<2020.1.29.>',
    '<9th report>',
    '< explanatory text >',
  ])('escapes prose label %s while keeping real table elements', (label) => {
    const result = normalizeOpenDartXml(
      prose(`${label}<TABLE><TR><TD>unchanged</TD></TR></TABLE>`),
    );
    expect(result.xml).toContain(`&lt;${label.slice(1, -1)}&gt;`);
    expect(result.xml).toContain('<TABLE><TR><TD>unchanged</TD></TR></TABLE>');
    expect(XMLValidator.validate(result.xml)).toBe(true);
    expect(normalizeOpenDartXml(result.xml).audit.status).toBe('UNCHANGED');
  });

  it.each([' HEIGHT="10"', ''])(
    'uses lexical boundaries for quotes inside TD@ENG with following attributes %s',
    (following) => {
      const original = `<DOCUMENT><BODY><TABLE><TR><TD WIDTH="100" ENG="A sample "projected revenue" statement.${' annotation'.repeat(20)}"${following}>text</TD></TR></TABLE></BODY></DOCUMENT>`;
      const result = normalizeOpenDartXml(original);
      expect(result.xml).toContain('&quot;projected revenue&quot;');
      expect(result.audit.repairCounts.ATTRIBUTE_QUOTE).toBe(2);
      expect(XMLValidator.validate(result.xml)).toBe(true);
      expect(normalizeOpenDartXml(result.xml).xml).toBe(result.xml);
    },
  );

  it('records positions against original text without retaining source text in repair entries', () => {
    const xml = `<DOCUMENT>\n<P>${'padding '.repeat(20)}A & B</P>\n</DOCUMENT>`;
    const { audit } = normalizeOpenDartXml(xml, 'positions.xml', 'entry-sha');
    expect(audit.repairs).toEqual([
      expect.objectContaining({
        code: 'BARE_AMPERSAND',
        startOffset: xml.indexOf('&'),
        endOffset: xml.indexOf('&') + 1,
        line: 2,
        column: xml.indexOf('&') - xml.indexOf('\n'),
        originalBytes: 1,
        replacementBytes: 5,
      }),
    ]);
    expect(Object.keys(audit.repairs[0]!)).not.toContain('replacement');
    expect(audit.candidateSha256).toBe('entry-sha');
  });

  it.each([
    '<DOCUMENT><P flag>boolean attributes are not XML</P></DOCUMENT>',
    '<DOCUMENT><P>unknown <UnexpectedTag> prose</P></DOCUMENT>',
    '<DOCUMENT><TABLE><TR><TD ROWSPAN="2"broken">text</TD></TR></TABLE></DOCUMENT>',
    '<DOCUMENT><P>< 의도적으로\n여러 줄인 텍스트 ></P></DOCUMENT>',
    '<DOCUMENT><TABLE><TR><TD>unclosed</TR></TABLE></DOCUMENT>',
  ])('keeps ambiguous or broken real structure in review instead of forcing success', (xml) => {
    expect(() => normalizeOpenDartXml(xml)).toThrow(OpenDartPayloadError);
    try {
      normalizeOpenDartXml(xml);
    } catch (error) {
      expect((error as OpenDartPayloadError).normalizationAudit?.status).toBe('REVIEW_REQUIRED');
    }
  });

  it.each([
    '<!DOCTYPE DOCUMENT [<!ENTITY x SYSTEM "https://example.invalid/source">]><DOCUMENT>&x;</DOCUMENT>',
    '<!DOCTYPE DOCUMENT [<!ENTITY x "123"><!ENTITY y "&x;&x;&x;">]><DOCUMENT>&y;</DOCUMENT>',
    '<DOCUMENT xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="https://example.invalid/source"/></DOCUMENT>',
    '<?xml-stylesheet href="https://example.invalid/style"?><DOCUMENT/>',
  ])('rejects external or expanding declarations without resolving anything', (xml) => {
    expect(() => normalizeOpenDartXml(xml)).toThrow(OpenDartPayloadError);
  });

  it('enforces attribute count, repair count and changed-byte ratio limits', () => {
    const attributes = Array.from({ length: 129 }, (_, index) => `a${index}="1"`).join(' ');
    expect(() => normalizeOpenDartXml(`<DOCUMENT ${attributes}/>`)).toThrow(/속성 수/u);
    expect(() => normalizeOpenDartXml(prose('&'.repeat(2049)))).toThrow(/보정 횟수/u);
    expect(() => normalizeOpenDartXml('<DOCUMENT><P>&&&&</P></DOCUMENT>')).toThrow(/바이트 비율/u);
  });

  it('preserves candidate root causes even when another candidate parses successfully', async () => {
    const good = await readFile(path.join(__dirname, 'fixtures/d002.xml'));
    const result = await parseOpenDartDisclosure({
      detailType: 'D002',
      archive: zipSync({
        'good.xml': good,
        'broken.xml': strToU8('<DOCUMENT><TABLE><TR></DOCUMENT>'),
      }),
    });
    expect(result.source.candidateErrors).toEqual([
      expect.objectContaining({
        candidateName: 'broken.xml',
        candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        errorCode: 'XML_NORMALIZATION_AMBIGUOUS',
        rootCause: 'LITERAL_ANGLE_BRACKET',
        line: 1,
        column: expect.any(Number),
        originalMessage: expect.any(String),
        repairAttempted: true,
      }),
    ]);
    expect(result.source.normalizerVersion).toBe(OPENDART_NORMALIZER_VERSION);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'XML_NORMALIZATION_REVIEW_REQUIRED' }),
    );
  });

  it('attaches all candidate causes to NO_PARSEABLE_XML without dropping file hashes', async () => {
    try {
      await parseOpenDartDisclosure({
        detailType: 'D001',
        archive: zipSync({
          'one.xml': strToU8('<DOCUMENT><TABLE><TR></DOCUMENT>'),
          'two.xml': strToU8('<DOCUMENT><P><Unknown>bad</P></DOCUMENT>'),
        }),
      });
      throw new Error('Expected a parse failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenDartPayloadError);
      expect((error as OpenDartPayloadError).code).toBe('NO_PARSEABLE_XML');
      expect((error as OpenDartPayloadError).candidateErrors).toHaveLength(2);
      expect(
        (error as OpenDartPayloadError).candidateErrors.map((item) => item.candidateName),
      ).toEqual(['one.xml', 'two.xml']);
    }
  });
});
