import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as util from 'node:util';
import { createClient } from 'redis';

const executeFile = util.promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_NAMES = new Set(['orsem-api', 'orsem-worker', 'orsem-ollama', 'orsem-discord']);
const READY_TIMEOUT_MS = 180_000;
const API_READY_TIMEOUT_MS = 30_000;
const API_START_GRACE_MS = 60_000;

export class StartupError extends Error {}

export function assertSupportedNode(version) {
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new StartupError('Node.js 24 or newer is required for Orsem startup.');
  }
}

export function childEnvironment(fileEnvironment, inherited, nodeBin, homeDirectory) {
  const environment = { ...inherited, ...fileEnvironment };
  environment.PATH = [
    ...new Set([
      path.dirname(nodeBin),
      ...(environment.PATH || '').split(path.delimiter).filter(Boolean),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]),
  ].join(path.delimiter);
  environment.PM2_HOME = environment.PM2_HOME?.trim() || path.join(homeDirectory, '.pm2');
  environment.ORSEM_NODE_BIN = nodeBin;
  environment.NODE_ENV = 'production';
  return environment;
}

export function ollamaBinaryPath(environment) {
  const dataDirectory = environment.ORSEM_DATA_DIR || '/home/laeti/orsem-data';
  return (
    environment.OLLAMA_BIN ||
    path.join(environment.OLLAMA_ROOT || path.join(dataDirectory, 'ollama'), 'runtime/bin/ollama')
  );
}

export function usesLocalOllama(environment) {
  if (environment.AI_ENABLED?.trim().toLowerCase() !== 'true') return false;
  try {
    const url = new URL(environment.AI_BASE_URL || 'http://127.0.0.1:11434/v1');
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      ['127.0.0.1', 'localhost', '::1'].includes(host) &&
      url.port === '11434'
    );
  } catch {
    return false;
  }
}

export function discordConfigured(environment) {
  return (
    (environment.DISCORD_BOT_TOKEN?.trim().length || 0) >= 20 &&
    Boolean(environment.DISCORD_APPLICATION_ID?.trim()) &&
    Boolean(environment.DISCORD_CHANNEL_ID?.trim()) &&
    (environment.DISCORD_SERVICE_TOKEN?.trim().length || 0) >= 32 &&
    Boolean(environment.DISCORD_ALLOWED_USER_IDS?.split(',').some((value) => value.trim()))
  );
}

export function selectStartupNames(environment, ollamaBinaryPresent) {
  const names = ['orsem-api', 'orsem-worker'];
  if (usesLocalOllama(environment) && ollamaBinaryPresent) names.push('orsem-ollama');
  if (discordConfigured(environment)) names.push('orsem-discord');
  return names;
}

export function parsePm2Processes(stdout) {
  // 처음 시작하는 PM2 데몬은 jlist의 한 줄 JSON 배열 앞에 배너를 출력합니다.
  // jlist에는 비밀 값이 있으므로 수집한 표준 출력과 오류 출력을 오류 메시지에 넣지 않습니다.
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    try {
      const rows = JSON.parse(candidate);
      if (!Array.isArray(rows)) continue;
      return rows.flatMap((row) =>
        row && typeof row.name === 'string'
          ? [
              {
                name: row.name,
                status: row.pm2_env?.status,
                ...(Number.isInteger(row.pid) && row.pid >= 0 ? { pid: row.pid } : {}),
                ...(Number.isFinite(row.pm2_env?.pm_uptime)
                  ? { startedAt: row.pm2_env.pm_uptime }
                  : {}),
              },
            ]
          : [],
      );
    } catch {
      // 마지막 JSON 목록만 사용합니다. PM2 배너 출력은 오류가 아닙니다.
    }
  }
  throw new StartupError('PM2 returned an unreadable process list.');
}

export function startupPlan(requestedNames, processes) {
  const start = [];
  const active = [];
  const deferred = [];
  for (const name of requestedNames) {
    if (!PROCESS_NAMES.has(name)) throw new StartupError('Refusing a non-Orsem process target.');
    const matches = processes.filter((process) => process.name === name);
    if (matches.length === 1 && matches[0].status === 'online') {
      active.push(name);
    } else if (
      matches.length === 0 ||
      (matches.length === 1 &&
        (['stopped', 'errored'].includes(matches[0].status) ||
          (matches[0].status === 'waiting restart' && matches[0].pid === 0)))
    ) {
      start.push(name);
    } else {
      deferred.push(name);
    }
  }
  return { start, active, deferred };
}

export function startArguments(root, names) {
  if (names.length === 0 || names.some((name) => !PROCESS_NAMES.has(name))) {
    throw new StartupError('Refusing an empty or non-Orsem startup target.');
  }
  return [
    'start',
    path.join(root, 'ecosystem.config.cjs'),
    '--only',
    names.join(','),
    '--update-env',
  ];
}

