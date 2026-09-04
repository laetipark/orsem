import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpUri(secret: string, email: string): string {
  const issuer = 'Orsem';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function verifyTotp(secret: string, supplied: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(supplied)) return false;
  const counter = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    const expected = hotp(secret, counter + offset);
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length === right.length && timingSafeEqual(left, right)) return true;
  }
  return false;
}

export function generateTotpCode(secret: string, now = Date.now()): string {
  return hotp(secret, Math.floor(now / 30_000));
}

export function encryptTotpSecret(secret: string, configuredKey: string | undefined): string {
  const key = encryptionKey(configuredKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decryptTotpSecret(payload: string, configuredKey: string | undefined): string {
  const parts = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  const [iv, tag, encrypted] = parts;
  if (!iv || !tag || !encrypted) throw new Error('Invalid encrypted TOTP secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(configuredKey), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function encryptionKey(configuredKey: string | undefined): Buffer {
  if (configuredKey) {
    const decoded = Buffer.from(configuredKey, 'base64');
    if (decoded.length === 32) return decoded;
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('TOTP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return createHash('sha256')
    .update(configuredKey ?? 'orsem-fixture-totp-key')
    .digest();
}

function hotp(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function encodeBase32(input: Buffer): string {
  let bits = '';
  for (const value of input) bits += value.toString(2).padStart(8, '0');
  let result = '';
  for (let index = 0; index < bits.length; index += 5) {
    result += BASE32[Number.parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
  }
  return result;
}

function decodeBase32(input: string): Buffer {
  let bits = '';
  for (const character of input.replace(/=+$/u, '').toUpperCase()) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new Error('Invalid base32 secret');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8)
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}
