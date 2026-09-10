import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { companyLogoMetadataSchema, companyLogoResponseSchema } from '@orsem/contracts';
import {
  CompanyLogoController,
  CompanyLogoService,
  initialCompanyLogoMetadata,
  validateCompanyLogoRegistration,
} from './company-logo.service';
import { loadAppConfig } from '../config/app-config';
import { AdminSessionGuard, CsrfGuard } from '../security/security';
import {
  COMPANY_LOGO_BUDGET_SCRIPT,
  SessionRuntimeService,
} from '../security/session-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';

const ID = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
const NOW = new Date().toISOString();
const row = {
  id: ID,
  market: 'NASDAQ',
  symbol: 'AAPL',
  cik: '0000320193',
  stockMetadata: { companyId: ID, symbol: 'AAPL', rawPayload: { securityType: 'STOCK' } },
};
const reviewed = {
  value: 'apple.com',
  sourceUrl: 'https://www.apple.com/',
  reviewStatus: 'reviewed' as const,
  reviewedAt: NOW,
};
const asset = {
  path: '/logos/reviewed/example.svg',
  source: 'manual' as const,
  sourceUrl: 'https://example.com/license',
  license: 'Test asset only',
  attribution: 'Test author',
  rightsReviewed: true,
  reviewStatus: 'reviewed' as const,
  reviewedAt: NOW,
  logoRole: 'company' as const,
};
function mapping() {
  return {
    ...initialCompanyLogoMetadata(row),
    reviewStatus: 'reviewed' as const,
    reviewedAt: NOW,
    localLogo: asset,
  };
}
function service(
  metadata?: unknown,
  options: { row?: Record<string, unknown>; env?: NodeJS.ProcessEnv; ready?: boolean } = {},
) {
  const writes: unknown[] = [];
  const queries: string[] = [];
  const reservations: unknown[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      return [{ ...row, ...options.row, metadata }];
    },
    getRepository: () => ({
      upsert: async (data: unknown) => {
        writes.push(data);
      },
    }),
  };
  const runtime = { requireDataSource: () => db, dataSource: db };
  const sessions = {
    health: { ready: options.ready ?? false },
    consumeCompanyLogoBudget: async (...args: unknown[]) => {
      reservations.push(args);
      return true;
    },
  };
  return {
    api: new CompanyLogoService(
      runtime as never,
      loadAppConfig({ NODE_ENV: 'test', ...options.env }),
      sessions as never,
      new FixtureStoreService(),
    ),
    writes,
    queries,
    reservations,
  };
}

test('logo metadata preserves security identities and rejects old fetched-logo verification', async () => {
  const state = service({
    status: 'AVAILABLE',
    iconUrl: 'https://static2.finnhub.io/logo.png',
    verifiedAt: NOW,
  });
  const response = companyLogoResponseSchema.parse(await state.api.get(ID));
  assert.equal(response.metadata.companyId, ID);
  assert.equal(response.metadata.symbol, 'AAPL');
  assert.equal(response.metadata.assetType, 'stock');
  assert.equal(response.metadata.reviewStatus, 'unreviewed');
  assert.equal(response.metadata.localLogo, null);
  assert.equal(state.writes.length, 0);
  assert.ok(state.queries.every((sql) => !sql.includes('COMPANY_LOGO_REQUEST')));
  for (const symbol of ['005930', '005935', '0000A0', 'BRK.B', 'GOOG', 'GOOGL'])
    assert.equal(
      initialCompanyLogoMetadata({ id: symbol, market: 'KOSPI', symbol }).symbol,
      symbol,
    );
});

test('no external credentials or unavailable shared storage disables only providers', async () => {
  for (const options of [
    {},
    { ready: true },
    {
      ready: false,
      env: { LOGO_DEV_ENABLED: 'true', LOGO_DEV_PUBLISHABLE_KEY: 'pk_example-public' },
    },
    {
      ready: true,
      env: { LOGO_DEV_ENABLED: 'true', LOGO_DEV_PUBLISHABLE_KEY: 'sk_server-secret' },
    },
  ]) {
    const state = service({ mapping: mapping() }, options);
    const response = await state.api.get(ID);
    assert.equal(response.metadata.localLogo?.path, asset.path);
    assert.equal(response.providers.logoDev.enabled, false);
    assert.equal(response.providers.logoDev.publishableKey, null);
    assert.equal((await state.api.permit(ID, 'logoDev')).allowed, false);
    assert.equal(state.reservations.length, 0);
  }
});