export function pm2Invocation(context, args) {
  return {
    command: context.nodeBin,
    args: [context.pm2Cli, ...args],
    options: {
      cwd: context.root,
      env: context.environment,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    },
  };
}

export async function runPm2(context, args, execute = executeFile) {
  const invocation = pm2Invocation(context, args);
  try {
    const result = await execute(invocation.command, invocation.args, invocation.options);
    return result.stdout;
  } catch {
    throw new StartupError('PM2 command failed; captured output was withheld for safety.');
  }
}

export function dependencyTargets(environment) {
  return [
    ['MySQL', 'DATABASE_URL', ['mysql:'], 3306],
    ['Redis', 'REDIS_URL', ['redis:', 'rediss:'], 6379],
  ].flatMap(([name, key, protocols, defaultPort]) => {
    const value = environment[key]?.trim();
    if (!value) return [];
    try {
      const url = new URL(value);
      const port = Number(url.port || defaultPort);
      if (
        !protocols.includes(url.protocol) ||
        !url.hostname ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
      ) {
        throw new Error();
      }
      return [{ name, host: url.hostname.replace(/^\[|\]$/g, ''), port }];
    } catch {
      throw new StartupError(`${name} connection configuration is invalid.`);
    }
  });
}

function tcpReady(target, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: target.host, port: target.port });
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ready);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function redisReady(url, timeoutMs, clientFactory = createClient) {
  let client;
  let timer;
  try {
    client = clientFactory({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: timeoutMs, reconnectStrategy: false },
    });
    client.on('error', () => {});
    return await Promise.race([
      (async () => {
        await client.connect();
        return (await client.ping()) === 'PONG';
      })(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    try {
      if (client?.isOpen) client.destroy();
    } catch {
      // Never expose server messages or credentials through cleanup errors.
    }
  }
}

export function dependencyProbe(environment) {
  return (target, timeoutMs) =>
    target.name === 'Redis'
      ? redisReady(environment.REDIS_URL, timeoutMs)
      : tcpReady(target, timeoutMs);
}

export async function waitForDependencies(
  targets,
  {
    timeoutMs = READY_TIMEOUT_MS,
    now = () => performance.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    probe = tcpReady,
    singleAttempt = false,
  } = {},
) {
  if (targets.length === 0) return;
  const deadline = now() + timeoutMs;
  let pending = targets;
  do {
    const results = await Promise.all(
      targets.map((target) => probe(target, Math.max(1, Math.min(1_500, deadline - now())))),
    );
    pending = targets.filter((_target, index) => !results[index]);
    if (pending.length === 0) return;
    if (singleAttempt) break;
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(2_000, remaining));
  } while (now() < deadline);
  throw new StartupError(
    singleAttempt
      ? `Recovery deferred; dependencies unavailable: ${pending.map((target) => target.name).join(', ')}.`
      : `Startup readiness timed out: ${pending.map((target) => target.name).join(', ')}.`,
  );
}

export function apiReadyUrl(environment) {
  const configured = environment.PORT?.trim() || '3210';
  const port = Number(configured);
  if (!/^\d+$/u.test(configured) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new StartupError('API port configuration is invalid.');
  // Never use a public origin, arbitrary host, redirect, or credential-bearing URL.
  return `http://127.0.0.1:${port}/api/v1/health/ready`;
}

export async function apiHealth(url, timeoutMs, request = fetch) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'http:' ||
      parsed.hostname !== '127.0.0.1' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/api/v1/health/ready' ||
      parsed.search ||
      parsed.hash
    )
      return 'unavailable';
    const response = await request(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      // A live API deliberately reporting dependency degradation will not benefit from
      // repeated restarts (e.g. Redis MISCONF still answers PING successfully).
      return response.status === 503 ? 'degraded' : 'unavailable';
    }
    const body = await response.json();
    return body?.status === 'ready' &&
      body.database?.ready === true &&
      body.sessions?.ready === true
      ? 'ready'
      : 'degraded';
  } catch {
    return 'unavailable';
  }
}

export async function apiReady(url, timeoutMs, request = fetch) {
  return (await apiHealth(url, timeoutMs, request)) === 'ready';
}

export async function waitForApiReady(
  url,
  {
    timeoutMs = API_READY_TIMEOUT_MS,
    probe = apiHealth,
    now = () => performance.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const deadline = now() + timeoutMs;
  do {
    const state = await probe(url, Math.max(1, Math.min(1_500, Math.ceil(deadline - now()))));
    if (state === true || state === 'ready') return true;
    if (state === 'degraded')
      throw new StartupError(
        'API reports degraded dependencies; recovery deferred without a restart.',
      );
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(1_000, remaining));
  } while (now() < deadline);
  return false;
}

