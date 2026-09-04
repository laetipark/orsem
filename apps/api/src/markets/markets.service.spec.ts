import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKET_INSTRUMENTS, type MarketInstrument } from '@orsem/contracts';
import { ConnectorHealthEntity, MarketObservationEntity } from '@orsem/database';
import { loadAppConfig } from '../config/app-config';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { convertCryptoQuotes, MarketsService, projectMarketQuote } from './markets.service';

const now = new Date('2026-09-04T12:00:00.000Z');
const instrument = (id: string): MarketInstrument =>
  MARKET_INSTRUMENTS.find((item) => item.id === id)!;
function row(
  id: string,
  value: string,
  overrides: Partial<MarketObservationEntity> = {},
): MarketObservationEntity {
  return Object.assign(
    new MarketObservationEntity(),
    {
      id: 'observation',
      instrumentId: id,
      kind: 'QUOTE',
      period: 'latest',
      value,
      sourceDate: '2026-09-04',
      providerAt: now,
      firstObservedAt: now,
      lastObservedAt: now,
      source: instrument(id).provider,
      sourceUrl: instrument(id).sourceUrl,
      rightsMode: instrument(id).rightsMode,
      referenceValue: null,
      referenceDate: null,
      referenceLabel: null,
      rawMetadataJson: null,
    },
    overrides,
  );
}

test('Treasury yield difference is expressed in bp without a percentage-return label', () => {
  const result = projectMarketQuote(
    instrument('us10y'),
    [
      row('us10y', '4.11', { providerAt: null }),
      row('us10y', '4.00', {
        kind: 'DAILY',
        period: '2026-09-03',
        sourceDate: '2026-09-03',
        providerAt: null,
      }),
    ],
    undefined,
    true,
    now,
  );
  assert.equal(result.change, '11');
  assert.equal(result.changePercent, null);
  assert.equal(result.changeUnit, 'bp');
  assert.equal(result.providerAt, null);
  assert.equal(result.valueDate, '2026-09-04');
});

test('Gold current quote remains available when only the optional history key is absent', () => {
  const health = Object.assign(new ConnectorHealthEntity(), {
    status: 'DEGRADED',
    metadataJson: { quoteStatus: 'HEALTHY', historyStatus: 'UNCONFIGURED' },
  });
  const result = projectMarketQuote(
    instrument('gold'),
    [
      row('gold', '2550'),
      row('gold', '2500', { kind: 'DAILY', period: '2026-09-03', sourceDate: '2026-09-03' }),
    ],
    health,
    true,
    now,
  );
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.changeLabel, '직전 일평균 대비');
  assert.equal(result.changePercent, '2');
});

test('Bithumb conversion uses the separate observed USDKRW rate and stops when FX is stale', () => {
  const crypto = projectMarketQuote(
    instrument('btc'),
    [
      row('btc', '140000', {
        referenceValue: '100000',
        referenceDate: '2026-09-03',
        referenceLabel: '전일 종가(KST) 대비',
      }),
    ],
    undefined,
    true,
    now,
  );
  const fx = projectMarketQuote(
    instrument('usd-krw'),
    [row('usd-krw', '1400')],
    undefined,
    true,
    now,
  );
  const result = convertCryptoQuotes([crypto, fx])[0]!;
  assert.equal(result.convertedValue, '100');
  assert.equal(result.conversionRate, '1400');
  assert.equal(result.conversionAt, now.toISOString());
  assert.equal(result.changePercent, '40');
  assert.equal(convertCryptoQuotes([crypto, { ...fx, status: 'STALE' }])[0]!.convertedValue, null);
});

test('An HTTP refresh cannot make an old provider quote fresh', () => {
  const result = projectMarketQuote(
    instrument('btc'),
    [row('btc', '100', { providerAt: new Date(now.getTime() - 600_000) })],
    undefined,
    true,
    now,
  );
  assert.equal(result.status, 'STALE');
  assert.equal(result.value, '100');
  assert.equal(result.changePercent, null);
});

test('Weekend domestic index quotes retain the last session value without inventing a new trade', () => {
  const weekend = new Date('2026-09-05T12:00:00Z');
  const tradeAt = new Date('2026-09-04T06:30:00Z');
  const result = projectMarketQuote(
    instrument('kospi'),
    [row('kospi', '3000', { providerAt: tradeAt, lastObservedAt: weekend })],
    undefined,
    true,
    weekend,
  );
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.providerAt, tradeAt.toISOString());
  assert.equal(result.message, '최근 거래 시세 · 장 종료');
});

test('Missing or zero comparison bases never produce invented percentage changes', () => {
  const absent = projectMarketQuote(
    instrument('silver'),
    [row('silver', '20')],
    undefined,
    true,
    now,
  );
  const zero = projectMarketQuote(
    instrument('silver'),
    [row('silver', '20', { referenceValue: '0' })],
    undefined,
    true,
    now,
  );
  assert.equal(absent.change, null);
  assert.equal(absent.changePercent, null);
  assert.equal(zero.changePercent, null);
});

