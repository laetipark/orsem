import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';

export interface IndicatorObservation {
  instrumentId: string;
  kind: 'QUOTE' | 'DAILY';
  period: string;
  value: string;
  sourceDate: string | null;
  providerAt: Date | null;
  referenceValue?: string | null;
  referenceDate?: string | null;
  referenceLabel?: string | null;
  raw: Record<string, unknown>;
}

const record = z.record(z.string(), z.unknown());
const numeric = z.union([z.string(), z.number()]).transform((value, context) => {
  const raw = String(value);
  if (!/^-?\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(Number(raw)) || raw.length > 38) {
    context.addIssue({ code: 'custom', message: 'Invalid decimal observation' });
    return z.NEVER;
  }
  return raw;
});
const positive = numeric.refine((value) => Number(value) > 0);
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((date) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  });

export function sessionDate(at: Date, timezone = 'Asia/Seoul'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function instant(value: unknown, now: Date): Date {
  const input = z
    .union([z.string().datetime({ offset: true }), z.number().int().positive()])
    .parse(value);
  const at = new Date(input);
  if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 60_000) {
    throw new Error('Invalid provider time');
  }
  return at;
}

function day(value: unknown, now: Date): string {
  const parsed = dateOnly.parse(value);
  if (parsed > sessionDate(now)) throw new Error('Future observation date');
  return parsed;
}

function quote(
  instrumentId: string,
  value: string,
  at: Date | null,
  raw: Record<string, unknown>,
): IndicatorObservation {
  return {
    instrumentId,
    kind: 'QUOTE',
    period: 'latest',
    value,
    sourceDate: at ? sessionDate(at) : null,
    providerAt: at,
    raw,
  };
}

export function parseTossIndicators(input: unknown, now: Date): IndicatorObservation[] {
  const rows = z.object({ result: z.array(record).max(2) }).parse(input).result;
  const seen = new Set<string>();
  return rows.map((raw) => {
    const symbol = z.enum(['KOSPI', 'KOSDAQ']).parse(raw.symbol);
    if (seen.has(symbol)) throw new Error('Duplicate market indicator');
    seen.add(symbol);
    return quote(
      symbol.toLowerCase(),
      positive.parse(raw.lastPrice),
      raw.timestamp == null ? null : instant(raw.timestamp, now),
      raw,
    );
  });
}

export function parseTossFx(input: unknown, now: Date): IndicatorObservation[] {
  const raw = z.object({ result: record }).parse(input).result;
  if (raw.baseCurrency !== 'USD' || raw.quoteCurrency !== 'KRW')
    throw new Error('Unexpected FX direction');
  const row = quote('usd-krw', positive.parse(raw.rate), instant(raw.validFrom, now), raw);
  // This is an observed daily point, not an invented historical market close.
  return [
    row,
    {
      ...row,
      kind: 'DAILY',
      period: row.sourceDate!,
      raw: { ...raw, aggregation: 'OBSERVED_LAST' },
    },
  ];
}

export function parseTossDaily(
  input: unknown,
  instrumentId: 'kospi' | 'kosdaq',
  now: Date,
): {
  rows: IndicatorObservation[];
  nextBefore: string | null;
} {
  const page = z
    .object({
      result: z.object({
        candles: z.array(record).max(200),
        nextBefore: z.string().datetime({ offset: true }).nullish(),
      }),
    })
    .parse(input).result;
  return {
    rows: page.candles.map((raw) => {
      const at = instant(raw.timestamp, now);
      const sourceDate = sessionDate(at);
      return {
        instrumentId,
        kind: 'DAILY',
        period: sourceDate,
        sourceDate,
        providerAt: at,
        value: positive.parse(raw.closePrice),
        raw,
      };
    }),
    nextBefore: page.nextBefore ?? null,
  };
}

