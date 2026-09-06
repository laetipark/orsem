import { describe, expect, it } from 'vitest';
import type { CompanyLivePrice } from '../types';
import { domesticFallbackClose, effectiveLiveStatus } from './live-price';

const snapshot: CompanyLivePrice = {
  companyId: 'company',
  provider: 'toss',
  status: 'LIVE',
  asOf: '2026-09-04T00:30:02Z',
  quote: {
    symbol: '005930',
    source: 'TOSS_KR_INTEGRATED',
    currency: 'KRW',
    price: '70000',
    providerAt: '2026-09-04T00:30:00Z',
    observedAt: '2026-09-04T00:30:01Z',
    rightsMode: 'PRIVATE_DISPLAY_ONLY',
    lossy: true,
  },
};

describe('live quote freshness', () => {
  it('expires cached LIVE data even when the network pauses without an error', () => {
    expect(effectiveLiveStatus(snapshot, false, 1_000)).toBe('LIVE');
    expect(effectiveLiveStatus(snapshot, true, 1_000)).toBe('UNAVAILABLE');
    expect(effectiveLiveStatus(snapshot, false, 14_000)).toBe('STALE');
  });
  it('preserves server status and requires an actual quote', () => {
    expect(
      effectiveLiveStatus({ ...snapshot, status: 'NOT_CONFIGURED', quote: null }, false, 0),
    ).toBe('NOT_CONFIGURED');
    expect(effectiveLiveStatus({ ...snapshot, quote: null }, false, 0)).toBe('WAITING');
  });
});

describe('domestic closing-price fallback', () => {
  const fridayClose = {
    price: '71000',
    currency: 'KRW',
    sessionDate: '2026-09-04',
    source: 'TOSS_KR',
  } as const;
  const weekend = Date.parse('2026-09-05T03:00:00Z');

  it.each(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'])(
    'uses the supplied latest trading close when %s has no quote',
    (market) => {
      expect(
        domesticFallbackClose({ quote: null, fallbackClose: fridayClose }, market, weekend),
      ).toBe(fridayClose);
    },
  );

  it('replaces a prior-day quote even if it was collected today', () => {
    expect(
      domesticFallbackClose(
        {
          quote: { ...snapshot.quote!, observedAt: '2026-09-05T03:00:00Z' },
          fallbackClose: fridayClose,
        },
        'KOSPI',
        weekend,
      ),
    ).toBe(fridayClose);
  });

  it.each(['LIVE', 'STALE'] as const)(
    'keeps today’s %s quote at the KST date boundary',
    (status) => {
      const data = {
        ...snapshot,
        status,
        quote: { ...snapshot.quote!, providerAt: '2026-09-04T15:00:00Z' },
        fallbackClose: fridayClose,
      };
      expect(domesticFallbackClose(data, 'KOSPI', weekend)).toBeNull();
    },
  );

  it('keeps the actual date over weekends and holidays without calculating a new close', () => {
    const thursdayClose = { ...fridayClose, sessionDate: '2026-09-03' };
    expect(
      domesticFallbackClose({ quote: null, fallbackClose: thursdayClose }, 'KOSPI', weekend),
    ).toBe(thursdayClose);
  });

  it('does not infer a close from missing data, current-day candles, or unknown and US markets', () => {
    expect(domesticFallbackClose(snapshot, 'KOSPI', weekend)).toBeNull();
    expect(domesticFallbackClose(undefined, 'KOSPI', weekend)).toBeNull();
    for (const market of ['NASDAQ', 'NYSE', 'UNKNOWN']) {
      expect(
        domesticFallbackClose({ quote: null, fallbackClose: fridayClose }, market, weekend),
      ).toBeNull();
    }
    expect(
      domesticFallbackClose(
        { quote: null, fallbackClose: { ...fridayClose, sessionDate: '2026-09-05' } },
        'KOSPI',
        weekend,
      ),
    ).toBeNull();
    expect(
      domesticFallbackClose(
        { quote: { ...snapshot.quote!, currency: 'USD' }, fallbackClose: fridayClose },
        'KOSPI',
        weekend,
      ),
    ).toBeNull();
  });
});