test('each external candidate reserves the global provider cap and account flags can disable a mapping', async () => {
  const env = {
    LOGO_DEV_ENABLED: 'true',
    LOGO_DEV_PUBLISHABLE_KEY: 'pk_example-public',
    LOGO_DEV_MONTHLY_LIMIT: '1000',
    BRANDFETCH_ENABLED: 'true',
    BRANDFETCH_CLIENT_ID: 'client-example',
  };
  const state = service({ mapping: mapping() }, { ready: true, env });
  assert.equal((await state.api.get(ID)).providers.logoDev.publishableKey, 'pk_example-public');
  assert.equal((await state.api.permit(ID, 'logoDev')).allowed, true);
  assert.deepEqual(state.reservations, [['logoDev', 1000]]);
  const disabled = mapping();
  disabled.providers.logoDev.enabled = false;
  const other = service({ mapping: disabled }, { ready: true, env });
  assert.equal((await other.api.permit(ID, 'logoDev')).allowed, false);
  assert.equal(other.reservations.length, 0);
  assert.throws(() => loadAppConfig({ LOGO_DEV_MONTHLY_LIMIT: '500001' }));
  assert.throws(() => loadAppConfig({ BRANDFETCH_MONTHLY_LIMIT: '500001' }));
});

test('explicit rejection persists and stale or damaged records never re-enable automatic providers', async () => {
  const env = { LOGO_DEV_ENABLED: 'true', LOGO_DEV_PUBLISHABLE_KEY: 'pk_example-public' };
  const rejected = { ...mapping(), reviewStatus: 'rejected' as const };
  const state = service({ mapping: rejected }, { ready: true, env });
  await state.api.save(ID, rejected, ADMIN);
  assert.equal(state.writes.length, 1);
  assert.equal((await state.api.get(ID)).metadata.reviewStatus, 'rejected');
  assert.equal((await state.api.permit(ID, 'logoDev')).allowed, false);
  assert.equal(state.reservations.length, 0);
  for (const record of [
    { broken: true },
    { mapping: { ...mapping(), symbol: 'GOOGL' } },
    { mapping: { ...mapping(), localLogo: { ...asset, rightsReviewed: false } } },
  ]) {
    const damaged = service(record, { ready: true, env });
    assert.equal((await damaged.api.get(ID)).metadata.providers.logoDev.enabled, false);
    assert.equal((await damaged.api.permit(ID, 'logoDev')).allowed, false);
  }
});

test('stored OpenDART homepage is only an unreviewed candidate and requires a real corp code', () => {
  const korean = {
    id: ID,
    market: 'KOSPI',
    symbol: '005930',
    corpCode: '00126380',
    homepage: 'http://www.samsung.com/sec/',
  };
  const result = initialCompanyLogoMetadata(korean);
  assert.equal(result.officialDomain?.value, 'samsung.com');
  assert.equal(result.officialDomain?.reviewStatus, 'unreviewed');
  assert.equal(result.assetType, 'unknown');
  assert.equal(initialCompanyLogoMetadata({ ...korean, corpCode: '005930' }).officialDomain, null);
  assert.equal(initialCompanyLogoMetadata({ ...korean, market: 'KRX' }).exchange, null);
  assert.equal(
    initialCompanyLogoMetadata({
      ...row,
      stockMetadata: { companyId: ID, symbol: 'GOOGL', rawPayload: { securityType: 'STOCK' } },
    }).assetType,
    'unknown',
  );
});

test('ETF identity is source metadata, fund and issuer roles are explicit, names are never classified', () => {
  const etf = initialCompanyLogoMetadata({
    id: ID,
    market: 'KOSPI',
    symbol: '069500',
    etfMetadata: { companyId: ID, symbol: '069500', securityType: 'ETF' },
  });
  assert.equal(etf.assetType, 'etf');
  assert.equal(etf.issuerId, null);
  const input = { ...etf, reviewStatus: 'reviewed' as const, reviewedAt: NOW, localLogo: asset };
  assert.throws(() => validateCompanyLogoRegistration(input), /ETF/u);
  input.localLogo = { ...asset, logoRole: 'fund' as never };
  validateCompanyLogoRegistration(input);
  assert.throws(
    () =>
      validateCompanyLogoRegistration({ ...input, issuerLogo: { ...asset, logoRole: 'issuer' } }),
    /운용사/u,
  );
  validateCompanyLogoRegistration({
    ...input,
    issuerId: 'reviewed-manager',
    issuerLogo: { ...asset, logoRole: 'issuer' },
  });
});

