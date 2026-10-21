import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  StartupError,
  apiHealth,
  apiReady,
  apiReadyUrl,
  assertSupportedNode,
  childEnvironment,
  dependencyTargets,
  discordConfigured,
  ensureStartup,
  ollamaBinaryPath,
  parsePm2Processes,
  pm2Invocation,
  redisReady,
  runPm2,
  safeErrorMessage,
  selectStartupNames,
  startArguments,
  startupPlan,
  usesLocalOllama,
  waitForDependencies,
} from './start-at-boot.mjs';

const nodeBin = '/home/test/.nvm/versions/node/v24.14.1/bin/node';
const discord = {
  DISCORD_BOT_TOKEN: 't'.repeat(20),
  DISCORD_APPLICATION_ID: 'application',
  DISCORD_CHANNEL_ID: 'channel',
  DISCORD_SERVICE_TOKEN: 's'.repeat(32),
  DISCORD_ALLOWED_USER_IDS: '123,456',
};

test('requires Node 24 and leaves inherited environment untouched', () => {
  assert.throws(() => assertSupportedNode('20.17.0'), /Node.js 24/);
  assert.throws(() => assertSupportedNode('invalid'), /Node.js 24/);
  assert.doesNotThrow(() => assertSupportedNode('24.14.1'));
  const inherited = { PATH: '/usr/local/bin:/usr/bin', AI_ENABLED: 'false' };
  const environment = childEnvironment({ AI_ENABLED: 'true' }, inherited, nodeBin, '/home/test');
  assert.equal(environment.PATH.split(path.delimiter)[0], path.dirname(nodeBin));
  assert.equal(environment.ORSEM_NODE_BIN, nodeBin);
  assert.equal(environment.PM2_HOME, '/home/test/.pm2');
  assert.equal(environment.NODE_ENV, 'production');
  assert.equal(environment.AI_ENABLED, 'true');
  assert.deepEqual(inherited, { PATH: '/usr/local/bin:/usr/bin', AI_ENABLED: 'false' });
  assert.equal(
    childEnvironment({}, { PM2_HOME: '/custom/pm2' }, nodeBin, '/home/test').PM2_HOME,
    '/custom/pm2',
  );
});

test('minimal cron PATH still finds system PM2 and keeps executing Node first', () => {
  for (const inherited of [{ PATH: '/usr/bin:/bin' }, {}]) {
    const directories = childEnvironment({}, inherited, nodeBin, '/home/test').PATH.split(
      path.delimiter,
    );
    assert.equal(directories[0], path.dirname(nodeBin));
    assert.equal(directories.includes('/usr/local/bin'), true);
    assert.equal(directories.includes('/usr/bin'), true);
    assert.equal(directories.includes('/bin'), true);
    assert.equal(directories.length, new Set(directories).size);
  }
});

test('always selects API and worker, gates optional services on complete configuration', () => {
  assert.deepEqual(selectStartupNames({}, true), ['orsem-api', 'orsem-worker']);
  const environment = { ...discord, AI_ENABLED: 'true', AI_BASE_URL: 'http://127.0.0.1:11434/v1' };
  assert.deepEqual(selectStartupNames(environment, true), [
    'orsem-api',
    'orsem-worker',
    'orsem-ollama',
    'orsem-discord',
  ]);
  assert.equal(selectStartupNames(environment, false).includes('orsem-ollama'), false);
  for (const key of Object.keys(discord)) {
    assert.equal(discordConfigured({ ...discord, [key]: '' }), false, key);
  }
  assert.equal(discordConfigured({ ...discord, DISCORD_ALLOWED_USER_IDS: ', , ' }), false);
  assert.equal(discordConfigured({ ...discord, DISCORD_SERVICE_TOKEN: 'short' }), false);
});

