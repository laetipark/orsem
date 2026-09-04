import { createECDH } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface WebPushConfig {
  enabled: boolean;
  publicKey: string | null;
  privateKey: string | null;
  subject: string | null;
}

export function loadWebPushConfig(environment: NodeJS.ProcessEnv = process.env): WebPushConfig {
  const disabled: WebPushConfig = {
    enabled: false,
    publicKey: null,
    privateKey: null,
    subject: null,
  };
  try {
    let file: Record<string, unknown> = {};
    const path = environment.WEB_PUSH_CREDENTIALS_FILE?.trim();
    if (path) {
      if (!isAbsolute(path)) return disabled;
      const actual = realpathSync(path);
      const repoRelative = relative(resolve(__dirname, '../../..'), actual);
      const stat = statSync(actual);
      if (
        !(repoRelative === '..' || repoRelative.startsWith(`..${sep}`)) ||
        !stat.isFile() ||
        stat.size > 8192 ||
        (stat.mode & 0o077) !== 0
      )
        return disabled;
      const parsed: unknown = JSON.parse(readFileSync(actual, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return disabled;
      file = parsed as Record<string, unknown>;
    }
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const publicKey = text(environment.WEB_PUSH_PUBLIC_KEY) || text(file.publicKey);
    const privateKey = text(environment.WEB_PUSH_PRIVATE_KEY) || text(file.privateKey);
    const subject = text(environment.WEB_PUSH_SUBJECT) || text(file.subject);
    if (!/^[A-Za-z0-9_-]{87}$/u.test(publicKey) || !/^[A-Za-z0-9_-]{43}$/u.test(privateKey))
      return disabled;
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== publicKey) return disabled;
    const contact = new URL(subject);
    if (
      !['https:', 'mailto:'].includes(contact.protocol) ||
      contact.username ||
      contact.password ||
      subject.length > 255
    )
      return disabled;
    if (contact.protocol === 'https:' && !contact.hostname) return disabled;
    if (contact.protocol === 'mailto:' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contact.pathname))
      return disabled;
    return { enabled: true, publicKey, privateKey, subject };
  } catch {
    // Optional push configuration never exposes secrets or disables unrelated services.
    return disabled;
  }
}