test('KRX logo exchange reuses only matching active TOSS KOSPI or KOSDAQ security metadata', () => {
  for (const market of ['KOSPI', 'KOSDAQ']) {
    for (const securityType of ['STOCK', 'ETF']) {
      const company = {
        id: ID,
        market: 'KRX',
        symbol: '005930',
        stockMetadata: {
          companyId: ID,
          symbol: '005930',
          rawPayload: {
            symbol: '005930',
            market,
            currency: 'KRW',
            status: 'ACTIVE',
            securityType,
          },
        },
      };
      const original = structuredClone(company);
      const metadata = initialCompanyLogoMetadata(company);
      assert.equal(metadata.exchange, market);
      assert.equal(metadata.assetType, securityType === 'ETF' ? 'etf' : 'stock');
      assert.equal(metadata.companyId, ID);
      assert.equal(metadata.symbol, '005930');
      assert.deepEqual(company, original);
    }
  }
});

test('KRX logo exchange rejects mismatched, inactive or incompatible stored TOSS evidence', () => {
  const rawPayload = {
    symbol: '005930',
    market: 'KOSPI',
    currency: 'KRW',
    status: 'ACTIVE',
    securityType: 'STOCK',
  };
  const company = {
    id: ID,
    market: 'KRX',
    symbol: '005930',
    stockMetadata: { companyId: ID, symbol: '005930', rawPayload },
  };
  for (const change of [
    { symbol: '005935' },
    { symbol: undefined },
    { currency: 'USD' },
    { currency: undefined },
    { status: 'DELISTED' },
    { status: undefined },
    { securityType: 'BOND' },
    { securityType: undefined },
    { market: 'KR_ETC' },
    { market: 'NASDAQ' },
    { market: undefined },
  ])
    assert.equal(
      initialCompanyLogoMetadata({
        ...company,
        stockMetadata: { ...company.stockMetadata, rawPayload: { ...rawPayload, ...change } },
      }).exchange,
      null,
    );
  for (const change of [
    { companyId: ADMIN },
    { symbol: '005935' },
    { companyId: undefined },
    { symbol: undefined },
  ])
    assert.equal(
      initialCompanyLogoMetadata({
        ...company,
        stockMetadata: { ...company.stockMetadata, ...change },
      }).exchange,
      null,
    );
  assert.equal(
    initialCompanyLogoMetadata({
      ...company,
      etfMetadata: { companyId: ID, symbol: '005930', securityType: 'ETF' },
    }).exchange,
    null,
  );
  assert.equal(
    initialCompanyLogoMetadata({ id: ID, market: 'KRX', symbol: '005930' }).exchange,
    null,
  );
});

test('explicit company exchange takes precedence over TOSS while share identities remain separate', () => {
  for (const symbol of ['005930', '005935', '0000A0']) {
    const metadata = initialCompanyLogoMetadata({
      id: symbol,
      market: 'KOSPI',
      symbol,
      stockMetadata: {
        companyId: symbol,
        symbol,
        rawPayload: {
          symbol,
          market: 'KOSDAQ',
          currency: 'KRW',
          status: 'ACTIVE',
          securityType: 'STOCK',
        },
      },
    });
    assert.equal(metadata.exchange, 'KOSPI');
    assert.equal(metadata.symbol, symbol);
    assert.equal(metadata.companyId, symbol);
  }
});

test('admin registration validates rights, paths and immutable identity before any write', async () => {
  const state = service();
  await state.api.save(ID, mapping(), ADMIN);
  assert.equal(state.writes.length, 1);
  for (const value of [
    '/logos/../secret.svg',
    'https://example.com/logo.png',
    '/logos/x.svg?x=1',
    '/logos/%2e%2e/x.svg',
  ])
    assert.equal(
      companyLogoMetadataSchema.safeParse({ ...mapping(), localLogo: { ...asset, path: value } })
        .success,
      false,
    );
  for (const change of [
    { license: '' },
    { attribution: '   ' },
    { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'invalid' },
  ])
    assert.equal(
      companyLogoMetadataSchema.safeParse({ ...mapping(), localLogo: { ...asset, ...change } })
        .success,
      false,
    );
  for (const value of [
    { ...mapping(), symbol: 'GOOGL' },
    { ...mapping(), localLogo: { ...asset, rightsReviewed: false } },
    { ...mapping(), localLogo: { ...asset, reviewStatus: 'unreviewed' as const } },
    { ...mapping(), officialDomain: { ...reviewed, value: 'https://www.apple.com/' } },
    { ...mapping(), officialDomain: { ...reviewed, reviewStatus: 'unreviewed' as const } },
  ])
    await assert.rejects(() => state.api.save(ID, value, ADMIN));
  assert.equal(state.writes.length, 1);
});

