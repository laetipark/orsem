import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { cursorInstant, decodeCursor, encodeCursor } from './cursor';

test('cursor is opaque and round-trips', () => {
  const input = { sort: '2026-09-03T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001' };
  const encoded = encodeCursor(input);
  assert.ok(!encoded.includes(input.id));
  assert.deepEqual(decodeCursor(encoded), input);
});

test('invalid cursor fails closed', () => {
  assert.throws(() => decodeCursor('not-json'));
});

test('time-based cursors preserve the instant and reject invalid timestamps', () => {
  assert.equal(
    cursorInstant('2026-09-05T09:00:00+09:00').toISOString(),
    '2026-09-05T00:00:00.000Z',
  );
  assert.throws(() => cursorInstant('invalid-timestamp'), BadRequestException);
});