export async function ensureStartup(
  context,
  names,
  {
    recover = false,
    probeDependency = dependencyProbe(context.environment),
    probeApi = apiHealth,
    pm2 = runPm2,
    now = () => performance.now(),
    wallNow = () => Date.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log = console.log,
  } = {},
) {
  if (!names.includes('orsem-api'))
    throw new StartupError('API must be included in Orsem startup.');
  startupPlan(names, []);
  const url = apiReadyUrl(context.environment);
  const targets = dependencyTargets(context.environment);
  const dependencies = (singleAttempt) =>
    waitForDependencies(targets, {
      timeoutMs: singleAttempt ? 1_500 : READY_TIMEOUT_MS,
      singleAttempt,
      probe: probeDependency,
      now,
      pause,
    });
  const health = (timeoutMs = API_READY_TIMEOUT_MS) =>
    waitForApiReady(url, { timeoutMs, probe: probeApi, now, pause });
  // Even jlist may create a PM2 daemon. Do not contact PM2 while dependencies are down.
  await dependencies(recover);
  const processes = parsePm2Processes(await pm2(context, ['jlist']));
  const plan = startupPlan(names, processes);
  if (plan.start.length > 0) {
    await pm2(context, startArguments(context.root, plan.start));
    log(`Started: ${plan.start.join(', ')}`);
  }
  if (plan.start.includes('orsem-api')) {
    if (!(await health())) throw new StartupError('API did not become ready after startup.');
  } else if (plan.active.includes('orsem-api') && !(await health(5_000))) {
    // Recheck identity after health retries to avoid interrupting a concurrent restart.
    const previous = processes.find((process) => process.name === 'orsem-api');
    const current = parsePm2Processes(await pm2(context, ['jlist'])).filter(
      (process) => process.name === 'orsem-api',
    );
    const api = current[0];
    if (
      current.length !== 1 ||
      api.status !== 'online' ||
      !api.pid ||
      api.pid !== previous.pid ||
      api.startedAt !== previous.startedAt ||
      (recover && (!api.startedAt || wallNow() - api.startedAt < API_START_GRACE_MS))
    ) {
      throw new StartupError(
        'API is not ready; recovery deferred while its process is starting or changing.',
      );
    }
    await dependencies(true);
    await pm2(context, ['restart', ...startArguments(context.root, ['orsem-api']).slice(1)]);
    log('Restarted unresponsive orsem-api once.');
    if (!(await health()))
      throw new StartupError('API did not become ready after one recovery attempt.');
  }
  if (plan.deferred.length > 0) {
    throw new StartupError(
      `Startup deferred for transitional processes: ${plan.deferred.join(', ')}.`,
    );
  }
  if (!recover) log('Orsem API readiness confirmed; startup complete.');
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function findPm2Cli(environment) {
  for (const directory of environment.PATH.split(path.delimiter).filter(path.isAbsolute)) {
    const candidate = path.join(directory, 'pm2');
    if (await isExecutable(candidate)) return realpath(candidate);
  }
  throw new StartupError('PM2 CLI is not available on the configured PATH.');
}

export function safeErrorMessage(error) {
  return error instanceof StartupError
    ? error.message
    : 'Orsem startup failed; check configuration and service availability.';
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('Usage: node scripts/start-at-boot.mjs [--check | --recover | --help]');
    console.log('--check selects startup names only; it does not contact PM2 or start services.');
    console.log(
      '--recover checks dependencies once and attempts bounded recovery of Orsem services.',
    );
    return;
  }
  if (args.some((argument) => !['--check', '--recover'].includes(argument)) || args.length > 1)
    throw new StartupError('Unknown startup argument.');
  assertSupportedNode(process.versions.node);
  let fileEnvironment;
  try {
    fileEnvironment = util.parseEnv(await readFile(path.join(repositoryRoot, '.env'), 'utf8'));
  } catch {
    throw new StartupError('The repository .env could not be loaded.');
  }
  const environment = childEnvironment(fileEnvironment, process.env, process.execPath, homedir());
  const names = selectStartupNames(environment, await isExecutable(ollamaBinaryPath(environment)));
  const recover = args.includes('--recover');
  if (!recover) console.log(`Requested Orsem startup: ${names.join(', ')}`);
  if (args.includes('--check')) {
    console.log('Dry run complete; no PM2 or service state was changed.');
    return;
  }
  if (!recover)
    console.log(
      'Waiting up to 180 seconds for configured MySQL TCP and authenticated Redis readiness.',
    );
  const context = {
    root: repositoryRoot,
    nodeBin: process.execPath,
    pm2Cli: await findPm2Cli(environment),
    environment,
  };
  await ensureStartup(context, names, {
    recover,
    log: (message) => console.log(`[${new Date().toISOString()}] ${message}`),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[${new Date().toISOString()}] ${safeErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
