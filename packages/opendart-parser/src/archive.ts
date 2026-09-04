import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { OpenDartApiError, OpenDartPayloadError, retryPolicyForOpenDartStatus } from './errors';
import { assertSafeEntryName, assertSafeXml, hasZipMagic } from './security';
import {
  DEFAULT_ARCHIVE_LIMITS,
  deepFreeze,
  type ArchiveLimits,
  type OpenDartArchive,
  type OpenDartXmlCandidate,
} from './types';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mergeLimits(overrides?: Partial<ArchiveLimits>): ArchiveLimits {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    const approvedMaximum = DEFAULT_ARCHIVE_LIMITS[name as keyof ArchiveLimits];
    if (!Number.isSafeInteger(value) || value <= 0 || value > approvedMaximum) {
      throw new OpenDartPayloadError(
        `잘못된 아카이브 제한값입니다: ${name} (승인 상한 ${approvedMaximum})`,
        'INVALID_ARCHIVE_LIMIT',
      );
    }
  }
  return limits;
}

function declaredXmlEncoding(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x3c &&
    bytes[1] === 0x00 &&
    bytes[2] === 0x3f &&
    bytes[3] === 0x00
  ) {
    return 'utf-16le';
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x3c &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x3f
  ) {
    return 'utf-16be';
  }
  const asciiDeclaration = Buffer.from(bytes.subarray(0, 512)).toString('latin1');
  return /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(asciiDeclaration)?.[1] ?? null;
}

function normalizeEncodingName(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/_/g, '-');
  const aliases: Readonly<Record<string, string>> = {
    utf8: 'utf-8',
    'utf-8': 'utf-8',
    'utf-16': 'utf-16le',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
    'euc-kr': 'euc-kr',
    cp949: 'cp949',
    'ks-c-5601-1987': 'cp949',
    ksc5601: 'cp949',
  };
  return aliases[key] ?? null;
}

function decodeXml(bytes: Uint8Array, entryName: string): string {
  const declared = declaredXmlEncoding(bytes);
  let xml: string;
  if (declared) {
    const encoding = normalizeEncodingName(declared);
    if (!encoding || !iconv.encodingExists(encoding)) {
      throw new OpenDartPayloadError(
        `지원하지 않는 XML 인코딩(${declared})입니다: ${entryName}`,
        'UNSUPPORTED_XML_ENCODING',
      );
    }
    try {
      xml = iconv.decode(Buffer.from(bytes), encoding);
    } catch {
      throw new OpenDartPayloadError(
        `선언된 인코딩(${declared})으로 XML을 디코딩할 수 없습니다: ${entryName}`,
        'INVALID_XML_ENCODING',
      );
    }
  } else {
    try {
      xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new OpenDartPayloadError(
        `인코딩 선언이 없고 UTF-8로도 디코딩할 수 없습니다: ${entryName}`,
        'INVALID_XML_ENCODING',
      );
    }
  }
  if (xml.includes('\uFFFD')) {
    throw new OpenDartPayloadError(
      `XML 디코딩 중 대체 문자가 발생했습니다: ${entryName}`,
      'INVALID_XML_ENCODING',
    );
  }
  assertSafeXml(xml, entryName);
  return xml.replace(/^\uFEFF/, '');
}

function decodeXmlEntityText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function throwNonZipPayload(
  bytes: Uint8Array,
  operation: 'LIST' | 'DOCUMENT' | 'CORP_CODE' | 'SUMMARY',
): never {
  const payload = decodeXml(bytes, 'OpenDART API response');
  const status = /<status(?:\s[^>]*)?>([\s\S]*?)<\/status>/i.exec(payload)?.[1];
  const message = /<message(?:\s[^>]*)?>([\s\S]*?)<\/message>/i.exec(payload)?.[1];
  if (status) {
    const normalizedStatus = decodeXmlEntityText(status);
    throw new OpenDartApiError(
      normalizedStatus,
      decodeXmlEntityText(message ?? 'OpenDART 오류 응답'),
      retryPolicyForOpenDartStatus(normalizedStatus, operation),
    );
  }
  throw new OpenDartPayloadError('OpenDART 응답이 ZIP도 오류 XML도 아닙니다.', 'UNKNOWN_PAYLOAD');
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, zipFile) => {
        if (error || !zipFile) {
          reject(
            new OpenDartPayloadError(
              `ZIP을 열 수 없습니다: ${error?.message ?? 'unknown error'}`,
              'INVALID_ZIP',
            ),
          );
          return;
        }
        resolve(zipFile);
      },
    );
  });
}

function openEntry(zipFile: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(
          new OpenDartPayloadError(
            `ZIP 엔트리를 읽을 수 없습니다: ${entry.fileName}`,
            'ZIP_ENTRY_READ_FAILED',
          ),
        );
        return;
      }
      resolve(stream);
    });
  });
}

function collectStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    stream.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        settled = true;
        stream.destroy();
        reject(
          new OpenDartPayloadError(
            `ZIP 엔트리가 허용 크기 ${maxBytes}바이트를 초과했습니다.`,
            'ZIP_ENTRY_TOO_LARGE',
          ),
        );
        return;
      }
      chunks.push(buffer);
    });
    stream.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
  });
}