test('Ollama is limited to the explicit loopback service and existing runtime', () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(
      usesLocalOllama({ AI_ENABLED: ' TRUE ', AI_BASE_URL: `http://${host}:11434/v1` }),
      true,
    );
  }
  for (const url of [
    'http://example.com:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://127.0.0.2:11434/v1',
    'http://user:secret@localhost:11434/v1',
    'not-a-url',
  ]) {
    assert.equal(usesLocalOllama({ AI_ENABLED: 'true', AI_BASE_URL: url }), false);
  }
  assert.equal(usesLocalOllama({ AI_ENABLED: 'false' }), false);
  assert.equal(
    ollamaBinaryPath({ ORSEM_DATA_DIR: '/data/orsem' }),
    '/data/orsem/ollama/runtime/bin/ollama',
  );
  assert.equal(ollamaBinaryPath({ OLLAMA_BIN: '/custom/ollama' }), '/custom/ollama');
});

test('cold jlist banner is parsed without retaining environment secrets', () => {
  const stdout =
    '[PM2] Spawning PM2 daemon\n[PM2] Successfully daemonized\n' +
    JSON.stringify([
      { name: 'orsem-api', pm2_env: { status: 'online', SECRET: 'never-print-this' } },
      { name: 'unrelated', pm2_env: { status: 'online' } },
    ]) +
    '\n';
  const rows = parsePm2Processes(stdout);
  assert.deepEqual(rows, [
    { name: 'orsem-api', status: 'online' },
    { name: 'unrelated', status: 'online' },
  ]);
  assert.equal(JSON.stringify(rows).includes('never-print-this'), false);
  assert.deepEqual(parsePm2Processes('[]\n'), []);
  assert.deepEqual(
    parsePm2Processes(
      JSON.stringify([
        {
          name: 'orsem-api',
          pid: 0,
          pm2_env: { status: 'waiting restart', pm_uptime: 1234, SECRET: 'never-print-this' },
        },
      ]),
    ),
    [{ name: 'orsem-api', pid: 0, status: 'waiting restart', startedAt: 1234 }],
  );
  assert.throws(() => parsePm2Processes('SECRET=never-print-this'), /unreadable process list/);
});

test('only missing, stopped, errored, or waiting processes without a PID are started', () => {
  assert.deepEqual(
    startupPlan(
      ['orsem-api', 'orsem-worker', 'orsem-ollama', 'orsem-discord'],
      [
        { name: 'orsem-api', status: 'online' },
        { name: 'orsem-worker', status: 'launching' },
        { name: 'orsem-ollama', status: 'errored' },
        { name: 'unrelated', status: 'stopped' },
      ],
    ),
    {
      start: ['orsem-ollama', 'orsem-discord'],
      active: ['orsem-api'],
      deferred: ['orsem-worker'],
    },
  );
  assert.deepEqual(
    startupPlan(
      ['orsem-api', 'orsem-worker'],
      [
        { name: 'orsem-api', status: 'stopped' },
        { name: 'orsem-worker', status: 'stopping' },
      ],
    ),
    { start: ['orsem-api'], active: [], deferred: ['orsem-worker'] },
  );
  assert.throws(() => startupPlan(['unrelated'], []), /non-Orsem/);
  for (const pid of [undefined, 123]) {
    assert.deepEqual(
      startupPlan(['orsem-api'], [{ name: 'orsem-api', status: 'waiting restart', pid }]),
      { start: [], active: [], deferred: ['orsem-api'] },
    );
  }
  assert.deepEqual(
    startupPlan(['orsem-api'], [{ name: 'orsem-api', status: 'waiting restart', pid: 0 }]),
    { start: ['orsem-api'], active: [], deferred: [] },
  );
});

