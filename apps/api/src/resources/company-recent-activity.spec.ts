import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { loadAppConfig } from '../config/app-config';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import type { SessionRuntimeService } from '../security/session-runtime.service';
import { CompanyObservationService } from '../watchlist-groups/company-observation.service';
import { recentKstWindow } from '../watchlist-groups/watchlist-group-observations';
import { CompaniesController } from './resource.controllers';
import type { OrsemDataService } from './orsem-data.service';

const companyId = '11111111-1111-4111-8111-111111111111';

function controller() {
  const observed: Array<{ id: string; limit: number }> = [];
  const companyReads: string[] = [];
  const value = new CompaniesController(
    {
      getCompany: async (id: string) => {
        companyReads.push(id);
        if (id !== companyId) throw new NotFoundException();
        return { id };
      },
    } as unknown as OrsemDataService,
    {} as never,
    {} as never,
    {
      recent: async (id: string, limit: number) => {
        observed.push({ id, limit });
        return { filingCount: 0, eventCount: 0, items: [] };
      },
    } as unknown as CompanyObservationService,
  );
  return { value, observed, companyReads };
}

test('company recent activity keeps the three-item default and accepts one through twenty', async () => {
  const { value, observed } = controller();
  await value.recentActivity(companyId, {});
  await value.recentActivity(companyId, { limit: '1' });
  await value.recentActivity(companyId, { limit: '20' });
  assert.deepEqual(observed, [
    { id: companyId, limit: 3 },
    { id: companyId, limit: 1 },
    { id: companyId, limit: 20 },
  ]);
});

test('invalid or repeated activity limits return HTTP 400 before loading a company or activity', async () => {
  const { value, observed, companyReads } = controller();
  for (const limit of [
    '0',
    '-1',
    '21',
    '1.5',
    'NaN',
    'Infinity',
    '',
    '1e1',
    ['1', '2'],
    true,
    null,
  ]) {
    await assert.rejects(
      value.recentActivity(companyId, { limit }),
      (error: unknown) => error instanceof BadRequestException && error.getStatus() === 400,
    );
  }
  assert.deepEqual(observed, []);
  assert.deepEqual(companyReads, []);
});

test('a larger limit does not bypass the existing company existence check', async () => {
  const { value, observed } = controller();
  await assert.rejects(
    value.recentActivity('22222222-2222-4222-8222-222222222222', { limit: '20' }),
    NotFoundException,
  );
  assert.deepEqual(observed, []);
});

test('activity limits preserve seven KST dates, distinct counts and deduplication while expanding the list', async () => {
  const window = recentKstWindow(new Date('2026-08-31T15:00:00Z'));
  const limits: number[] = [];
  const manager = {
    async query(sql: string, args: unknown[]) {
      assert.match(sql, /WHERE rn<=\?/u);
      const limit = Number(args.at(-1));
      limits.push(limit);
      assert.deepEqual(args, [
        companyId,
        '2026-08-26',
        '2026-09-01',
        '2026-08-25 15:00:00.000',
        '2026-09-01 15:00:00.000',
        '2026-08-26',
        '2026-09-01',
        '2026-08-25 15:00:00.000',
        '2026-09-01 15:00:00.000',
        limit,
      ]);
      // Represent ranked results for both kinds. A filing already reflected in an event
      // contributes to its own count but must not appear as an extra displayed item.
      return [
        {
          id: 'older-filing',
          company_id: companyId,
          kind: 'FILING',
          title: '별도 공시',
          date: '2026-08-31',
          eventDate: null,
          displayable: '1',
          kindCount: '2',
          url: 'https://www.sec.gov/Archives/other.htm',
        },
        ...(limit > 1
          ? [
              {
                id: 'filing-covered-by-event',
                company_id: companyId,
                kind: 'FILING',
                title: '이미 이벤트에 포함된 공시',
                date: '2026-09-01',
                eventDate: null,
                displayable: '0',
                kindCount: '2',
                url: 'https://www.sec.gov/Archives/example.htm',
              },
            ]
          : []),
        ...Array.from({ length: limit }, (_, index) => ({
          id: `event-${String(index).padStart(2, '0')}`,
          company_id: companyId,
          kind: 'EVENT',
          title: `합성 이벤트 ${index}`,
          date: '2026-09-01',
          eventDate: '2026-08-01',
          displayable: '1',
          kindCount: '25',
          url: '/events/unused',
        })),
      ];
    },
  } as unknown as EntityManager;
  const service = new CompanyObservationService(
    {} as DatabaseRuntimeService,
    {} as SessionRuntimeService,
    loadAppConfig({ NODE_ENV: 'test' }),
  );
  for (const limit of [undefined, 1, 20]) {
    const result = (await service.activity(manager, [companyId], window, limit)).get(companyId)!;
    assert.equal(result.filingCount, 2);
    assert.equal(result.eventCount, 25);
    assert.equal(result.items.length, limit ?? 3);
    assert.ok(
      result.items.every((item) => item.kind === 'EVENT' && item.eventDate === '2026-08-01'),
    );
    assert.equal(result.items[0]?.id, `event-${String((limit ?? 3) - 1).padStart(2, '0')}`);
  }
  assert.deepEqual(limits, [3, 1, 20]);
});

test('company recent activity passes its limit into the shared query and keeps empty results explicit', async () => {
  const manager = {
    query: async (_sql: string, args: unknown[]) => {
      assert.equal(args.at(-1), 20);
      return [];
    },
  } as unknown as EntityManager;
  const service = new CompanyObservationService(
    { requireDataSource: () => ({ manager }) } as unknown as DatabaseRuntimeService,
    {} as SessionRuntimeService,
    loadAppConfig({ NODE_ENV: 'test' }),
  );
  const result = await service.recent(companyId, 20);
  assert.equal(result.filingCount, 0);
  assert.equal(result.eventCount, 0);
  assert.deepEqual(result.items, []);
  assert.match(result.windowStartDate, /^\d{4}-\d{2}-\d{2}$/u);
  assert.match(result.windowEndDate, /^\d{4}-\d{2}-\d{2}$/u);
});
