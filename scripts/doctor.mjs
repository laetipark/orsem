import { access, constants, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { checkDiskSpace } from './check-disk-space.mjs';
import { checkKakaoConfig } from './check-kakao-config.mjs';
import { checkRedisHealth } from './check-redis-health.mjs';

try {
  process.loadEnvFile(path.resolve('.env'));
} catch {
  // 예시 데이터용 웹 빌드는 로컬 .env 없이도 동작하도록 설계했습니다.
}

const checks = [];
const add = (name, state, detail) => checks.push({ name, state, detail });

const major = Number(process.versions.node.split('.')[0]);
add('Node.js', major >= 24 ? 'OK' : 'FAIL', process.version);

const dataDir = path.resolve(process.env.ORSEM_DATA_DIR || '/home/laeti/orsem-data');
const repository = path.resolve('.');
if (dataDir === repository || dataDir.startsWith(`${repository}${path.sep}`)) {
  add('Data directory', 'FAIL', 'must be outside the repository');
} else {
  try {
    const info = await stat(dataDir);
    await access(dataDir, constants.R_OK | constants.W_OK);
    add('Data directory', info.isDirectory() ? 'OK' : 'FAIL', dataDir);
  } catch {
    add('Data directory', 'WARN', `${dataDir} is not ready`);
  }
}

const diskCheck = await checkDiskSpace(dataDir);
add('Data disk space', diskCheck.state, diskCheck.detail);

async function tcpCheck(name, value, defaultPort) {
  if (!value) {
    add(name, 'WARN', 'not configured');
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    add(name, 'FAIL', 'invalid URL');
    return;
  }
  const port = Number(url.port || defaultPort);
  const state = await new Promise((resolve) => {
    const socket = net.createConnection({ host: url.hostname, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_500, () => done('WARN'));
    socket.once('connect', () => done('OK'));
    socket.once('error', () => done('WARN'));
  });
  add(name, state, `${url.hostname}:${port}`);
}

await tcpCheck('MySQL', process.env.DATABASE_URL, 3306);
const redisCheck = await checkRedisHealth(process.env);
add('Redis', redisCheck.state, redisCheck.detail);

async function aiClassifierCheck() {
  if (process.env.AI_ENABLED?.trim().toLowerCase() !== 'true') {
    add('AI classifier', 'DISABLED', 'AI_ENABLED is false');
    return;
  }
  const baseUrl = process.env.AI_BASE_URL?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!baseUrl || !model) {
    add('AI classifier', 'FAIL', 'AI_BASE_URL and AI_MODEL are required when enabled');
    return;
  }
  try {
    const url = new URL('models', `${baseUrl.replace(/\/?$/, '/')}`);
    const response = await fetch(url, {
      headers: process.env.AI_API_KEY
        ? { Authorization: `Bearer ${process.env.AI_API_KEY}` }
        : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      add('AI classifier', 'FAIL', `${url.origin} returned HTTP ${response.status}`);
      return;
    }
    const payload = await response.json();
    const models = Array.isArray(payload?.data) ? payload.data : [];
    const available = models.some((entry) => entry && entry.id === model);
    add(
      'AI classifier',
      available ? 'OK' : 'FAIL',
      available ? `${model} at ${url.origin}` : `${model} is not installed at ${url.origin}`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'endpoint request failed';
    add('AI classifier', 'FAIL', `${model} unavailable: ${detail}`);
  }
}

await aiClassifierCheck();

const kakaoCheck = checkKakaoConfig(process.env);
add('Kakao login', kakaoCheck.state, kakaoCheck.detail);

const connectorKeys = [
  ['OpenDART', ['OPENDART_API_KEY']],
  ['NAVER news', ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET']],
  ['Alpaca asset identity', ['ALPACA_API_KEY', 'ALPACA_API_SECRET']],
  ['Discord', ['DISCORD_BOT_TOKEN']],
];
for (const [name, keys] of connectorKeys) {
  const configured = keys.every((key) => process.env[key]?.trim());
  add(
    `${name} connector`,
    configured ? 'OK' : 'DISABLED',
    configured
      ? 'credentials present; provider authentication requires a separate runtime check'
      : 'missing credentials',
  );
}
let tossConfigured = Boolean(
  process.env.TOSS_CLIENT_ID?.trim() && process.env.TOSS_CLIENT_SECRET?.trim(),
);
let tossFileInvalid = false;
const tossCredentialsFile = process.env.TOSS_CREDENTIALS_FILE?.trim();
if (tossCredentialsFile && !tossConfigured) {
  try {
    const credentials = JSON.parse(await readFile(tossCredentialsFile, 'utf8'));
    const clientId =
      process.env.TOSS_CLIENT_ID?.trim() ||
      (typeof credentials.clientId === 'string' ? credentials.clientId.trim() : '');
    const clientSecret =
      process.env.TOSS_CLIENT_SECRET?.trim() ||
      (typeof credentials.clientSecret === 'string' ? credentials.clientSecret.trim() : '');
    tossConfigured = Boolean(clientId && clientSecret);
    tossFileInvalid = !tossConfigured;
  } catch {
    tossFileInvalid = true;
  }
}
add(
  'Toss prices connector',
  tossFileInvalid ? 'FAIL' : tossConfigured ? 'OK' : 'DISABLED',
  tossFileInvalid
    ? 'credentials file could not be loaded'
    : tossConfigured
      ? 'credentials configured; live receipt requires a separate runtime check'
      : 'missing credentials',
);
const secUserAgent = process.env.SEC_USER_AGENT?.trim() ?? '';
const secUserAgentDeclared =
  secUserAgent.length <= 255 &&
  /^[A-Za-z0-9][^\r\n]{0,127}\s+[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(secUserAgent);
add(
  'SEC connector',
  secUserAgentDeclared ? 'OK' : 'WARN',
  !secUserAgent
    ? 'missing SEC_USER_AGENT'
    : secUserAgentDeclared
      ? 'declared application identity and contact configured'
      : 'SEC_USER_AGENT must contain an application identity followed by a contact email',
);
for (const check of checks) {
  const marker = check.state.padEnd(8);
  console.log(`${marker} ${check.name}: ${check.detail}`);
}

if (checks.some((check) => check.state === 'FAIL')) process.exitCode = 1;