test('PM2 CLI and child interpreter are pinned to the executing Node 24', async () => {
  const environment = childEnvironment({}, { PATH: '/usr/local/bin' }, nodeBin, '/home/test');
  const context = {
    root: '/project',
    nodeBin,
    pm2Cli: '/usr/local/lib/node_modules/pm2/bin/pm2',
    environment,
  };
  const args = startArguments('/project', ['orsem-api', 'orsem-worker']);
  const invocation = pm2Invocation(context, args);
  assert.equal(invocation.command, nodeBin);
  assert.deepEqual(invocation.args, [
    context.pm2Cli,
    'start',
    '/project/ecosystem.config.cjs',
    '--only',
    'orsem-api,orsem-worker',
    '--update-env',
  ]);
  assert.equal(invocation.options.env.ORSEM_NODE_BIN, nodeBin);
  assert.equal(invocation.options.env.PATH.split(path.delimiter)[0], path.dirname(nodeBin));
  assert.equal(
    invocation.args.some((arg) => ['kill', 'delete', 'save', 'resurrect', 'restart'].includes(arg)),
    false,
  );
  assert.throws(() => startArguments('/project', ['unrelated']), /non-Orsem/);
  assert.throws(() => startArguments('/project', []), /empty/);
  let seen;
  await runPm2(context, ['jlist'], async (...input) => {
    seen = input;
    return { stdout: '[]' };
  });
  assert.equal(seen[0], nodeBin);
  assert.deepEqual(seen[1], [context.pm2Cli, 'jlist']);
});

test('URL credentials and captured PM2 failures are never exposed in errors', async () => {
  const secret = 'private-password';
  assert.deepEqual(
    dependencyTargets({
      DATABASE_URL: `mysql://user:${secret}@db.example:23306/orsem`,
      REDIS_URL: `rediss://user:${secret}@[::1]:6380/0`,
    }),
    [
      { name: 'MySQL', host: 'db.example', port: 23306 },
      { name: 'Redis', host: '::1', port: 6380 },
    ],
  );
  for (const value of [`https://user:${secret}@example.com`, `mysql://user:${secret}@`]) {
    assert.throws(
      () => dependencyTargets({ DATABASE_URL: value }),
      (error) => !safeErrorMessage(error).includes(secret),
    );
  }
  for (const port of ['0', '65536', '-1']) {
    for (const [key, protocol] of [
      ['DATABASE_URL', 'mysql'],
      ['REDIS_URL', 'redis'],
    ]) {
      assert.throws(
        () => dependencyTargets({ [key]: `${protocol}://user:${secret}@localhost:${port}` }),
        (error) => error instanceof StartupError && !safeErrorMessage(error).includes(secret),
      );
    }
  }
  const context = { root: '/project', nodeBin, pm2Cli: '/pm2', environment: {} };
  await assert.rejects(
    runPm2(context, ['jlist'], async () => {
      throw new Error(`stdout contains ${secret}`);
    }),
    (error) => error instanceof StartupError && !safeErrorMessage(error).includes(secret),
  );
  assert.equal(safeErrorMessage(new Error(secret)).includes(secret), false);
});

test('the ecosystem selects the explicit boot interpreter for every Node app', async () => {
  const execute = promisify(execFile);
  const ecosystemPath = fileURLToPath(new URL('../ecosystem.config.cjs', import.meta.url));
  const code = `const config = require(${JSON.stringify(ecosystemPath)}); require('node:fs').writeSync(1, JSON.stringify(config.apps.map(({name, interpreter}) => ({name, interpreter}))));`;
  for (const override of [undefined, nodeBin]) {
    const environment = { PATH: '/usr/bin:/bin' };
    if (override) environment.ORSEM_NODE_BIN = override;
    const { stdout } = await execute(process.execPath, ['-e', code], { env: environment });
    const apps = JSON.parse(stdout);
    for (const name of ['orsem-api', 'orsem-discord']) {
      assert.equal(apps.find((app) => app.name === name).interpreter, override || process.execPath);
    }
    assert.equal(apps.find((app) => app.name === 'orsem-ollama').interpreter, 'none');
    assert.equal(apps.find((app) => app.name === 'orsem-worker').interpreter, 'none');
  }
});