function context(request: unknown, handler: string): ExecutionContext {
  return {
    getClass: () => CompanyLogoController,
    getHandler: () => CompanyLogoController.prototype[handler as 'save'],
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

test('approved viewer can reserve but cannot register logos; writes require CSRF', async () => {
  const guard = new AdminSessionGuard(
    new Reflector(),
    { getAdmin: async () => ({}) } as never,
    { getMember: async () => ({ role: 'VIEWER', status: 'APPROVED' }) } as never,
  );
  const request = {
    method: 'POST',
    session: { memberId: ID, sessionStartedAt: NOW, csrfToken: 'correct' },
    header: () => 'wrong',
  };
  assert.equal(await guard.canActivate(context(request, 'permit')), true);
  await assert.rejects(
    () => guard.canActivate(context({ ...request, method: 'PATCH' }, 'save')),
    /관측/u,
  );
  assert.throws(
    () => new CsrfGuard(new Reflector()).canActivate(context(request, 'permit')),
    /CSRF/u,
  );
  assert.throws(
    () =>
      new CsrfGuard(new Reflector()).canActivate(context({ ...request, method: 'PATCH' }, 'save')),
    /CSRF/u,
  );
  const controller = new CompanyLogoController(
    {
      save: async () => {
        throw new Error('must not execute');
      },
    } as never,
    {
      resolveId: async () => {
        throw new Error('must not resolve');
      },
    } as never,
  );
  await assert.rejects(() => controller.save(ID, mapping(), request as never), /관리자/u);
});

test('logo requests require a single valid session actor before resolving IDs', async () => {
  const controller = new CompanyLogoController(
    {} as never,
    {
      resolveId: async () => {
        throw new Error('must not resolve');
      },
    } as never,
  );
  for (const session of [{}, { adminId: 'invalid' }, { adminId: ADMIN, memberId: ID }])
    await assert.rejects(() => controller.get('AAPL', { session } as never), /로그인/u);
});

test('controller resolves exact exchange aliases to the existing internal security ID', async () => {
  const resolved: string[] = [];
  const lookedUp: string[] = [];
  const controller = new CompanyLogoController(
    {
      get: async (id: string) => {
        lookedUp.push(id);
        return {};
      },
    } as never,
    {
      resolveId: async (alias: string) => {
        resolved.push(alias);
        return ID;
      },
    } as never,
  );
  for (const alias of ['NASDAQ:AAPL', 'KOSPI:005930', 'NYSE:BRK.B'])
    await controller.get(alias, { session: { memberId: ID } } as never);
  assert.deepEqual(resolved, ['NASDAQ:AAPL', 'KOSPI:005930', 'NYSE:BRK.B']);
  assert.deepEqual(lookedUp, [ID, ID, ID]);
});

test('Redis budget fails closed and reserves atomically over all daily buckets', async () => {
  const sessions = new SessionRuntimeService(loadAppConfig({ NODE_ENV: 'test' }));
  assert.equal(await sessions.consumeCompanyLogoBudget('logoDev', 2), false);
  const calls: Array<{ script: string; keys: string[]; arguments: string[] }> = [];
  let count = 0;
  (sessions as unknown as { client: unknown }).client = {
    isReady: true,
    eval: async (script: string, args: { keys: string[]; arguments: string[] }) => {
      calls.push({ script, ...args });
      return count++ < 2 ? 1 : 0;
    },
  };
  assert.deepEqual(
    await Promise.all([1, 2, 3].map(() => sessions.consumeCompanyLogoBudget('logoDev', 2))),
    [true, true, false],
  );
  assert.equal(calls[0]?.keys.length, 33);
  assert.equal(new Set(calls[0]?.keys).size, 33);
  assert.equal(calls[0]?.arguments[0], '2');
  assert.match(COMPANY_LOGO_BUDGET_SCRIPT, /count >= limit then return 0/u);
  assert.match(COMPANY_LOGO_BUDGET_SCRIPT, /MGET/u);
  (sessions as unknown as { client: unknown }).client = {
    isReady: true,
    eval: async () => {
      throw new Error('offline');
    },
  };
  assert.equal(await sessions.consumeCompanyLogoBudget('logoDev', 2), false);
});

test('public local credits contain rights only, no company identity or provider credentials', async () => {
  const state = service({ mapping: mapping() });
  assert.deepEqual(await state.api.credits(), {
    items: [
      {
        path: asset.path,
        source: asset.source,
        sourceUrl: asset.sourceUrl,
        license: asset.license,
        attribution: asset.attribution,
      },
    ],
  });
});