export function parseBithumbQuotes(input: unknown, now: Date): IndicatorObservation[] {
  const seen = new Set<string>();
  return z
    .array(record)
    .max(2)
    .parse(input)
    .map((raw) => {
      const market = z.enum(['KRW-BTC', 'KRW-ETH']).parse(raw.market);
      if (seen.has(market)) throw new Error('Duplicate Bithumb market');
      seen.add(market);
      // Ticker's explicit UTC/KST fields are authoritative. Some responses encode
      // trade_timestamp with a nine-hour offset; retain it raw, never guess an offset.
      const time = bithumbTradeTime(raw, now);
      const row = quote(
        market === 'KRW-BTC' ? 'btc' : 'eth',
        positive.parse(raw.trade_price),
        time.at,
        { ...raw, normalizedTimeField: time.field },
      );
      // Bithumb defines prev_closing_price at KST midnight, unlike UTC-based venues.
      const referenceDate = new Date(
        new Date(`${row.sourceDate!}T00:00:00Z`).getTime() - 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
      return {
        ...row,
        referenceValue: positive.parse(raw.prev_closing_price),
        referenceLabel: '빗썸 전일 종가(KST) 대비',
        referenceDate,
      };
    });
}

function bithumbTradeTime(raw: Record<string, unknown>, now: Date): { at: Date; field: string } {
  function fromFields(date: unknown, time: unknown, offset: string): Date {
    const dateInput = z
      .string()
      .regex(/^\d{8}$/u)
      .parse(date);
    const timeInput = z
      .string()
      .regex(/^\d{6}$/u)
      .parse(time);
    const sourceDate = dateOnly.parse(
      `${dateInput.slice(0, 4)}-${dateInput.slice(4, 6)}-${dateInput.slice(6, 8)}`,
    );
    return instant(
      `${sourceDate}T${timeInput.slice(0, 2)}:${timeInput.slice(2, 4)}:${timeInput.slice(4, 6)}${offset}`,
      now,
    );
  }
  const utc =
    raw.trade_date != null || raw.trade_time != null
      ? fromFields(raw.trade_date, raw.trade_time, 'Z')
      : null;
  const kst =
    raw.trade_date_kst != null || raw.trade_time_kst != null
      ? fromFields(raw.trade_date_kst, raw.trade_time_kst, '+09:00')
      : null;
  if (utc && kst && utc.getTime() !== kst.getTime())
    throw new Error('Inconsistent Bithumb trade times');
  if (utc) return { at: utc, field: 'trade_date/trade_time (UTC)' };
  if (kst) return { at: kst, field: 'trade_date_kst/trade_time_kst (KST)' };
  return { at: instant(raw.trade_timestamp, now), field: 'trade_timestamp' };
}

export function parseBithumbDaily(
  input: unknown,
  instrumentId: 'btc' | 'eth',
  now: Date,
): {
  rows: IndicatorObservation[];
  nextBefore: string | null;
} {
  const market = instrumentId === 'btc' ? 'KRW-BTC' : 'KRW-ETH';
  const records = z.array(record).max(200).parse(input);
  const rows = records.map((raw): IndicatorObservation => {
    if (raw.market !== market) throw new Error('Unexpected Bithumb market');
    const kst = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u)
      .parse(raw.candle_date_time_kst);
    const at = instant(`${kst}+09:00`, now);
    const sourceDate = day(kst.slice(0, 10), now);
    return {
      instrumentId,
      kind: 'DAILY',
      period: sourceDate,
      sourceDate,
      providerAt: at,
      value: positive.parse(raw.trade_price),
      raw,
    };
  });
  const earliest = [...records].sort((a, b) =>
    String(a.candle_date_time_kst).localeCompare(String(b.candle_date_time_kst)),
  )[0];
  return { rows, nextBefore: earliest ? String(earliest.candle_date_time_kst) : null };
}

