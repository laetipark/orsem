import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read the verified bytes from the same descriptor; never expose a raw storage URI. */
export async function readAnalysisArtifact(
  root: string,
  uri: string,
  sha256: string,
): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/u.test(sha256))
    throw new ConflictException('파일 검증 정보를 확인할 수 없습니다.');
  let supplied: string;
  try {
    supplied = uri.startsWith('file://') ? fileURLToPath(uri) : uri;
  } catch {
    throw new ForbiddenException('허용되지 않은 문서 경로입니다.');
  }
  if (!isAbsolute(supplied)) throw new ForbiddenException('허용되지 않은 문서 경로입니다.');
  const [base, target] = await Promise.all([realpath(root), realpath(supplied)]).catch(() => {
    throw new NotFoundException('저장된 파일을 찾을 수 없습니다.');
  });
  const path = relative(base, target);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new ForbiddenException('문서 저장 경로 밖에는 접근할 수 없습니다.');
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new NotFoundException('저장된 파일을 찾을 수 없습니다.');
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
      throw new ForbiddenException('전송할 수 없는 문서 파일입니다.');
    }
    const bytes = await file.readFile();
    if (bytes.length !== stat.size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new ConflictException('문서 파일의 검증 값이 일치하지 않습니다.');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export function safeAnalysisUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function analysisJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function analysisArray(value: unknown): unknown[] {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

/** Defense in depth for provider/worker JSON. Private object locations never cross the API. */
export function publicAnalysisJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicAnalysisJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(?:raw_?uri|raw_?object_?uri|object_?uri|storage_?path|owner_?key|lease_?until|last_?error)$/iu.test(
            key,
          ),
      )
      .map(([key, entry]) => [
        key,
        /(?:url|link)$/iu.test(key) && typeof entry === 'string'
          ? safeAnalysisUrl(entry)
          : publicAnalysisJson(entry),
      ]),
  );
}
