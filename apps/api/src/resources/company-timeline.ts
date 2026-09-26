import {
  candleSourceSchema,
  displayDisclosureText,
  type CandleSource,
  type Company,
  type CompanyTimeline,
  type EventSummaryView,
  type RightsMode,
} from '@orsem/contracts';
import { dateToIso, type PriceBarEntity } from '@orsem/database';
import { kstDateFromInstant } from '../common/kst-date';

export function mapTimelinePrice(
  row: PriceBarEntity,
  interval: CompanyTimeline['interval'],
): CompanyTimeline['prices'][number] {
  return {
    time:
      interval === '1m'
        ? row.barAt.toISOString()
        : (row.sessionDate ?? kstDateFromInstant(row.barAt.toISOString())!),
    sessionDate: row.sessionDate ?? kstDateFromInstant(row.barAt.toISOString())!,
    observedAt: dateToIso(row.observedAt),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    source: candleSourceSchema.parse(row.source),
    rightsMode: row.rightsMode,
  };
}

/** Assemble the public timeline from stored prices and visible event summaries. */
export function buildCompanyTimeline({
  company,
  configured,
  interval,
  prices,
  indicatorWarmupPrices,
  events,
}: {
  company: Company;
  configured: boolean;
  interval: CompanyTimeline['interval'];
  prices: CompanyTimeline['prices'];
  indicatorWarmupPrices: CompanyTimeline['prices'];
  events: readonly EventSummaryView[];
}): CompanyTimeline {
  const isUs = ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market);
  const priceSources = [
    ...new Map(
      prices.map((price) => [price.source, priceSourceMetadata(price.source, price.rightsMode)]),
    ).values(),
  ];
  const markerSeeds: Array<{
    time: string;
    kind: 'TRADE' | 'FILING' | 'NEWS';
    eventId: string;
    label: string;
    detailType: EventSummaryView['detailType'];
  }> = [];
  for (const event of events) {
    if (!event.rceptDate) {
      if (event.detailType === 'SEC') continue;
      const time = kstDateFromInstant(event.publishedAt);
      if (time) {
        markerSeeds.push({
          time,
          kind: 'NEWS',
          eventId: event.id,
          label: 'N · 뉴스·IR',
          detailType: event.detailType,
        });
      }
      continue;
    }
    // D005의 eventAt은 실제 거래일이 아닌 계획 시작일입니다.
    // D001/D002의 실제 변동일에만 사건·거래 마커를 표시합니다.
    if (event.eventAt && (event.detailType === 'D001' || event.detailType === 'D002')) {
      markerSeeds.push({
        time: event.eventAt,
        kind: 'TRADE',
        eventId: event.id,
        label: event.detailType === 'D002' ? 'T · 거래·변동일' : 'E · 지분변동일',
        detailType: event.detailType,
      });
    }
    markerSeeds.push({
      time: event.rceptDate,
      kind: 'FILING',
      eventId: event.id,
      label: `F · ${displayDisclosureText(event.detailType)}`,
      detailType: event.detailType,
    });
  }
  const markers = markerSeeds
    .map((marker) => ({
      ...marker,
      returnWindows: timelineReturnWindows(prices, marker.time),
    }))
    .sort(
      (left, right) => left.time.localeCompare(right.time) || left.kind.localeCompare(right.kind),
    );
  // 수익률 계산에서 분봉을 거래일 단위로 취급하지 않습니다.
  const dailyPrices = interval === '1d' ? prices : [];
  const latest = dailyPrices.at(-1);
  const previous = dailyPrices.at(-2);
  const monthBase = dailyPrices.at(Math.max(0, dailyPrices.length - 22));
  const latestEventTime = markers.at(-1)?.time;
  const latestEventIndex = latestEventTime
    ? dailyPrices.findIndex((price) => price.time >= latestEventTime)
    : -1;
  return {
    companyId: company.id,
    currency: isUs ? 'USD' : 'KRW',
    provider: 'toss',
    interval,
    status: !configured ? 'NOT_CONFIGURED' : prices.length ? 'READY' : 'PENDING',
    prices,
    indicatorWarmupPrices,
    priceSources,
    markers,
    returns: {
      oneDay: percentageReturn(previous?.close, latest?.close),
      oneMonth: percentageReturn(monthBase?.close, latest?.close),
      sinceLatestEvent:
        latestEventIndex >= 0
          ? percentageReturn(dailyPrices[latestEventIndex]?.close, latest?.close)
          : null,
      benchmarkOneMonth: null,
    },
    latestCloseAt: prices.at(-1)?.time ?? null,
  };
}

function percentageReturn(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined || after === undefined || before === 0) return null;
  return ((after - before) / before) * 100;
}

function timelineReturnWindows(
  prices: readonly { time: string; close: number }[],
  markerDate: string,
): { pre1d: number | null; post1d: number | null; post5d: number | null; post20d: number | null } {
  const index = prices.findIndex((price) => price.time >= markerDate);
  if (index < 0) return { pre1d: null, post1d: null, post5d: null, post20d: null };
  const base = prices[index]?.close;
  return {
    pre1d: percentageReturn(prices[index - 1]?.close, base),
    post1d: percentageReturn(base, prices[index + 1]?.close),
    post5d: percentageReturn(base, prices[index + 5]?.close),
    post20d: percentageReturn(base, prices[index + 20]?.close),
  };
}

function priceSourceMetadata(source: CandleSource, rightsMode: RightsMode) {
  return {
    source,
    sourceName: '토스증권 Open API',
    rightsMode,
    feed: 'REST 캔들',
    adjustment: 'RAW',
    attribution: '출처: 토스증권 Open API',
    limitation:
      '비조정 가격입니다. 개인 화면에만 표시하며, 실시간 체결과 캔들의 집계 범위는 다를 수 있습니다.',
  };
}
