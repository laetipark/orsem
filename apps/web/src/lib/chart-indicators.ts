import type { HistogramData, LineData, Time, WhitespaceData } from 'lightweight-charts';
import type { PricePoint } from '../types';
import { chartTime, isNoTradePrice } from './chart-prices';

export type IndicatorPrices = readonly (PricePoint | null | undefined)[];
export type IndicatorLine = Array<LineData<Time> | WhitespaceData<Time>>;
export interface VolumeColors {
  up?: string;
  down?: string;
  unchanged?: string;
}

interface IndicatorBar {
  time: Time | null;
  price: PricePoint | null;
  noTrade: boolean;
}

function assertPeriod(period: number): void {
  if (!Number.isSafeInteger(period) || period < 1) {
    throw new RangeError('Indicator period must be a positive safe integer.');
  }
}

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 사용할 수 없는 행은 지표 계산 이력을 끊으며, 기록이 없는 날짜의 봉은 만들지 않습니다. */
function* indicatorBars(prices: IndicatorPrices): Generator<IndicatorBar> {
  let previousTime = -Infinity;
  let previousSource: string | null = null;
  let timeKind: 'date' | 'instant' | null = null;
  for (const price of prices) {
    const rawTime = price?.time;
    const dateOnly = typeof rawTime === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawTime);
    const instant =
      typeof rawTime === 'string' &&
      /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
        rawTime,
      );
    if (!price || (!dateOnly && !instant) || !validDate(price.time.slice(0, 10))) {
      yield { time: null, price: null, noTrade: false };
      continue;
    }
    const time = chartTime(price.time);
    const key = typeof time === 'number' ? time : Date.parse(`${price.time}T00:00:00.000Z`) / 1000;
    const kind = dateOnly ? 'date' : 'instant';
    if (!Number.isFinite(key) || key <= previousTime || (timeKind && kind !== timeKind)) {
      // 중복·역순 키나 날짜와 시각이 혼합된 키를 차트에 전달하지 않습니다.
      yield { time: null, price: null, noTrade: false };
      continue;
    }
    previousTime = key;
    timeKind = kind;
    if (previousSource !== null && previousSource !== price.source) {
      yield { time: null, price: null, noTrade: false };
    }
    previousSource = price.source;
    const finite = [price.open, price.high, price.low, price.close, price.volume].every(
      Number.isFinite,
    );
    const noTrade = finite && isNoTradePrice(price);
    const validCandle =
      finite &&
      price.volume >= 0 &&
      Math.min(price.open, price.high, price.low, price.close) > 0 &&
      price.low <= Math.min(price.open, price.close) &&
      price.high >= Math.max(price.open, price.close);
    yield { time, price: validCandle || noTrade ? price : null, noTrade };
  }
}

/** SMA는 연속된 유효 봉을 세며, 명시적인 결측이나 소스 변경 뒤에는 다시 시작합니다. */
export function smaSeries(prices: IndicatorPrices, period: number): IndicatorLine {
  assertPeriod(period);
  const result: IndicatorLine = [];
  let window: number[] = [];
  for (const bar of indicatorBars(prices)) {
    if (!bar.price || bar.noTrade) {
      window = [];
      if (bar.time !== null) result.push({ time: bar.time });
      continue;
    }
    window.push(bar.price.close);
    if (window.length > period) window.shift();
    if (window.length < period) {
      result.push({ time: bar.time! });
      continue;
    }
    // 점진적으로 평균을 구해 큰 유한 가격을 합산할 때의 오버플로를 피합니다.
    const value = window.reduce((mean, close, index) => mean + (close - mean) / (index + 1), 0);
    result.push({ time: bar.time!, value });
  }
  return result;
}

/** Wilder RSI에는 period + 1개의 종가가 필요하며, 변동이 전혀 없는 구간은 중립값 50으로 정의합니다. */
export function rsiSeries(prices: IndicatorPrices, period = 14): IndicatorLine {
  assertPeriod(period);
  const result: IndicatorLine = [];
  let previousClose: number | null = null;
  let changes = 0;
  let averageGain = 0;
  let averageLoss = 0;
  for (const bar of indicatorBars(prices)) {
    if (!bar.price || bar.noTrade) {
      previousClose = null;
      changes = 0;
      averageGain = 0;
      averageLoss = 0;
      if (bar.time !== null) result.push({ time: bar.time });
      continue;
    }
    const close = bar.price.close;
    if (previousClose === null) {
      previousClose = close;
      result.push({ time: bar.time! });
      continue;
    }
    const change = close - previousClose;
    previousClose = close;
    changes += 1;
    const divisor = Math.min(changes, period);
    averageGain += (Math.max(change, 0) - averageGain) / divisor;
    averageLoss += (Math.max(-change, 0) - averageLoss) / divisor;
    if (changes < period) {
      result.push({ time: bar.time! });
      continue;
    }
    const value =
      averageLoss === 0
        ? averageGain === 0
          ? 50
          : 100
        : 100 - 100 / (1 + averageGain / averageLoss);
    result.push({ time: bar.time!, value });
  }
  return result;
}

/** 제공된 봉별 거래량만 사용하며, 틱을 합산하거나 누락 값을 만들어내지 않습니다. */
export function volumeSeries(
  prices: IndicatorPrices,
  colors: VolumeColors = {},
): Array<HistogramData<Time> | WhitespaceData<Time>> {
  const result: Array<HistogramData<Time> | WhitespaceData<Time>> = [];
  for (const bar of indicatorBars(prices)) {
    if (bar.time === null) continue;
    if (!bar.price) {
      result.push({ time: bar.time });
      continue;
    }
    const direction =
      bar.noTrade || bar.price.close === bar.price.open
        ? 'unchanged'
        : bar.price.close > bar.price.open
          ? 'up'
          : 'down';
    const defaults = { up: '#28b9a6', down: '#d76d5d', unchanged: '#89979a' };
    result.push({
      time: bar.time,
      value: bar.price.volume,
      color: colors[direction] ?? defaults[direction],
    });
  }
  return result;
}