test('readiness uses one total deadline and reports only dependency names', async () => {
  let time = 0;
  const targets = dependencyTargets({
    DATABASE_URL: 'mysql://user:secret@private-host/db',
    REDIS_URL: 'redis://127.0.0.1',
  });
  const probes = [];
  await assert.rejects(
    waitForDependencies(targets, {
      timeoutMs: 5_000,
      now: () => time,
      pause: async (milliseconds) => {
        time += milliseconds;
      },
      probe: async (target, timeout) => {
        probes.push({ target, timeout });
        return target.name === 'Redis';
      },
    }),
    (error) => error.message === 'Startup readiness timed out: MySQL.',
  );
  assert.equal(time, 5_000);
  assert.equal(probes.filter(({ target }) => target.name === 'Redis').length, 3);
  assert.equal(
    probes.every(({ timeout }) => timeout <= 1_500),
    true,
  );
});

test('importing the script neither runs startup nor mutates process.env', async () => {
  const execute = promisify(execFile);
  const moduleUrl = new URL('./start-at-boot.mjs', import.meta.url).href;
  const { stdout } = await execute(process.execPath, [
    '--input-type=module',
    '-e',
    `const before = JSON.stringify(process.env); await import(${JSON.stringify(moduleUrl)}); if (JSON.stringify(process.env) !== before) throw new Error('environment changed');`,
  ]);
  assert.equal(stdout, '');
});

test('Redis readiness authenticates and completes PING, never accepting just a TCP connection', async () => {
  const url = 'rediss://private-user:private-password@localhost:6380/4';
  let options;
  const calls = [];
  const factory = (input) => {
    options = input;
    return {
      isOpen: true,
      on: () => {},
      connect: async () => calls.push('connect'),
      ping: async () => {
        calls.push('ping');
        return 'PONG';
      },
      destroy: () => calls.push('destroy'),
    };
  };
  assert.equal(await redisReady(url, 100, factory), true);
  assert.equal(options.url, url);
  assert.equal(options.socket.reconnectStrategy, false);
  assert.deepEqual(calls, ['connect', 'ping', 'destroy']);
  const failure = factory({});
  failure.ping = async () => {
    throw new Error('LOADING private-password');
  };
  assert.equal(await redisReady(url, 100, () => failure), false);
  failure.ping = async () => new Promise(() => {});
  assert.equal(await redisReady(url, 10, () => failure), false);
  assert.equal(calls.filter((call) => call === 'destroy').length, 3);
});

test('a dependency that becomes unavailable again cannot be forgotten after its first successful check', async () => {
  let time = 0;
  const targets = dependencyTargets({
    DATABASE_URL: 'mysql://localhost/db',
    REDIS_URL: 'redis://localhost',
  });
  await assert.rejects(
    waitForDependencies(targets, {
      timeoutMs: 3_000,
      now: () => time,
      pause: async (milliseconds) => {
        time += milliseconds;
      },
      probe: async (target) => target.name === (time === 0 ? 'Redis' : 'MySQL'),
    }),
    { message: 'Startup readiness timed out: Redis.' },
  );
});

test('API readiness uses a fixed loopback endpoint and requires healthy dependency status', async () => {
  assert.equal(apiReadyUrl({}), 'http://127.0.0.1:3210/api/v1/health/ready');
  assert.equal(apiReadyUrl({ PORT: '3211' }), 'http://127.0.0.1:3211/api/v1/health/ready');
  for (const PORT of ['0', '65536', 'localhost', '3210/path', '3210.5'])
    assert.throws(() => apiReadyUrl({ PORT }), /port configuration/u);
  let requests = 0;
  const request = async (_url, options) => {
    requests += 1;
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(
      JSON.stringify({ status: 'ready', database: { ready: true }, sessions: { ready: true } }),
    );
  };
  assert.equal(await apiReady(apiReadyUrl({}), 100, request), true);
  for (const url of [
    'https://example.com/api/v1/health/ready',
    'http://localhost:3210/api/v1/health/ready',
    'http://private:secret@127.0.0.1:3210/api/v1/health/ready',
    'http://127.0.0.1:3210/',
  ])
    assert.equal(await apiReady(url, 100, request), false);
  assert.equal(requests, 1);
  for (const response of [
    new Response('private-server-text', { status: 503 }),
    new Response('not-json'),
    new Response(
      JSON.stringify({ status: 'ready', database: { ready: false }, sessions: { ready: true } }),
    ),
    new Response(JSON.stringify({ status: 'fixture' })),
  ])
    assert.equal(await apiReady(apiReadyUrl({}), 100, async () => response), false);
});