export function parseTreasury(input: string, now: Date): IndicatorObservation[] {
  if (/<!DOCTYPE|<!ENTITY/iu.test(input) || XMLValidator.validate(input) !== true)
    throw new Error('Invalid Treasury XML');
  const parsed: unknown = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    ignoreAttributes: false,
  }).parse(input);
  const feed = z
    .object({ feed: z.object({ entry: z.union([record, z.array(record)]).optional() }) })
    .parse(parsed).feed;
  const rows: IndicatorObservation[] = [];
  for (const entry of feed.entry ? (Array.isArray(feed.entry) ? feed.entry : [feed.entry]) : []) {
    const props = z.object({ properties: record }).parse(entry.content).properties;
    const dateValue =
      typeof props.NEW_DATE === 'object' && props.NEW_DATE !== null
        ? (props.NEW_DATE as Record<string, unknown>)['#text']
        : props.NEW_DATE;
    const sourceDate = day(z.string().parse(dateValue).slice(0, 10), now);
    for (const [instrumentId, field] of [
      ['us2y', 'BC_2YEAR'],
      ['us10y', 'BC_10YEAR'],
    ] as const) {
      const inputValue = props[field];
      // XML empty/m:null is missing data, never a zero yield.
      const value =
        typeof inputValue === 'object' && inputValue !== null
          ? (inputValue as Record<string, unknown>)['#text']
          : inputValue;
      if (value === undefined || value === null || value === '') continue;
      rows.push({
        instrumentId,
        kind: 'DAILY',
        period: sourceDate,
        sourceDate,
        providerAt: null,
        value: numeric.parse(value),
        raw: props,
      });
    }
  }
  return rows;
}

export function parseGoldQuote(
  input: unknown,
  instrumentId: 'gold' | 'silver',
  now: Date,
): IndicatorObservation[] {
  const raw = record.parse(input);
  if (
    raw.symbol !== (instrumentId === 'gold' ? 'XAU' : 'XAG') ||
    (raw.currency !== undefined && raw.currency !== 'USD')
  )
    throw new Error('Unexpected metal unit');
  const row = quote(instrumentId, positive.parse(raw.price), instant(raw.updatedAt, now), raw);
  return [{ ...row, sourceDate: row.providerAt!.toISOString().slice(0, 10) }];
}

export function parseGoldHistory(
  input: unknown,
  instrumentId: 'gold' | 'silver',
  now: Date,
): IndicatorObservation[] {
  return z
    .array(record)
    .max(400)
    .parse(input)
    .map((raw) => {
      // groupBy=day can return a date-only label or "YYYY-MM-DD 00:00:00".
      // The latter is a period label, not a provider publication instant.
      const sourceDate = day(
        z
          .string()
          .parse(raw.day)
          .replace(/ 00:00:00$/u, ''),
        now,
      );
      return {
        instrumentId,
        kind: 'DAILY',
        period: sourceDate,
        sourceDate,
        providerAt: null,
        value: positive.parse(raw.avg_price),
        raw: { ...raw, aggregation: 'DAILY_AVERAGE' },
      };
    });
}

export function parseEia(input: unknown, now: Date): IndicatorObservation[] {
  const rows = z.object({ response: z.object({ data: z.array(record).max(5000) }) }).parse(input)
    .response.data;
  return rows
    .filter((raw) => raw.value !== null && raw.value !== undefined && raw.value !== '')
    .map((raw) => {
      const sourceDate = day(raw.period, now);
      // EIA's v2 seriesid response may expose either the legacy series name or RWTC.
      if (raw.series !== undefined && raw.series !== 'RWTC' && raw.series !== 'PET.RWTC.D')
        throw new Error('Unexpected EIA series');
      if (
        raw['value-units'] !== undefined &&
        !['Dollars per Barrel', '$/BBL', 'Dollars per barrel'].includes(String(raw['value-units']))
      )
        throw new Error('Unexpected EIA unit');
      return {
        instrumentId: 'wti',
        kind: 'DAILY',
        period: sourceDate,
        sourceDate,
        providerAt: null,
        value: numeric.parse(raw.value),
        raw,
      };
    });
}
