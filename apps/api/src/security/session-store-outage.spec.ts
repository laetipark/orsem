import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Controller, Get, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request } from 'express';
import session, { type SessionData } from 'express-session';
import { AuthController } from '../auth/auth.controller';
import { AuthService } from '../auth/auth.service';
import { MemberService } from '../auth/member.service';
import { saveSession } from '../auth/session';
import { loadAppConfig } from '../config/app-config';
import { SessionRuntimeService } from './session-runtime.service';

class IntermittentStore extends session.MemoryStore {
  failReads = false;
  writes = 0;

  override get(id: string, callback: (error: unknown, value?: SessionData | null) => void): void {
    if (this.failReads) {
      callback(new Error('synthetic Redis failure with private connection details'));
      return;
    }
    super.get(id, callback);
  }

  override set(id: string, value: SessionData, callback?: (error?: unknown) => void): void {
    this.writes += 1;
    super.set(id, value, callback);
  }
}

@Controller('fixture')
class FixtureController {
  @Get('sign-in')
  async signIn(@Req() request: Request) {
    request.session.memberId = 'synthetic-member';
    request.session.sessionStartedAt = new Date(Date.now() - 4 * 86_400_000).toISOString();
    await saveSession(request);
    return { ready: true };
  }
}

@Controller('api/v1/public')
class PublicFixtureController {
  @Get('news')
  news(@Req() request: Request) {
    return { items: [], loadedSession: Boolean(request.session) };
  }
}

test('a session-store outage returns 503 without replacing the cookie or turning a member anonymous', async (t) => {
  const config = loadAppConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'synthetic-store-outage-session-secret',
  });
  const runtime = new SessionRuntimeService(config);
  const store = new IntermittentStore();
  let memberLookups = 0;
  const module = await Test.createTestingModule({
    controllers: [AuthController, FixtureController, PublicFixtureController],
    providers: [
      {
        provide: AuthService,
        useValue: { setupRequired: async () => false, getAdmin: async () => null },
      },
      {
        provide: MemberService,
        useValue: {
          getMember: async (id: string) => {
            memberLookups += 1;
            assert.equal(id, 'synthetic-member');
            return { id, provider: 'KAKAO', role: 'VIEWER', status: 'APPROVED' };
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  app.use(runtime.middleware(store));
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const signIn = await fetch(`${baseUrl}/fixture/sign-in`);
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const read = () => fetch(`${baseUrl}/auth/session`, { headers: { Cookie: cookie } });
  const before = await read();
  assert.equal(before.status, 200);
  const beforeBody = (await before.json()) as { authenticated: boolean };
  assert.equal(beforeBody.authenticated, true);
  assert.equal(memberLookups, 1);
  const writesBeforeFailure = store.writes;

  store.failReads = true;
  const failed = await read();
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal(memberLookups, 1, 'an unavailable store must stop before identity lookup');
  assert.equal(
    store.writes,
    writesBeforeFailure,
    'the outage must not create an anonymous session',
  );
  const failure = await failed.text();
  assert.doesNotMatch(failure, /synthetic|private connection|authenticated/u);

  const publicRead = await fetch(`${baseUrl}/api/v1/public/news`, { headers: { Cookie: cookie } });
  assert.equal(publicRead.status, 200, 'public reads remain available during a session outage');
  assert.deepEqual(await publicRead.json(), { items: [], loadedSession: false });
  assert.equal(publicRead.headers.get('set-cookie'), null);
  assert.equal(store.writes, writesBeforeFailure);
  assert.equal(memberLookups, 1);
  const publicHead = await fetch(`${baseUrl}/api/v1/public/news`, {
    method: 'HEAD',
    headers: { Cookie: cookie },
  });
  assert.equal(publicHead.status, 200);
  const mutation = await fetch(`${baseUrl}/api/v1/public/news`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(mutation.status, 503, 'mutations still pass through the session store');

  store.failReads = false;
  const recovered = await read();
  assert.equal(recovered.status, 200);
  const recoveredBody = (await recovered.json()) as { authenticated: boolean };
  assert.equal(recoveredBody.authenticated, true);
  assert.equal(memberLookups, 2, 'the original cookie still resolves after the outage');
});
