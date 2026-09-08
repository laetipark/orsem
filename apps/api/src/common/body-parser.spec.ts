import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Body, Controller, Put } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { json, type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { groupSaveSchema } from '@orsem/contracts';
import { WatchlistGroupsController } from '../watchlist-groups/watchlist-groups.controller';
import { WatchlistGroupsService } from '../watchlist-groups/watchlist-groups.service';
import { WorkerQueueService } from '../operations/worker-queue.service';
import { OrsemDataService } from '../resources/orsem-data.service';
import { NaverFocusNewsService } from '../news-search/naver-focus-news.service';
import { registerBodyParsers } from './body-parser';

const memberId = '11111111-1111-4111-8111-111111111111';
const payload = {
  revision: 10,
  groups: Array.from({ length: 5 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `관심 그룹 ${index + 1}`,
  })).reverse(),
};

@Controller()
class BodyProbeController {
  @Put('body-probe') regular(@Body() body: unknown) {
    return this.result(body);
  }
  @Put('news/body-probe') news(@Body() body: unknown) {
    return this.result(body);
  }
  @Put('newsroom/body-probe') similarPrefix(@Body() body: unknown) {
    return this.result(body);
  }
  private result(body: unknown) {
    return { received: typeof body === 'object' && body !== null };
  }
}

async function harness(t: TestContext, register: (app: NestExpressApplication) => void) {
  const saves: Array<{ actor: unknown; input: unknown }> = [];
  const module = await Test.createTestingModule({
    controllers: [WatchlistGroupsController, BodyProbeController],
    providers: [
      {
        provide: WatchlistGroupsService,
        useValue: {
          saveGroups: async (actor: unknown, input: unknown) => {
            saves.push({ actor, input });
          },
        },
      },
      { provide: WorkerQueueService, useValue: {} },
      { provide: OrsemDataService, useValue: {} },
      { provide: NaverFocusNewsService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  t.after(() => app.close());
  app.use((request: Request, _response: ExpressResponse, next: NextFunction) => {
    request.session = { memberId } as Request['session'];
    next();
  });
  // This is intentionally registered before Nest init, exactly as in main.ts.
  register(app);
  app.setGlobalPrefix('api/v1');
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  return {
    saves,
    send: (path: string, body: string) =>
      fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
  };
}

test('a path-mounted jsonParser suppresses Nest global parsing and reproduces the valid group-save 400', async (t) => {
  assert.equal(groupSaveSchema.safeParse(payload).success, true);
  const app = await harness(t, (nest) => nest.use('/api/v1/news', json({ limit: '512kb' })));
  const response = await app.send('/watchlist-groups/edit', JSON.stringify(payload));
  assert.equal(response.status, 400);
  const body = (await response.json()) as { message: string; issues: Array<{ path: string }> };
  assert.equal(body.message, '요청 값이 올바르지 않습니다.');
  assert.deepEqual(
    body.issues.map((issue) => issue.path),
    [''],
  );
  assert.deepEqual(app.saves, []);
  const news = await app.send('/news/body-probe', JSON.stringify({ text: '뉴스 본문' }));
  assert.equal(news.status, 200);
  assert.deepEqual(await news.json(), { received: true });
});

test('production parser registration passes the same personal group order and numeric revision to the real controller', async (t) => {
  const app = await harness(t, registerBodyParsers);
  const response = await app.send('/watchlist-groups/edit', JSON.stringify(payload));
  assert.equal(response.status, 204);
  assert.deepEqual(app.saves, [
    { actor: { kind: 'MEMBER', id: memberId, key: `MEMBER:${memberId}` }, input: payload },
  ]);
  const malformed = await app.send('/watchlist-groups/edit', '{"revision":');
  assert.equal(malformed.status, 400);
  assert.equal(app.saves.length, 1);
});

function bodyBytes(size: number) {
  const overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
  return JSON.stringify({ text: 'x'.repeat(size - overhead) });
}

test('ordinary JSON keeps its 100KiB limit while news accepts 100k Korean characters and at most 512KiB', async (t) => {
  const app = await harness(t, registerBodyParsers);
  const ordinary = await app.send('/body-probe', bodyBytes(100 * 1024));
  assert.equal(ordinary.status, 200);
  assert.deepEqual(await ordinary.json(), { received: true });
  const oversized = await app.send('/body-probe', bodyBytes(100 * 1024 + 1));
  assert.equal(oversized.status, 413);

  const korean = await app.send('/news/body-probe', JSON.stringify({ text: '한'.repeat(100_000) }));
  assert.equal(korean.status, 200);
  assert.deepEqual(await korean.json(), { received: true });
  const newsBoundary = await app.send('/news/body-probe', bodyBytes(512 * 1024));
  assert.equal(newsBoundary.status, 200);
  assert.deepEqual(await newsBoundary.json(), { received: true });
  const newsOversized = await app.send('/news/body-probe', bodyBytes(512 * 1024 + 1));
  assert.equal(newsOversized.status, 413);

  const similarPrefix = await app.send('/newsroom/body-probe', bodyBytes(100 * 1024 + 1));
  assert.equal(similarPrefix.status, 413);
  assert.deepEqual(app.saves, []);
});