test('A Toss quote without provider time shows its observation time without an invented source date or comparison', () => {
  const result = projectMarketQuote(
    instrument('kospi'),
    [
      row('kospi', '3000', { sourceDate: null, providerAt: null }),
      row('kospi', '2900', { kind: 'DAILY', sourceDate: '2026-09-03' }),
    ],
    undefined,
    true,
    now,
  );
  assert.equal(result.value, '3000');
  assert.equal(result.providerAt, null);
  assert.equal(result.valueDate, null);
  assert.equal(result.observedAt, now.toISOString());
  assert.equal(result.changePercent, null);
  assert.match(result.message!, /제공 시각 미확인/u);
});

test('Market region filters preserve global assets only under all and widgets contain no synthetic quotes', async () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  const service = new MarketsService(config, {} as DatabaseRuntimeService);
  const kr = await service.overview('kr');
  const us = await service.overview('us');
  const all = await service.overview('all');
  assert.deepEqual(
    kr.items.map((item) => item.id),
    ['kospi', 'kosdaq', 'usd-krw'],
  );
  assert.deepEqual(
    us.items.map((item) => item.id),
    ['sp500', 'nasdaq', 'us2y', 'us10y'],
  );
  assert.ok(all.items.some((item) => item.id === 'btc'));
  assert.equal(us.items[0]!.status, 'EMBEDDED');
  assert.equal(us.items[0]!.value, null);
  assert.equal((await service.history('gold', '1m')).status, 'NOT_CONFIGURED');
  await assert.rejects(() => service.history('unknown', '1m'), /시장 지표/);
});

function persistedService(
  observations: MarketObservationEntity[],
  health: ConnectorHealthEntity[],
  environment: NodeJS.ProcessEnv = {},
) {
  const reads: Array<{ entity: unknown; options: unknown }> = [];
  const source = {
    getRepository(entity: unknown) {
      return {
        async find(options: { where?: { instrumentId?: string; kind?: string; source?: string } }) {
          reads.push({ entity, options });
          if (entity === ConnectorHealthEntity) return health;
          assert.equal(entity, MarketObservationEntity);
          const where = options.where;
          return observations.filter(
            (item) =>
              !where ||
              Array.isArray(where) ||
              ((!where.instrumentId || item.instrumentId === where.instrumentId) &&
                (!where.kind || item.kind === where.kind) &&
                (!where.source || item.source === where.source)),
          );
        },
        async findOneBy(where: { connector: string }) {
          assert.equal(entity, ConnectorHealthEntity);
          return health.find((item) => item.connector === where.connector) ?? null;
        },
      };
    },
  };
  return {
    service: new MarketsService(loadAppConfig({ NODE_ENV: 'test', ...environment }), {
      requireDataSource: () => source,
    } as unknown as DatabaseRuntimeService),
    reads,
  };
}

function dailyRow(id: string, value: string, at = new Date()): MarketObservationEntity {
  const date = at.toISOString().slice(0, 10);
  return row(id, value, {
    kind: 'DAILY',
    period: date,
    sourceDate: date,
    providerAt: null,
    firstObservedAt: at,
    lastObservedAt: at,
  });
}

test('a failed Toss FX quote does not mark successful sibling indexes stale', () => {
  const health = Object.assign(new ConnectorHealthEntity(), {
    status: 'DEGRADED',
    metadataJson: {
      quoteStatus: 'DEGRADED',
      quoteUnavailableInstruments: ['usd-krw'],
      historyStatus: 'HEALTHY',
      historyUnavailableInstruments: [],
    },
  });
  for (const id of ['kospi', 'kosdaq']) {
    const value = projectMarketQuote(instrument(id), [row(id, '2500')], health, true, now);
    assert.equal(value.status, 'AVAILABLE');
  }
  const stale = projectMarketQuote(
    instrument('usd-krw'),
    [row('usd-krw', '1400')],
    health,
    true,
    now,
  );
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.value, '1400');
  assert.equal(
    projectMarketQuote(instrument('usd-krw'), [], health, true, now).status,
    'UNAVAILABLE',
  );
  assert.equal(projectMarketQuote(instrument('kospi'), [], health, true, now).status, 'WAITING');

  const legacyHealth = Object.assign(new ConnectorHealthEntity(), {
    status: 'FAILED',
    metadataJson: null,
  });
  assert.equal(
    projectMarketQuote(instrument('kospi'), [row('kospi', '2500')], legacyHealth, true, now).status,
    'STALE',
  );
});

