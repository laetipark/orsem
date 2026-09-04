import { createECDH } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadWebPushConfig } = require('../packages/database/dist/web-push-config.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outsideRepository = (path) => {
  const fromRoot = relative(root, path);
  return fromRoot === '..' || fromRoot.startsWith(`..${sep}`);
};
const envPath = resolve(root, '.env');
const environment = { ...parseEnv(readFileSync(envPath, 'utf8')), ...process.env };
const destination =
  environment.WEB_PUSH_CREDENTIALS_FILE?.trim() ||
  resolve(homedir(), '.config/orsem/credentials/web-push.json');

try {
  if (!isAbsolute(destination) || !outsideRepository(destination))
    throw new Error('Credentials must be outside the repository.');
  if (environment.WEB_PUSH_PUBLIC_KEY?.trim() || environment.WEB_PUSH_PRIVATE_KEY?.trim())
    throw new Error('Direct Web Push keys are already configured; existing keys were preserved.');
  const subject = environment.WEB_PUSH_SUBJECT?.trim() || new URL(environment.WEB_ORIGIN).origin;
  if (!subject.startsWith('https://') && !subject.startsWith('mailto:'))
    throw new Error('WEB_PUSH_SUBJECT needs an HTTPS service URL or mailto contact.');
  let created = false;
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (!outsideRepository(realpathSync(dirname(destination))))
      throw new Error('Credentials directory resolves inside the repository.');
    const pair = createECDH('prime256v1');
    pair.generateKeys();
    const keys = {
      publicKey: pair.getPublicKey().toString('base64url'),
      privateKey: pair.getPrivateKey().toString('base64url'),
      subject,
    };
    writeFileSync(destination, `${JSON.stringify(keys, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    });
    created = true;
  }
  const config = loadWebPushConfig({
    WEB_PUSH_CREDENTIALS_FILE: destination,
    WEB_PUSH_SUBJECT: subject,
  });
  if (!config.enabled)
    throw new Error(
      'Existing credentials are invalid or file permissions are not private; nothing was overwritten.',
    );
  console.log(
    JSON.stringify({
      created,
      credentialsFile: destination,
      mode: (statSync(destination).mode & 0o777).toString(8),
      configured: true,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Web Push setup failed.');
  process.exitCode = 1;
}
