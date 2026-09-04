import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';

export interface StoredRawDocument {
  readonly sha256: string;
  readonly byteSize: string;
  readonly objectUri: string;
  readonly created: boolean;
}

@Injectable()
export class RawDocumentStore {
  public constructor(@Inject(WORKER_CONFIG) private readonly config: WorkerConfig) {}

  public async put(bytes: Uint8Array): Promise<StoredRawDocument> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const root = path.resolve(this.config.rawDocumentDir);
    const directory = path.join(root, sha256.slice(0, 2));
    const target = path.join(directory, `${sha256}.zip`);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error('Resolved raw document path escaped its configured root.');
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await cleanupStaleTempFiles(directory);
    const temporary = path.join(directory, `.${sha256}.tmp-${process.pid}-${randomUUID()}`);
    let created = false;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await link(temporary, target);
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await assertExistingObject(target, sha256, bytes.byteLength);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    return Object.freeze({
      sha256,
      byteSize: String(bytes.byteLength),
      objectUri: `file://${target}`,
      created,
    });
  }
}

async function assertExistingObject(
  target: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const targetStat = await stat(target);
  if (!targetStat.isFile() || targetStat.size !== expectedSize) {
    throw new Error('Existing raw object does not match expected byte size.');
  }
  const actualSha256 = await hashFile(target);
  if (actualSha256 !== expectedSha256) {
    throw new Error('Existing raw object does not match expected SHA-256.');
  }
}

function hashFile(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function cleanupStaleTempFiles(directory: string): Promise<void> {
  const now = Date.now();
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && /^\.[a-f0-9]{64}\.tmp-/.test(entry.name))
    .slice(0, 32);
  for (const candidate of candidates) {
    const target = path.join(directory, candidate.name);
    const metadata = await stat(target).catch(() => null);
    if (metadata && now - metadata.mtimeMs > 24 * 60 * 60 * 1000) {
      await unlink(target).catch(() => undefined);
    }
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'EEXIST'
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
