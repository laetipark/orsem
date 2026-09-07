import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorHealthEntity, SourceCheckpointEntity } from '@orsem/database';
import type { DataSource } from 'typeorm';
import { adminNewsSourceViews } from './news-operations';

test('private provider diagnostics expose budgets and hashed cursors without raw errors or credentials', async () => {
  const database = {
    getRepository(entity: unknown) {
      if (entity === ConnectorHealthEntity)
        return {
          find: async () => [
            {
              connector: 'marketaux',
              status: 'DEGRADED',
              message: 'secret-api-key',
              metadataJson: {
                enabled: true,
                httpStatus: 401,
                dailyRequestBudget: 50,
                apiKey: 'secret-api-key',
              },
            },
          ],
        };
      if (entity === SourceCheckpointEntity)
        return {
          find: async () => [
            {
              connector: 'MARKETAUX',
              stream: 'NEWS_API_BUDGET',
              metadataJson: {
                reservations: [Date.now() - 1000, Date.now() - 25 * 3600_000],
                rollingRequestCount: 2,
              },
            },
            {
              connector: 'MARKETAUX',
              stream: 'NEWS:test',
              cursor: 'opaque-secret-token',
              metadataJson: {},
            },
          ],
        };
      return { findBy: async () => [{ connector: 'MARKETAUX', requestCount: '3' }] };
    },
  } as unknown as DataSource;
  const views = await adminNewsSourceViews(database);
  const marketaux = views.find((row) => row.id === 'marketaux');
  assert.equal(marketaux?.enabled, false);
  assert.equal(marketaux?.rightsStatus, 'UNKNOWN');
  assert.equal(marketaux?.dailyRequestCount, 3);
  assert.equal(marketaux?.dailyRequestBudget, 50);
  assert.equal(marketaux?.rollingRequestCount, 1);
  assert.match(String(marketaux?.lastCursor), /^sha256:/);
  assert.equal(marketaux?.lastError, '인증 오류');
  assert.doesNotMatch(JSON.stringify(views), /secret-api-key|opaque-secret-token|apiKey/);
});
