import { WatchPriority } from '@orsem/contracts';
import { discoverLinksJobSchema } from '../src/queues/job-data';
import { allowsExternalRealtime } from '../src/queues/alert-outbox-dispatcher.service';

describe('news discovery and external delivery policy', () => {
  it('accepts only the durable NAVER P3 filing-trigger contract', () => {
    const valid = {
      connectors: ['NAVER'],
      priorities: [WatchPriority.P3],
      companyIds: ['10000000-0000-4000-8000-000000000001'],
      reason: 'DISCLOSURE_TRIGGER',
      triggerFilingId: '20000000-0000-4000-8000-000000000002',
    };
    expect(discoverLinksJobSchema.parse(valid)).toMatchObject(valid);
    expect(
      discoverLinksJobSchema.safeParse({
        ...valid,
        priorities: [WatchPriority.P2],
      }).success,
    ).toBe(false);
    expect(
      discoverLinksJobSchema.safeParse({
        ...valid,
        connectors: ['SEC'],
      }).success,
    ).toBe(false);
  });

  it.each([
    [WatchPriority.P1, true, true],
    [WatchPriority.P2, true, true],
    [WatchPriority.P1, false, false],
    [WatchPriority.P2, false, false],
    [WatchPriority.P3, true, false],
    [WatchPriority.P4, true, false],
  ] as const)('gates priority %s with realtime=%s as %s', (priority, realtimeAlerts, expected) => {
    expect(
      allowsExternalRealtime({
        operational: false,
        priority,
        realtimeAlerts,
      }),
    ).toBe(expected);
  });

  it('keeps company-less operational alerts enabled', () => {
    expect(
      allowsExternalRealtime({
        operational: true,
        priority: null,
        realtimeAlerts: false,
      }),
    ).toBe(true);
  });
});