test('failed persisted gold history keeps its chart and marks only the affected instrument stale', async () => {
  const observations = [dailyRow('gold', '2550'), dailyRow('silver', '32')];
  const health = Object.assign(new ConnectorHealthEntity(), {
    connector: 'market:gold',
    status: 'DEGRADED',
    metadataJson: {
      quoteStatus: 'HEALTHY',
      quoteUnavailableInstruments: [],
      historyStatus: 'DEGRADED',
      historyUnavailableInstruments: ['gold'],
    },
  });
  const { service, reads } = persistedService(observations, [health], { GOLD_API_KEY: 'test-key' });
  const gold = await service.history('gold', '1m');
  assert.equal(gold.status, 'STALE');
  assert.deepEqual(gold.points, [{ date: observations[0]!.sourceDate, value: '2550' }]);
  assert.match(gold.message!, /지연/u);
  assert.equal(gold.sourceUrl, instrument('gold').sourceUrl);
  assert.equal((await service.history('silver', '1m')).status, 'AVAILABLE');
  assert.equal(reads.length, 2);
});

test('observed FX history uses quote health instead of unrelated index history health', async () => {
  const health = Object.assign(new ConnectorHealthEntity(), {
    connector: 'market:toss',
    status: 'DEGRADED',
    metadataJson: {
      quoteStatus: 'DEGRADED',
      quoteUnavailableInstruments: ['usd-krw'],
      historyStatus: 'HEALTHY',
      historyUnavailableInstruments: [],
    },
  });
  const { service } = persistedService(
    [dailyRow('usd-krw', '1400'), dailyRow('kospi', '2500')],
    [health],
    {
      TOSS_CLIENT_ID: 'test-client',
      TOSS_CLIENT_SECRET: 'test-secret',
    },
  );
  const fx = await service.history('usd-krw', '1m');
  assert.equal(fx.status, 'STALE');
  assert.equal(fx.points[0]?.value, '1400');
  assert.equal((await service.history('kospi', '1m')).status, 'AVAILABLE');
});

test('removed required keys disable footer health while preserving the last stored prices and history', async () => {
  const current = new Date();
  const health = ['market:toss', 'market:eia', 'market:gold'].map((connector) =>
    Object.assign(new ConnectorHealthEntity(), {
      connector,
      status: 'HEALTHY',
      lastSuccessAt: current,
      metadataJson: {
        quoteStatus: 'HEALTHY',
        historyStatus: 'HEALTHY',
      },
    }),
  );
  const observations = [
    row('kospi', '2500', { providerAt: current, lastObservedAt: current }),
    row('wti', '75', { providerAt: null, lastObservedAt: current }),
    dailyRow('wti', '75'),
    row('gold', '2550', { providerAt: current, lastObservedAt: current }),
  ];
  const { service } = persistedService(observations, health);
  const footer = await service.freshness();
  for (const id of ['market:toss', 'market:eia']) {
    const source = footer.find((item) => item.id === id)!;
    assert.equal(source.status, 'DISABLED');
    assert.equal(source.lastSuccessAt, current.toISOString());
    assert.equal(source.message, '연결 설정 필요');
  }
  assert.equal(footer.find((item) => item.id === 'market:gold')?.status, 'HEALTHY');
  const overview = await service.overview();
  for (const id of ['kospi', 'wti']) {
    const quote = overview.items.find((item) => item.id === id)!;
    assert.equal(quote.status, 'NOT_CONFIGURED');
    assert.notEqual(quote.value, null);
  }
  assert.equal(overview.items.find((item) => item.id === 'gold')?.status, 'AVAILABLE');
  const wti = await service.history('wti', '1m');
  assert.equal(wti.status, 'STALE');
  assert.equal(wti.points[0]?.value, '75');
});

test('history ages out when collection stops or the provider keeps returning an old date', async () => {
  const current = new Date();
  const date = current.toISOString().slice(0, 10);
  const cases = [
    dailyRow('us10y', '4.1', new Date(current.getTime() - 8 * 3_600_000)),
    {
      ...dailyRow('us10y', '4.1', current),
      sourceDate: new Date(current.getTime() - 8 * 86_400_000).toISOString().slice(0, 10),
    },
  ];
  const health = Object.assign(new ConnectorHealthEntity(), {
    connector: 'market:treasury',
    status: 'HEALTHY',
    metadataJson: { historyStatus: 'HEALTHY', historyUnavailableInstruments: [] },
  });
  for (const observation of cases) {
    const { service } = persistedService([observation], [health]);
    const history = await service.history('us10y', '1m');
    assert.equal(history.status, 'STALE');
    assert.equal(history.points[0]?.value, '4.1');
  }
  const { service } = persistedService([dailyRow('us10y', '4.1', current)], [health]);
  const fresh = await service.history('us10y', '1m');
  assert.equal(fresh.status, 'AVAILABLE');
  assert.deepEqual(fresh.points, [{ date, value: '4.1' }]);
});
