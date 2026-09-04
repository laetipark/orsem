import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';
import { finishPage, pageRows, paginateFixture } from './pagination';

const rows = [
  { id: 'a', date: '2026-09-05' },
  { id: 'b', date: '2026-09-05' },
  { id: 'c', date: '2026-09-04' },
];

test('lookahead rows are not mapped and the cursor identifies the last visible row', () => {
  const mapped: string[] = [];
  const page = pageRows(
    rows,
    2,
    (row) => {
      mapped.push(row.id);
      return row.id.toUpperCase();
    },
    (row) => row.date,
  );
  assert.deepEqual(mapped, ['a', 'b']);
  assert.deepEqual(page.items, ['A', 'B']);
  assert.deepEqual(decodeCursor(page.nextCursor!), { id: 'b', sort: '2026-09-05' });
  assert.deepEqual(page.pageInfo, { hasMore: true, nextCursor: page.nextCursor });
});

test('empty and exactly full final pages do not expose a continuation cursor', () => {
  for (const available of [[], rows.slice(0, 2)]) {
    const page = finishPage(
      available,
      2,
      available.map((row) => row.id),
      (row) => row.date,
    );
    assert.equal(page.nextCursor, null);
    assert.deepEqual(page.pageInfo, { hasMore: false, nextCursor: null });
  }
});

test('fixture pagination continues past equal sort values and rejects a cursor outside filtered results', () => {
  const first = paginateFixture(rows, { limit: 1 }, (row) => row.date);
  const second = paginateFixture(rows, { limit: 1, cursor: first.nextCursor! }, (row) => row.date);
  const last = paginateFixture(rows, { limit: 1, cursor: second.nextCursor! }, (row) => row.date);
  assert.deepEqual([first.items[0]?.id, second.items[0]?.id, last.items[0]?.id], ['a', 'b', 'c']);
  assert.equal(last.nextCursor, null);
  assert.throws(
    () =>
      paginateFixture(
        rows.slice(1),
        { limit: 1, cursor: encodeCursor({ id: 'a', sort: rows[0]!.date }) },
        (row) => row.date,
      ),
    BadRequestException,
  );
});
