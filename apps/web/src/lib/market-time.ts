import type { MarketQuote } from '../types';
import { formatDate, formatKst } from './format';

const compactKst = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function shortMarketTimestamp(value: string): string {
  const parts = compactKst.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value;
  return `${part('month')}.${part('day')} ${part('hour')}:${part('minute')} KST`;
}

export function marketSourceTime(item: MarketQuote): string | null {
  if (item.providerAt) return `자료 기준 ${formatKst(item.providerAt)}`;
  if (item.valueDate) return `자료 기준 ${formatDate(item.valueDate)}`;
  return null;
}

export function marketCollectionTime(item: MarketQuote) {
  const timestamp = item.observedAt ? formatKst(item.observedAt) : null;
  const label = timestamp ? `수집 기준 시각 ${timestamp}` : '수집 시각 확인 전';
  return {
    timestamp,
    label,
    description: [label, marketSourceTime(item), `출처 ${item.provider}`]
      .filter(Boolean)
      .join(' · '),
  };
}

export function marketCardTime(item: MarketQuote) {
  const description = marketCollectionTime(item).description;
  if (item.providerAt)
    return {
      text: shortMarketTimestamp(item.providerAt).replace(' KST', ''),
      dateTime: item.providerAt,
      description,
    };
  if (item.valueDate)
    return {
      text: item.valueDate.slice(5).replace('-', '.'),
      dateTime: item.valueDate,
      description,
    };
  if (item.observedAt)
    return {
      text: shortMarketTimestamp(item.observedAt).replace(' KST', ''),
      dateTime: item.observedAt,
      description: `${description} · 공급자 기준 시각 미확인`,
    };
  return { text: null, dateTime: undefined, description };
}
