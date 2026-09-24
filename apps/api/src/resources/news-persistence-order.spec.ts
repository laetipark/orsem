import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request } from 'express';
import { DashboardController } from './resource.controllers';

test('personal news reads persisted results after collection completes and retains saved news on failure', async () => {
  let stored = false;
  let fail = false;
  const controller = new DashboardController(
    {
      personalNews: async () => ({ news: stored ? [{ id: 'persisted-naver' }] : [] }),
    } as never,
    {} as never,
    {
      feed: async () => {
        await Promise.resolve();
        if (fail) throw new Error('provider unavailable');
        stored = true;
        return { groups: [], status: 'READY' };
      },
    } as never,
  );
  const request = { session: { memberId: 'mine' } } as Request;
  assert.deepEqual((await controller.personalNews(request)).news, [{ id: 'persisted-naver' }]);
  fail = true;
  const cached = await controller.personalNews(request);
  assert.deepEqual(cached.news, [{ id: 'persisted-naver' }]);
  assert.equal(cached.naver, null);
});
