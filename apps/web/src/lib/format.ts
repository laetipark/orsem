const kstDateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const kstDate = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatKst(value: string | null | undefined): string {
  if (!value) return '—';
  return `${kstDateTime.format(new Date(value))} KST`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00+09:00`)
    : new Date(value);
  return kstDate.format(date);
}

export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const numeric = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(numeric) ? new Intl.NumberFormat('ko-KR').format(numeric) : String(value);
}

export function formatMoney(
  value: number | string | null,
  currency: 'KRW' | 'USD' | null = 'KRW',
): string {
  if (value === null) return '—';
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: currency ?? 'KRW',
    maximumFractionDigits: currency === 'USD' ? 4 : 0,
  }).format(numeric);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function formatLag(seconds: number | null): string {
  if (seconds === null) return '확인 전';
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  return `${Math.floor(seconds / 3600)}시간 전`;
}

export const natureLabels: Record<string, string> = {
  MARKET_BUY: '장내매수',
  MARKET_SELL: '장내매도',
  BLOCK_BUY: '시간외·블록 매수',
  BLOCK_SELL: '시간외·블록 매도',
  OFF_MARKET_BUY: '장외매수',
  OFF_MARKET_SELL: '장외매도',
  AFTER_HOURS_BUY: '시간외매수',
  AFTER_HOURS_SELL: '시간외매도',
  STOCK_COMPENSATION: '주식 보상',
  NEW_SHARE_SUBSCRIPTION: '신주 인수',
  SECURITIES_SUBSCRIPTION: '증권 인수',
  STOCK_LENDING: '주식 대차',
  REPORTING_STATUS_CHANGE: '보고자 지위 변경',
  RIGHTS_CHANGE: '권리 변경',
  STOCK_DIVIDEND: '주식 배당',
  CAPITAL_REDUCTION: '감자',
  GIFT_CANCELLATION: '증여 취소',
  TENDER_OFFER_APPLICATION: '공개매수 응모',
  GIFT_IN: '수증',
  GIFT_OUT: '증여',
  OPTION_EXERCISE: '주식매수선택권 행사',
  RSU_RSA: 'RSU·RSA',
  CONVERSION: '전환·권리 행사',
  STOCK_SPLIT_MERGER: '합병·분할',
  TRUST_TRANSFER: '신탁 이전',
  INHERITANCE: '상속',
  OTHER: '기타',
  UNKNOWN: '확인 필요',
};
