import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { failBootstrap } from './bootstrap-failure';

test('bootstrap failure closes resources then exits nonzero without exposing cleanup errors', async () => {
  const events: string[] = [];
  await failBootstrap(
    async () => {
      events.push('close');
      throw new Error('redis://private-user:private-password@server');
    },
    {
      log: (message) => events.push(message),
      exit: (code) => events.push(`exit:${code}`),
    },
  );
  assert.equal(events[1], 'close');
  assert.equal(events[2], 'exit:1');
  assert.equal(
    events.some((event) => event.includes('private-')),
    false,
  );
});

test('bootstrap failure exits after a cleanup deadline even when PM2-style handlers keep Node alive', async () => {
  const script = `
    const { failBootstrap } = require(${JSON.stringify(require.resolve('./bootstrap-failure'))});
    process.on('unhandledRejection', () => {});
    setInterval(() => {}, 10000);
    Promise.reject(new Error('private-startup-error')).catch(() =>
      failBootstrap(() => new Promise(() => {}), { timeoutMs: 20 })
    );
  `;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(output, /API startup failed/u);
    assert.equal(output.includes('private-startup-error'), false);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