function isDirectory(entry: Entry): boolean {
  return /\/$/.test(entry.fileName);
}

function looksLikeXml(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder('utf-8').decode(bytes.subarray(0, 256));
  return /^\uFEFF?\s*</.test(prefix);
}

function normalizeZipReadError(error: unknown): OpenDartPayloadError {
  if (error instanceof OpenDartPayloadError) return error;
  const message = error instanceof Error ? error.message : 'unknown ZIP error';
  if (/invalid relative path|absolute path|path traversal/i.test(message)) {
    return new OpenDartPayloadError(
      `안전하지 않은 ZIP 경로를 거부했습니다: ${message}`,
      'ZIP_PATH_TRAVERSAL',
    );
  }
  return new OpenDartPayloadError(`ZIP을 읽을 수 없습니다: ${message}`, 'INVALID_ZIP');
}

async function readEntries(
  zipFile: ZipFile,
  limits: ArchiveLimits,
): Promise<{
  entriesSeen: number;
  totalUncompressedBytes: number;
  candidates: OpenDartXmlCandidate[];
}> {
  return new Promise((resolve, reject) => {
    let entriesSeen = 0;
    let totalUncompressedBytes = 0;
    let settled = false;
    const candidates: OpenDartXmlCandidate[] = [];

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      zipFile.close();
      reject(normalizeZipReadError(error));
    };

    zipFile.on('error', fail);
    zipFile.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ entriesSeen, totalUncompressedBytes, candidates });
    });
    zipFile.on('entry', (entry: Entry) => {
      void (async () => {
        entriesSeen += 1;
        if (entriesSeen > limits.maxEntries) {
          throw new OpenDartPayloadError(
            `ZIP 엔트리 수가 ${limits.maxEntries}개를 초과했습니다.`,
            'ZIP_TOO_MANY_ENTRIES',
          );
        }
        assertSafeEntryName(entry.fileName);
        if (isDirectory(entry)) {
          zipFile.readEntry();
          return;
        }
        if (entry.uncompressedSize > limits.maxEntryBytes) {
          throw new OpenDartPayloadError(
            `ZIP 엔트리가 허용 크기를 초과했습니다: ${entry.fileName}`,
            'ZIP_ENTRY_TOO_LARGE',
          );
        }
        if (totalUncompressedBytes + entry.uncompressedSize > limits.maxTotalUncompressedBytes) {
          throw new OpenDartPayloadError(
            'ZIP 전체 압축해제 크기가 제한을 초과했습니다.',
            'ZIP_TOTAL_TOO_LARGE',
          );
        }
        const stream = await openEntry(zipFile, entry);
        const content = await collectStream(stream, limits.maxEntryBytes);
        totalUncompressedBytes += content.byteLength;
        if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
          throw new OpenDartPayloadError(
            'ZIP 전체 압축해제 크기가 제한을 초과했습니다.',
            'ZIP_TOTAL_TOO_LARGE',
          );
        }
        if (/\.zip$/i.test(entry.fileName) || hasZipMagic(content)) {
          throw new OpenDartPayloadError(
            `중첩 ZIP은 처리하지 않습니다: ${entry.fileName}`,
            'NESTED_ZIP',
          );
        }
        if (/\.xml$/i.test(entry.fileName) || looksLikeXml(content)) {
          const xml = decodeXml(content, entry.fileName);
          candidates.push({
            entryName: entry.fileName,
            byteLength: content.byteLength,
            sha256: sha256(content),
            xml,
          });
        }
        zipFile.readEntry();
      })().catch(fail);
    });

    zipFile.readEntry();
  });
}

export async function readOpenDartArchive(
  input: Uint8Array,
  options?: {
    readonly limits?: Partial<ArchiveLimits>;
    readonly operation?: 'LIST' | 'DOCUMENT' | 'CORP_CODE' | 'SUMMARY';
  },
): Promise<OpenDartArchive> {
  const limits = mergeLimits(options?.limits);
  if (input.byteLength === 0) {
    throw new OpenDartPayloadError('빈 OpenDART 응답입니다.', 'EMPTY_PAYLOAD');
  }
  if (input.byteLength > limits.maxArchiveBytes) {
    throw new OpenDartPayloadError(
      `아카이브가 허용 크기 ${limits.maxArchiveBytes}바이트를 초과했습니다.`,
      'ARCHIVE_TOO_LARGE',
    );
  }
  if (!hasZipMagic(input)) {
    throwNonZipPayload(input, options?.operation ?? 'DOCUMENT');
  }
  const stableBuffer = Buffer.from(input);
  const zipFile = await openZip(stableBuffer);
  const result = await readEntries(zipFile, limits);
  if (result.candidates.length === 0) {
    throw new OpenDartPayloadError('아카이브에 XML 후보가 없습니다.', 'XML_CANDIDATE_NOT_FOUND');
  }
  return deepFreeze({
    archiveSha256: sha256(stableBuffer),
    archiveByteLength: stableBuffer.byteLength,
    entriesSeen: result.entriesSeen,
    totalUncompressedBytes: result.totalUncompressedBytes,
    xmlCandidates: result.candidates.sort((left, right) =>
      left.entryName.localeCompare(right.entryName, 'ko'),
    ),
  });
}
