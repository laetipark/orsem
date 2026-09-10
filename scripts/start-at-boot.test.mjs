import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  StartupError,
  assertSupportedNode,
  childEnvironment,
  dependencyTargets,
  discordConfigured,
  ollamaBinaryPath,
  parsePm2Processes,
  pm2Invocation,
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
  assert.throws(() => parsePm2Processes('SECRET=never-print-this'), /unreadable process list/);
});

test('only missing, stopped, and errored Orsem processes are started', () => {
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
      active: ['orsem-api', 'orsem-worker'],
      deferred: [],
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
  const code = `const config = require(${JSON.stringify(ecosystemPath)}); console.log(JSON.stringify(config.apps.map(({name, interpreter}) => ({name, interpreter}))));`;
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
  assert.equal(probes.filter(({ target }) => target.name === 'Redis').length, 1);
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
