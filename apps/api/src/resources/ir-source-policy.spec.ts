import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { NEWS_IR_SOURCE_PROFILES, RightsMode } from '@orsem/contracts';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from './orsem-data.service';

function context() {
  const fixtures = new FixtureStoreService();
  fixtures.irSources.splice(0);
  return {
    fixtures,
    service: new OrsemDataService(
      loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' }),
      {} as DatabaseRuntimeService,
      fixtures,
    ),
  };
}

test('IR 관리 API는 검토된 Samsung URL만 받고 서버 정책으로 고정한다', async () => {
  const { fixtures, service } = context();
  const companyId = fixtures.companies[0]!.id;
  await assert.rejects(
    () =>
      service.createIrSource({
        companyId,
        url: 'https://example.com/feed.xml',
        sourceType: 'RSS',
        rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
        isActive: true,
      }),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
  );

  const created = await service.createIrSource({
    companyId,
    url: NEWS_IR_SOURCE_PROFILES['samsung-global'].url,
    sourceType: 'RSS',
    rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
    isActive: true,
  });
  assert.equal(created.url, NEWS_IR_SOURCE_PROFILES['samsung-global'].url);
  assert.equal(created.sourceType, 'RSS');
  assert.equal(created.rightsMode, RightsMode.PRIVATE_DISPLAY_ONLY);
  assert.equal(await service.hasCompatibleIrSources(), true);
  const sources = await service.connectorSourceViews();
  const ir = sources.find((source) => source.id === 'ir');
  assert.equal(ir?.name, 'Samsung Global Newsroom');
  assert.equal(ir?.rightsMode, RightsMode.PRIVATE_DISPLAY_ONLY);
  const gdelt = sources.find((source) => source.id === 'gdelt');
  assert.equal(gdelt?.name, 'GDELT 뉴스 링크');
  assert.equal(gdelt?.status, 'DISABLED');

  const updated = await service.updateIrSource(created.id, { isActive: false });
  assert.equal(updated.sourceType, 'RSS');
  assert.equal(updated.rightsMode, RightsMode.PRIVATE_DISPLAY_ONLY);
  assert.equal(updated.isActive, false);
  assert.equal(await service.hasCompatibleIrSources(), false);
  await assert.rejects(
    () => service.updateIrSource(created.id, { url: 'https://example.com/other.xml' } as never),
    (error: unknown) => error instanceof HttpException && error.getStatus() === 400,
  );
});

test('new IR registrations require the matching existing company and remain inactive while rights are unknown', async () => {
  const { fixtures, service } = context();
  const company = fixtures.companies[0]!;
  const profile = NEWS_IR_SOURCE_PROFILES['nvidia-ir-press'];
  await assert.rejects(
    () =>
      service.createIrSource({
        companyId: company.id,
        url: profile.url,
        sourceType: 'RSS',
        rightsMode: profile.policy.rightsMode,
        isActive: false,
      }),
    /상장기업/,
  );
  company.ticker = 'NVDA';
  company.market = 'NASDAQ';
  const registered = await service.createIrSource({
    companyId: company.id,
    url: profile.url,
    sourceType: 'RSS',
    rightsMode: profile.policy.rightsMode,
    isActive: false,
  });
  assert.equal(registered.isActive, false);
  await assert.rejects(
    () => service.updateIrSource(registered.id, { isActive: true }),
    /활성화할 수 없습니다/,
  );
});
