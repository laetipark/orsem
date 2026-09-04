import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpCode,
  generateTotpSecret,
  verifyTotp,
} from './totp';

test('TOTP verifies only the expected time-window code', () => {
  const secret = generateTotpSecret();
  const now = 1_788_393_600_000;
  assert.equal(verifyTotp(secret, generateTotpCode(secret, now), now), true);
  assert.equal(verifyTotp(secret, '000000', now), false);
});

test('TOTP secret encryption round-trips', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const secret = generateTotpSecret();
  assert.equal(decryptTotpSecret(encryptTotpSecret(secret, key), key), secret);
});
