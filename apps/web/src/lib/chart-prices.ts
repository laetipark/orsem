import type { CandlestickData, Time, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { PricePoint } from '../types';

export function isNoTradePrice(point: PricePoint): boolean {
  return (
    ['TOSS_KR', 'TOSS_US', 'KRX'].includes(point.source) &&
    point.open === 0 &&
    point.high === 0 &&
    point.low === 0 &&
    point.close >= 0 &&
    point.volume === 0
  );
}

export function hasChartCandles(prices: readonly PricePoint[]): boolean {
  return prices.some((point) => !isNoTradePrice(point));
}

export function chartTime(time: string): Time {
  return /^\d{4}-\d{2}-\d{2}$/.test(time)
    ? time
    : (Math.floor(Date.parse(time) / 1000) as UTCTimestamp);
}

const kstTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const kstDateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function chartTimeLabel(time: Time, short = false): string {
  if (typeof time === 'number') {
    return (short ? kstTime : kstDateTime).format(new Date(time * 1000));
  }
  if (typeof time === 'string') return time;
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

export function chartPriceData(
  prices: readonly PricePoint[],
): Array<CandlestickData<Time> | WhitespaceData<Time>> {
  return prices.map((point) => {
    const time = chartTime(point.time);
    // 공급자는 시가·고가·저가와 거래량이 0이어도 공식 종가를 남길 수 있습니다.
    // 타임라인의 원본 종가는 보존하고 존재하지 않는 봉은 만들지 않습니다.
    if (isNoTradePrice(point)) return { time };
    return { time, open: point.open, high: point.high, low: point.low, close: point.close };
  });
}
