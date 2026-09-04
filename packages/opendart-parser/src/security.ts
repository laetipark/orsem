import { OpenDartPayloadError } from './errors';

const FORBIDDEN_XML_DECLARATIONS = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

export function assertSafeXml(xml: string, entryName = 'payload'): void {
  if (FORBIDDEN_XML_DECLARATIONS.test(xml)) {
    throw new OpenDartPayloadError(
      `DTD 또는 ENTITY 선언이 포함된 XML은 처리하지 않습니다: ${entryName}`,
      'FORBIDDEN_XML_DECLARATION',
    );
  }
}

export function assertSafeEntryName(entryName: string): void {
  if (entryName.length > 4_096) {
    throw new OpenDartPayloadError(
      'ZIP 엔트리 이름이 4096자를 초과했습니다.',
      'ZIP_ENTRY_NAME_TOO_LONG',
    );
  }
  if (
    !entryName ||
    entryName.includes('\0') ||
    entryName.startsWith('/') ||
    entryName.startsWith('\\') ||
    DRIVE_PREFIX.test(entryName)
  ) {
    throw new OpenDartPayloadError(
      `안전하지 않은 ZIP 엔트리 경로입니다: ${entryName}`,
      'ZIP_PATH_TRAVERSAL',
    );
  }
  const segments = entryName.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new OpenDartPayloadError(
      `상위 경로를 참조하는 ZIP 엔트리입니다: ${entryName}`,
      'ZIP_PATH_TRAVERSAL',
    );
  }
}

export function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}
