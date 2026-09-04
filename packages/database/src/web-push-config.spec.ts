import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadWebPushConfig } from './web-push-config';

function keys() {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    privateKey: pair.getPrivateKey().toString('base64url'),
    subject: 'https://orsem.example.com',
  };
}

test('Web Push accepts a matching VAPID pair and rejects incomplete or mismatched keys', () => {
  const valid = keys();
  const environment = {
    WEB_PUSH_PUBLIC_KEY: valid.publicKey,
    WEB_PUSH_PRIVATE_KEY: valid.privateKey,
    WEB_PUSH_SUBJECT: valid.subject,
  };
  assert.equal(loadWebPushConfig(environment).enabled, true);
  assert.equal(loadWebPushConfig({}).enabled, false);
  assert.equal(loadWebPushConfig({ ...environment, WEB_PUSH_PRIVATE_KEY: '' }).enabled, false);
  assert.equal(
    loadWebPushConfig({ ...environment, WEB_PUSH_PRIVATE_KEY: keys().privateKey }).enabled,
    false,
  );
  for (const subject of [
    'http://orsem.example.com',
    'https://user:secret@example.com',
    'mailto:invalid',
  ]) {
    assert.equal(loadWebPushConfig({ ...environment, WEB_PUSH_SUBJECT: subject }).enabled, false);
  }
  assert.equal(
    loadWebPushConfig({ ...environment, WEB_PUSH_SUBJECT: 'mailto:operator@example.com' }).enabled,
    true,
  );
});

test('credential files must be private, valid and outside the repository after resolving symlinks', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'orsem-push-config-'));
  // Exercise the old "startsWith(..)" boundary with a synthetic test file only.
  const inside = mkdtempSync(resolve(__dirname, '../../../..push-config-test-'));
  try {
    const valid = keys();
    const path = join(temporary, 'keys.json');
    const localPath = join(inside, 'keys.json');
    writeFileSync(path, JSON.stringify(valid), { mode: 0o600 });
    writeFileSync(localPath, JSON.stringify(valid), { mode: 0o600 });
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: path }).enabled, true);
    chmodSync(path, 0o640);
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: path }).enabled, false);
    chmodSync(path, 0o600);
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: localPath }).enabled, false);
    const link = join(temporary, 'link.json');
    symlinkSync(localPath, link);
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: link }).enabled, false);
    writeFileSync(path, '{broken json');
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: path }).enabled, false);
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: temporary }).enabled, false);
    assert.equal(loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: 'relative.json' }).enabled, false);
    assert.equal(
      loadWebPushConfig({ WEB_PUSH_CREDENTIALS_FILE: join(temporary, 'missing') }).enabled,
      false,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(inside, { recursive: true, force: true });
  }
});
