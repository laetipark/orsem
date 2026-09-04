import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from '../src/config/worker-config';
import { RawDocumentStore } from '../src/raw-documents/raw-document.store';

describe('RawDocumentStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'orsem-raw-test-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('installs content-addressed bytes once and verifies duplicates', async () => {
    const store = new RawDocumentStore(loadWorkerConfig({ RAW_DOCUMENT_DIR: directory }));
    const bytes = new TextEncoder().encode('PK\u0003\u0004fixture');
    const first = await store.put(bytes);
    const duplicate = await store.put(bytes);
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      sha256: first.sha256,
      objectUri: first.objectUri,
    });
    expect(await readFile(fileURLToPath(first.objectUri))).toEqual(Buffer.from(bytes));
  });
});
