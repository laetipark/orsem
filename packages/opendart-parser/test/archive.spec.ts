import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import iconv from 'iconv-lite';
import {
  DEFAULT_ARCHIVE_LIMITS,
  MAX_ZIP_COMPRESSION_RATIO,
  OpenDartApiError,
  OpenDartPayloadError,
  readOpenDartArchive,
} from '../src';

const fixture = (name: string) => readFile(path.join(__dirname, 'fixtures', name));

describe('readOpenDartArchive', () => {
  it('rejects highly compressed XML before inflation but allows the same stored XML', async () => {
    const xml = strToU8(`<x>${'a'.repeat(100_000)}</x>`);
    expect(MAX_ZIP_COMPRESSION_RATIO).toBe(200);
    await expect(readOpenDartArchive(zipSync({ 'repeated.xml': xml }))).rejects.toMatchObject({
      code: 'ZIP_COMPRESSION_RATIO_LIMIT',
    });
    const stored = await readOpenDartArchive(zipSync({ 'repeated.xml': [xml, { level: 0 }] }));
    expect(stored.xmlCandidates[0]?.byteLength).toBe(xml.byteLength);
  });
  it('locks the approved archive safety envelope', () => {
    expect(DEFAULT_ARCHIVE_LIMITS).toEqual({
      maxArchiveBytes: 50 * 1024 * 1024,
      maxEntries: 200,
      maxEntryBytes: 50 * 1024 * 1024,
      maxTotalUncompressedBytes: 250 * 1024 * 1024,
    });
  });
  it('allows tighter caller limits but never a larger safety envelope', async () => {
    const archive = zipSync({ 'main.xml': strToU8('<x />') });
    await expect(
      readOpenDartArchive(archive, {
        limits: {
          maxArchiveBytes: DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes + 1,
        },
      }),
    ).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'INVALID_ARCHIVE_LIMIT',
    });
  });
  it('reads every XML candidate and returns immutable metadata', async () => {
    const archive = zipSync({
      'main.xml': strToU8('<DOCUMENT><BODY /></DOCUMENT>'),
      'attachment.xml': strToU8('<DOCUMENT><BODY><P>첨부</P></BODY></DOCUMENT>'),
    });
    const parsed = await readOpenDartArchive(archive);
    expect(parsed.xmlCandidates.map((item) => item.entryName)).toEqual([
      'attachment.xml',
      'main.xml',
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.xmlCandidates)).toBe(true);
  });

  it('maps an error XML response to an explicit retry policy', async () => {
    const payload = await fixture('error-020.xml');
    await expect(readOpenDartArchive(payload)).rejects.toMatchObject<Partial<OpenDartApiError>>({
      status: '020',
      retryPolicy: 'NEXT_KST_DAY',
    });
  });

  it('rejects traversal and nested archives', async () => {
    const traversal = zipSync({ '../escape.xml': strToU8('<x />') });
    await expect(readOpenDartArchive(traversal)).rejects.toMatchObject<
      Partial<OpenDartPayloadError>
    >({ code: 'ZIP_PATH_TRAVERSAL' });
    const nested = zipSync({ 'nested.zip': zipSync({ 'x.xml': strToU8('<x />') }) });
    await expect(readOpenDartArchive(nested)).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'NESTED_ZIP',
    });
    const longName = zipSync({
      [`${'a'.repeat(4_097)}.xml`]: strToU8('<x />'),
    });
    await expect(readOpenDartArchive(longName)).rejects.toMatchObject<
      Partial<OpenDartPayloadError>
    >({ code: 'ZIP_ENTRY_NAME_TOO_LONG' });
  });

  it('rejects DTD/entity declarations', async () => {
    const archive = zipSync({
      'unsafe.xml': strToU8(
        '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>',
      ),
    });
    await expect(readOpenDartArchive(archive)).rejects.toMatchObject<Partial<OpenDartPayloadError>>(
      { code: 'FORBIDDEN_XML_DECLARATION' },
    );
  });

  it('honors a declared CP949 encoding without guessing', async () => {
    const xml = '<?xml version="1.0" encoding="CP949"?><x>한글</x>';
    const archive = zipSync({ 'legacy.xml': iconv.encode(xml, 'cp949') });
    const parsed = await readOpenDartArchive(archive);
    expect(parsed.xmlCandidates[0]?.xml).toContain('한글');
  });

  it('honors a declared EUC-KR encoding without guessing', async () => {
    const xml = '<?xml version="1.0" encoding="EUC-KR"?><x>공시원문</x>';
    const archive = zipSync({ 'legacy-euc.xml': iconv.encode(xml, 'euc-kr') });
    const parsed = await readOpenDartArchive(archive);
    expect(parsed.xmlCandidates[0]?.xml).toContain('공시원문');
  });

  it('rejects unsupported declared encodings instead of silently guessing', async () => {
    const archive = zipSync({
      'unknown.xml': strToU8('<?xml version="1.0" encoding="x-user-defined"?><x>value</x>'),
    });
    await expect(readOpenDartArchive(archive)).rejects.toMatchObject<Partial<OpenDartPayloadError>>(
      { code: 'UNSUPPORTED_XML_ENCODING' },
    );
  });

  it('enforces entry and total limits while streaming', async () => {
    const archive = zipSync({ 'large.xml': strToU8(`<x>${'a'.repeat(256)}</x>`) });
    await expect(
      readOpenDartArchive(archive, { limits: { maxEntryBytes: 64 } }),
    ).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'ZIP_ENTRY_TOO_LARGE',
    });

    const twoEntries = zipSync({
      'one.xml': strToU8(`<x>${'a'.repeat(32)}</x>`),
      'two.xml': strToU8(`<x>${'b'.repeat(32)}</x>`),
    });
    await expect(
      readOpenDartArchive(twoEntries, { limits: { maxEntries: 1 } }),
    ).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'ZIP_TOO_MANY_ENTRIES',
    });
    await expect(
      readOpenDartArchive(twoEntries, {
        limits: { maxTotalUncompressedBytes: 50 },
      }),
    ).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'ZIP_TOTAL_TOO_LARGE',
    });
    await expect(
      readOpenDartArchive(twoEntries, {
        limits: { maxArchiveBytes: twoEntries.byteLength - 1 },
      }),
    ).rejects.toMatchObject<Partial<OpenDartPayloadError>>({
      code: 'ARCHIVE_TOO_LARGE',
    });
  });
});