function recoveryHarness(processes, overrides = {}) {
  let time = 0;
  const calls = [];
  const messages = [];
  const context = {
    root: '/project',
    nodeBin,
    pm2Cli: '/pm2',
    environment: { DATABASE_URL: 'mysql://localhost/db', REDIS_URL: 'redis://localhost' },
  };
  const list = (rows = processes) =>
    JSON.stringify(
      rows.map(({ name, status, pid, startedAt }) => ({
        name,
        pid,
        pm2_env: { status, pm_uptime: startedAt },
      })),
    );
  const options = {
    recover: true,
    probeDependency: async () => true,
    probeApi: async () => true,
    pm2: async (_context, args) => {
      calls.push(args);
      return args[0] === 'jlist' ? list() : '';
    },
    now: () => time,
    wallNow: () => 100_000,
    pause: async (milliseconds) => {
      time += milliseconds;
    },
    log: (message) => messages.push(message),
    ...overrides,
  };
  return {
    context,
    options,
    calls,
    list,
    messages,
    run: () => ensureStartup(context, ['orsem-api', 'orsem-worker'], options),
  };
}

const running = [
  { name: 'orsem-api', status: 'online', pid: 123, startedAt: 1_000 },
  { name: 'orsem-worker', status: 'online', pid: 124, startedAt: 1_000 },
  { name: 'unrelated', status: 'online', pid: 125, startedAt: 1_000 },
];

test('periodic recovery checks unavailable dependencies once without contacting PM2 or waiting', async () => {
  const dependencies = [];
  const harness = recoveryHarness(running, {
    probeDependency: async ({ name }) => {
      dependencies.push(name);
      return name !== 'Redis';
    },
    pause: async () => assert.fail('periodic dependency check must not wait'),
  });
  await assert.rejects(harness.run(), {
    message: 'Recovery deferred; dependencies unavailable: Redis.',
  });
  assert.deepEqual(dependencies, ['MySQL', 'Redis']);
  assert.deepEqual(harness.calls, []);
});

test('healthy and briefly unresponsive APIs are not restarted and healthy workers remain untouched', async () => {
  let checks = 0;
  const harness = recoveryHarness(running, { probeApi: async () => ++checks >= 3 });
  await harness.run();
  assert.equal(checks, 3);
  assert.deepEqual(harness.calls, [['jlist']]);
  assert.deepEqual(harness.messages, []);
});

test('stale online API is restarted once after repeated HTTP failure and dependencies are rechecked', async () => {
  let dependencies = 0;
  const harness = recoveryHarness(running, {
    probeDependency: async () => {
      dependencies += 1;
      return true;
    },
  });
  harness.options.probeApi = async () => harness.calls.some(([command]) => command === 'restart');
  await harness.run();
  assert.equal(dependencies, 4);
  assert.deepEqual(harness.calls, [
    ['jlist'],
    ['jlist'],
    ['restart', '/project/ecosystem.config.cjs', '--only', 'orsem-api', '--update-env'],
  ]);
});

test('periodic recovery defers online API during its startup grace or when its start time is unknown', async () => {
  for (const startedAt of [undefined, 60_000, 110_000]) {
    const harness = recoveryHarness([{ ...running[0], startedAt }, running[1]], {
      probeApi: async () => false,
    });
    await assert.rejects(harness.run(), /recovery deferred/u);
    assert.deepEqual(harness.calls, [['jlist'], ['jlist']]);
  }
});

