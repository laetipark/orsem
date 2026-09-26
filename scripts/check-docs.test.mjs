import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkDocs, checkMarkdown } from './check-docs.mjs';

const root = '/workspace/project';
const file = `${root}/docs/README.md`;

test('documentation rejects machine-specific paths, including command blocks', () => {
  const source = [
    '`/home/user/project/apps/api`',
    '```bash',
    'node /opt/project/scripts/check.mjs',
    '```',
    '`C:\\Users\\example\\project` and `~/project`',
    '[file](file:///tmp/report.md)',
  ].join('\n');
  const issues = checkMarkdown(source, file, root);
  assert.equal(issues.length, 5);
  assert.match(issues[0], /^docs\/README.md:1:/);
  assert.match(issues[1], /^docs\/README.md:3:/);
});

test('project-relative paths, computed runtime paths, routes and URLs are allowed', () => {
  const source = [
    '`apps/api`, `../orsem-data`, `../../../tmp/report`',
    'export ORSEM_REPO_ROOT="$PWD"',
    'export RAW_DOCUMENT_DIR="$PWD/../orsem-data/raw"',
    '`/api/v1/companies` and `/watchlist/popout`',
    '[source](https://example.org/home/user) and https://example.org/usr/bin',
    '[query](https://example.org/?path=/home/user) and //example.org/?path=/tmp/report',
  ].join('\n');
  assert.deepEqual(checkMarkdown(source, file, root), []);
});

test('local links resolve relative to their document and decode spaces', () => {
  const checked = [];
  const source =
    '[root](../README.md) [guide](My%20Guide.md#설치) [image](<../assets/Logo Wide.svg>)';
  assert.deepEqual(
    checkMarkdown(source, file, root, (target) => {
      checked.push(target);
      return true;
    }),
    [],
  );
  assert.deepEqual(checked, [
    `${root}/README.md`,
    `${root}/docs/My Guide.md`,
    `${root}/assets/Logo Wide.svg`,
  ]);
});

test('missing local links and reference definitions are reported with line numbers', () => {
  const issues = checkMarkdown(
    '[gone](deleted.md)\n[guide]: ../old.md "Old guide"',
    file,
    root,
    () => false,
  );
  assert.equal(issues.length, 2);
  assert.match(issues[0], /^docs\/README.md:1: Missing relative link target: deleted.md$/);
  assert.match(issues[1], /^docs\/README.md:2: Missing relative link target: ..\/old.md$/);
});

test('balanced and escaped parentheses are preserved in local link destinations', () => {
  const checked = [];
  const source =
    '[guide](Guide(archive(2026)).md) [escaped](Guide\\(archive\\).md)\n[guide]: Guide(archive).md';
  assert.deepEqual(
    checkMarkdown(source, file, root, (target) => {
      checked.push(target);
      return true;
    }),
    [],
  );
  assert.deepEqual(checked, [
    `${root}/docs/Guide(archive(2026)).md`,
    `${root}/docs/Guide(archive).md`,
    `${root}/docs/Guide(archive).md`,
  ]);
});

test('link examples inside code are ignored while normal links are checked', () => {
  const source =
    '````md\n[example](missing.md)\n```\n````\n`[example](missing.md)`\n[real](missing.md)';
  const issues = checkMarkdown(source, file, root, () => false);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^docs\/README.md:6:/);
});

test('anchors, remote links and application routes do not query the filesystem', () => {
  const source =
    '[section](#hello) [email](mailto:example@example.org) [api](/api/v1) [remote](//example.org/docs)';
  assert.deepEqual(
    checkMarkdown(source, file, root, () => assert.fail('Unexpected local lookup')),
    [],
  );
});

test('malformed URL escapes and external filesystem links fail cleanly', () => {
  const issues = checkMarkdown(
    '[bad](bad%GG.md) [external](../../private.md)',
    file,
    root,
    () => true,
  );
  assert.equal(issues.length, 2);
  assert.match(issues[0], /Invalid link encoding/);
  assert.match(issues[1], /External filesystem links are not portable/);
});

test('repository scan excludes dependency, generated, hidden and symlinked directories', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'orsem-docs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, 'README.md'), '[guide](docs/GUIDE.md)');
  for (const name of ['docs', 'node_modules', 'dist', '.venv', 'coverage', 'build']) {
    mkdirSync(path.join(directory, name));
    writeFileSync(
      path.join(directory, name, 'GUIDE.md'),
      name === 'docs' ? 'Guide' : '[missing](missing.md)',
    );
  }
  symlinkSync(path.join(directory, 'node_modules'), path.join(directory, 'external'));
  assert.deepEqual(checkDocs(directory), { count: 2, issues: [] });
});
