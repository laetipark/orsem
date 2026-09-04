import { describe, expect, it } from 'vitest';
import type { CompanyLivePrice } from '../types';
import { effectiveLiveStatus } from './live-price';

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