test('a concurrent API restart prevents recovery from interrupting the new process', async () => {
  const harness = recoveryHarness(running, { probeApi: async () => false });
  let lists = 0;
  harness.options.pm2 = async (_context, args) => {
    harness.calls.push(args);
    if (args[0] !== 'jlist') assert.fail('must not mutate changing process');
    return harness.list(++lists === 1 ? running : [{ ...running[0], pid: 999 }, running[1]]);
  };
  await assert.rejects(harness.run(), /recovery deferred/u);
});

test('dependency loss during API health retries prevents a recovery restart', async () => {
  let dependencies = 0;
  const harness = recoveryHarness(running, {
    probeApi: async () => false,
    probeDependency: async () => ++dependencies <= 2,
  });
  await assert.rejects(harness.run(), /dependencies unavailable/u);
  assert.deepEqual(harness.calls, [['jlist'], ['jlist']]);
});

test('persistent HTTP failure receives at most one recovery restart and remains a failure', async () => {
  const harness = recoveryHarness(running, { probeApi: async () => false });
  await assert.rejects(harness.run(), {
    message: 'API did not become ready after one recovery attempt.',
  });
  assert.equal(harness.calls.filter(([command]) => command === 'restart').length, 1);
  assert.equal(
    harness.messages.some((message) => message.includes('complete')),
    false,
  );
});

test('HTTP 503 dependency degradation does not trigger recurring API restart churn even with healthy PING', async () => {
  const harness = recoveryHarness(running, {
    probeApi: async (url, timeoutMs) =>
      apiHealth(
        url,
        timeoutMs,
        async () =>
          new Response(
            JSON.stringify({
              status: 'degraded',
              database: { ready: true },
              sessions: { ready: false, message: 'Redis persistence failed; writes are blocked.' },
            }),
            { status: 503 },
          ),
      ),
  });
  for (let attempt = 0; attempt < 2; attempt += 1)
    await assert.rejects(harness.run(), {
      message: 'API reports degraded dependencies; recovery deferred without a restart.',
    });
  assert.deepEqual(harness.calls, [['jlist'], ['jlist']]);
  assert.deepEqual(harness.messages, []);
});

test('normal startup still waits for recovering dependencies and verifies HTTP readiness', async () => {
  let checks = 0;
  const harness = recoveryHarness([running[1]], {
    recover: false,
    probeDependency: async () => ++checks > 2,
  });
  await harness.run();
  assert.equal(checks, 4);
  assert.match(harness.messages.at(-1), /readiness confirmed/u);
});

test('waiting processes with PID zero recover while launching and stopping processes are deferred', async () => {
  const waiting = recoveryHarness([
    { ...running[0], status: 'waiting restart', pid: 0 },
    running[1],
  ]);
  await waiting.run();
  assert.deepEqual(waiting.calls, [
    ['jlist'],
    ['start', '/project/ecosystem.config.cjs', '--only', 'orsem-api', '--update-env'],
  ]);
  for (const status of ['launching', 'stopping', 'waiting restart']) {
    const harness = recoveryHarness([{ ...running[0], status }, running[1]]);
    await assert.rejects(harness.run(), /transitional processes/u);
    assert.deepEqual(harness.calls, [['jlist']]);
  }
});

test('a successful PM2 start without actual API readiness is reported as failure', async () => {
  const harness = recoveryHarness([{ ...running[0], status: 'stopped', pid: 0 }, running[1]], {
    probeApi: async () => false,
  });
  await assert.rejects(harness.run(), { message: 'API did not become ready after startup.' });
  assert.equal(harness.calls.filter(([command]) => command === 'restart').length, 0);
  assert.equal(
    harness.messages.some((message) => message.includes('complete')),
    false,
  );
});
