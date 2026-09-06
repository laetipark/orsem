type Rational = { numerator: bigint; denominator: bigint };

const MAGNITUDES: Readonly<Record<string, number>> = {
  trillion: 12,
  billion: 9,
  bn: 9,
  million: 6,
  mn: 6,
  thousand: 3,
  조: 12,
  억: 8,
  천만: 7,
  백만: 6,
  만: 4,
  천: 3,
};

function rational(text: string, exponent = 0): Rational {
  const [integer, fraction = ''] = text.replaceAll(',', '').split('.');
  const negative = integer!.startsWith('-');
  return {
    numerator:
      BigInt(`${integer!.replace(/^[-+]/, '')}${fraction}`) *
      (negative ? -1n : 1n) *
      10n ** BigInt(exponent),
    denominator: 10n ** BigInt(fraction.length),
  };
}

function rationalKey(value: Rational): string {
  let a = value.numerator < 0n ? -value.numerator : value.numerator;
  let b = value.denominator;
  while (b !== 0n) [a, b] = [b, a % b];
  return `${value.numerator / a}/${value.denominator / a}`;
}

function normalizeMixedFractions(text: string): string {
  return text.replace(
    /(?<![\w./])([-+]?\d+)[ -](\d+)\/(\d+)(?![\w/])/g,
    (match, whole: string, numerator: string, denominator: string) => {
      const bottom = Number(denominator);
      const top = Number(numerator);
      // Only proper, finite decimal fractions; do not reinterpret 3/4 dates or 3-4 ranges.
      if (!Number.isInteger(bottom) || bottom < 2 || bottom > 100 || top <= 0 || top >= bottom)
        return match;
      let remainder = bottom;
      while (remainder % 2 === 0) remainder /= 2;
      while (remainder % 5 === 0) remainder /= 5;
      if (remainder !== 1) return match;
      let scale = 1n;
      let places = 0;
      while (scale % BigInt(bottom) !== 0n) {
        scale *= 10n;
        places += 1;
      }
      const fraction = ((BigInt(top) * scale) / BigInt(bottom))
        .toString()
        .padStart(places, '0')
        .replace(/0+$/, '');
      return `${whole}.${fraction}`;
    },
  );
}

function normalizePercentRanges(text: string): string {
  return text.replace(
    /(?<![\w./])([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*(%|percent\b|퍼센트))?\s*(?:to\b|through\b|[-~–—]|에서)\s*([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*(%|percent\b|퍼센트))(?![\w/]|\.\d)/gi,
    (_match, first: string, _firstUnit: string | undefined, last: string) =>
      `${first}% to ${last}%`,
  );
}

function calendarFacts(text: string): { text: string; months: string[]; weekdays: string[] } {
  const months: string[] = [];
  const weekdays: string[] = [];
  let normalized = text.replaceAll('\u2212', '-').replace(/([-+])\s*([$€£₩])\s*(?=\d)/g, '$2$1');
  // ISO calendar dates and Korean dates carry the same explicit month.
  normalized = normalized.replace(
    /\b(\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\d|3[01])\b/g,
    '$1년 $2월 $3일',
  );
  const monthNames = [
    'Jan(?:uary)?',
    'Feb(?:ruary)?',
    'Mar(?:ch)?',
    'Apr(?:il)?',
    'May',
    'Jun(?:e)?',
    'Jul(?:y)?',
    'Aug(?:ust)?',
    'Sep(?:t(?:ember)?)?',
    'Oct(?:ober)?',
    'Nov(?:ember)?',
    'Dec(?:ember)?',
  ];
  for (const [index, name] of monthNames.entries()) {
    normalized = normalized.replace(
      new RegExp(`\\b(?:${name})\\b\\.?`, 'gi'),
      (match: string, offset: number, all: string) => {
        const before = all.slice(0, offset);
        const after = all.slice(offset + match.length);
        const explicitDate =
          /^\s+\d{1,4}(?:st|nd|rd|th)?\b/i.test(after) || /\b\d{1,2}\s+$/.test(before);
        // All month names can be people or organizations, including June Park and Jan Lee.
        // A preposition alone is insufficient in phrases such as "by April Kim".
        const followedByName =
          !match.endsWith('.') && /^\s+[A-Z](?:\.|[A-Za-z'’-]+\b)/u.test(after);
        const monthlySubject = /^\s+(?:results?|earnings|reports?|meetings?)\b/i.exec(after);
        // Financial headings identify a month even without a preposition. For "may",
        // retain the modal reading in prose such as "may report earnings".
        const monthlyHeading =
          monthlySubject !== null &&
          (!/^may\.?$/i.test(match) ||
            (/^May\.?$/.test(match) &&
              /^\s*(?:$|[:.,;!?—–-])/.test(after.slice(monthlySubject[0].length))));
        const calendarContext =
          explicitDate ||
          monthlyHeading ||
          (!followedByName &&
            (/\b(?:in|since|until|through|during|from|by|of|for)\s+$/i.test(before) ||
              /\b(?:early|late|mid)[ -]+$/i.test(before) ||
              /\bmonth\s+$/i.test(before) ||
              all.trim() === match));
        if (!calendarContext) return match;
        return `${index + 1}월`;
      },
    );
  }
  normalized = normalized.replace(/(?<![\d.])(\d{1,2})\s*월/g, (match, month: string) => {
    const value = Number(month);
    if (value < 1 || value > 12) return match;
    months.push(String(value));
    return ' ';
  });
  for (const [index, [english, korean]] of [
    ['Mon(?:day)?', '월요일'],
    ['Tue(?:s(?:day)?)?', '화요일'],
    ['Wed(?:nesday|s)?', '수요일'],
    ['Thu(?:r(?:s(?:day)?)?)?', '목요일'],
    ['Fri(?:day)?', '금요일'],
    ['Sat(?:urday)?', '토요일'],
    ['Sun(?:day)?', '일요일'],
  ].entries()) {
    normalized = normalized.replace(
      new RegExp(`\\b${english}\\b\\.?|${korean}`, 'gi'),
      (match: string, offset: number, all: string) => {
        // "Sun Microsystems" and "the sun" are not weekday references.
        if (/^(?:sun|sat|mon)\.?$/i.test(match)) {
          const before = all.slice(0, offset);
          const after = all.slice(offset + match.length);
          if (
            all.trim() !== match &&
            !/\b(?:on|by|for|until|through|from|due)\s+$/i.test(before) &&
            !/^\s*,?\s*\d/.test(after)
          )
            return match;
        }
        weekdays.push(String(index));
        return ' ';
      },
    );
  }
  return { text: normalized, months: months.sort(), weekdays: weekdays.sort() };
}

function halfYearFacts(text: string): { text: string; periods: string[] } {
  const periods: string[] = [];
  const record = (half: string, year: string): string => {
    const first = /^(?:H1|first[ -]half|상)$/i.test(half);
    // Keep the year in the numeric multiset as well as its association with this half.
    periods.push(`${year}:H${first ? 1 : 2}`);
    return ` ${year} `;
  };
  // A yearless H1/H2 can be a product identifier. Only normalize explicit, adjacent
  // year/half pairs, and leave common product-label contexts to the numeric check.
  const productLabel =
    /^\s*(?:(?:chips?|processors?|sensors?|models?|devices?)\b|칩|프로세서|센서|모델|기기)/i;
  let remaining = text.replace(
    /(?<![\p{L}\p{N}_.])(?:(H[12]|(?:first|second)[ -]half)\s+(?:of\s+)?([12]\d{3})(?![\p{L}\p{N}_]|\.\d)|([12]\d{3})\s+(H[12]|(?:first|second)[ -]half)(?![\p{L}\p{N}_-]))/giu,
    (
      match: string,
      leadingHalf: string | undefined,
      trailingYear: string | undefined,
      leadingYear: string | undefined,
      trailingHalf: string | undefined,
      offset: number,
      all: string,
    ) =>
      productLabel.test(all.slice(offset + match.length))
        ? match
        : record(leadingHalf ?? trailingHalf!, trailingYear ?? leadingYear!),
  );
  remaining = remaining.replace(
    /(?<![\p{L}\p{N}_.])([12]\d{3})\s*년\s*(상|하)반기/gu,
    (_match, year: string, half: string) => record(half, year),
  );
  return { text: remaining, periods: periods.sort() };
}

type ClockFacts = { text: string; times: string[] };

function clockFacts(text: string): ClockFacts {
  const times: string[] = [];
  let remaining = text.replace(
    /(?<![\w.])(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*([ap])\.?\s*m\.?(?![A-Za-z])/gi,
    (_match, hour: string, minute: string | undefined, period: string) => {
      const hour24 = (Number(hour) % 12) + (period.toLowerCase() === 'p' ? 12 : 0);
      times.push(`${hour24}:${Number(minute ?? 0)}`);
      return ' ';
    },
  );
  remaining = remaining.replace(
    /오(전|후)\s*(0?[1-9]|1[0-2])(?::([0-5]\d)|\s*시(?:\s*([0-5]?\d)\s*분)?)/gu,
    (
      _match,
      period: string,
      hour: string,
      colonMinute: string | undefined,
      minute: string | undefined,
    ) => {
      const hour24 = (Number(hour) % 12) + (period === '후' ? 12 : 0);
      times.push(`${hour24}:${Number(colonMinute ?? minute ?? 0)}`);
      return ' ';
    },
  );
  return { text: remaining, times: times.sort() };
}

function addUnmarkedClockFacts(clock: ClockFacts): ClockFacts {
  const times = [...clock.times];
  let remaining = clock.text.replace(
    /(?<![\p{L}\d:./])([01]?\d|2[0-3]):([0-5]\d)(?![\d:/]|\.\d)/gu,
    (_match, hour: string, minute: string) => {
      times.push(`${Number(hour)}:${Number(minute)}`);
      return ' ';
    },
  );
  remaining = remaining.replace(
    /(?<![\p{L}\d.])([01]?\d|2[0-3])\s*시(?:\s*([0-5]?\d)\s*분)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과]|부터|까지|쯤|정각)/gu,
    (_match, hour: string, minute: string | undefined) => {
      times.push(`${Number(hour)}:${Number(minute ?? 0)}`);
      return ' ';
    },
  );
  return { text: remaining, times: times.sort() };
}

function easternTimeZoneFacts(text: string): string[] {
  // Only these explicit U.S. Eastern labels are normalized. Other time-zone
  // labels and geographical references do not imply EDT or EST.
  const zones = new Set<string>();
  const labels: ReadonlyArray<readonly [string, RegExp]> = [
    [
      'EDT',
      /\bEDT\b|\bEastern\s+Daylight(?:\s+Saving)?\s+Time\b|동부\s*(?:일광\s*절약(?:\s*\(서머\s*타임\))?\s*(?:시간|시)(?:제)?|서머\s*타임)(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과])/giu,
    ],
    [
      'EST',
      /\bEST\b|\bEastern\s+Standard\s+Time\b|동부\s*표준\s*(?:시간|시)(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에로와과])/giu,
    ],
  ];
  for (const [zone, pattern] of labels) if (pattern.test(text)) zones.add(zone);
  return [...zones].sort();
}

function numericFacts(text: string): string[] {
  let normalized = normalizePercentRanges(normalizeMixedFractions(text));
  for (const [index, ordinal] of ['first', 'second', 'third', 'fourth'].entries()) {
    normalized = normalized.replace(
      new RegExp(`\\b${ordinal}(?=[ -]quarter\\b)`, 'gi'),
      `${index + 1}`,
    );
  }
  const matches = [
    ...normalized.matchAll(
      /(?<!\d)([-+]?\d[\d,]*(?:\.\d+)?)(?:\s*((?:trillion|billion|million|thousand|bn|mn|percent)\b|천만|백만|조|억|만|천|퍼센트|%))?/gi,
    ),
  ];
  const facts: string[] = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index]!;
    const unit = match[2]?.toLowerCase() ?? '';
    let amount = rational(match[1]!, MAGNITUDES[unit] ?? 0);
    let previous = match;
    let previousExponent = /^[가-힣]+$/u.test(unit) ? MAGNITUDES[unit] : undefined;
    // Adjacent descending Korean units form one amount: 12억 5천만 = 1.25 billion.
    while (previousExponent !== undefined && index + 1 < matches.length) {
      const next = matches[index + 1]!;
      const nextUnit = next[2] ?? '';
      const nextExponent = /^[가-힣]+$/u.test(nextUnit) ? MAGNITUDES[nextUnit] : undefined;
      if (
        nextExponent === undefined ||
        nextExponent >= previousExponent ||
        /^[-+]/.test(next[1]!) ||
        !/^\s*$/.test(normalized.slice(previous.index! + previous[0].length, next.index))
      )
        break;
      const part = rational(next[1]!, nextExponent);
      if (part.numerator >= 10n ** BigInt(previousExponent) * part.denominator) break;
      amount = {
        numerator:
          amount.numerator * part.denominator +
          (match[1]!.startsWith('-') ? -1n : 1n) * part.numerator * amount.denominator,
        denominator: amount.denominator * part.denominator,
      };
      previous = next;
      previousExponent = nextExponent;
      index += 1;
    }
    const percent = ['percent', '퍼센트', '%'].includes(unit) ? '%' : '';
    facts.push(`${rationalKey(amount)}${percent}`);
  }
  return facts.sort();
}

function currencyFacts(text: string): string[] {
  const currencies = new Set<string>();
  const names: ReadonlyArray<readonly [string, RegExp]> = [
    ['CAD', /\bCAD\b|(?:CA|C)\$|\bCanadian\s+dollars?\b|캐나다\s*달러/gi],
    ['AUD', /\bAUD\b|(?:AU|A)\$|\bAustralian\s+dollars?\b|호주\s*달러/gi],
    ['NZD', /\bNZD\b|NZ\$|\bNew Zealand\s+dollars?\b|뉴질랜드\s*달러/gi],
    ['HKD', /\bHKD\b|HK\$|\bHong Kong\s+dollars?\b|홍콩\s*달러/gi],
    ['SGD', /\bSGD\b|SG\$|\bSingapore\s+dollars?\b|싱가포르\s*달러/gi],
    ['USD', /\bUSD\b|\$|\bdollars?\b|달러/gi],
    [
      'KRW',
      /\bKRW\b|₩|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*won\b|(?<=[\d조억만천])\s*원(?=$|\s|[.,;:!?은는이가을를의에으짜당])/giu,
    ],
    [
      'EUR',
      /\bEUR\b|€|\beuros?\b|유로(?:화)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에와과당]|으로|로|짜리)/giu,
    ],
    [
      'GBP',
      /\bGBP\b|£|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*pounds?\b|파운드(?:화)?(?=$|\s|[^\p{L}\p{N}]|[은는이가을를의에와과당]|으로|로|짜리)/giu,
    ],
    [
      'JPY',
      /\bJPY\b|(?<=\d)(?:\s*(?:trillion|billion|million|thousand))?\s*yen\b|엔화|(?<=[\d조억만천])\s*엔(?=$|\s|[.,;:!?은는이가을를의에으짜당])/giu,
    ],
  ];
  let remaining = text;
  for (const [currency, pattern] of names) {
    remaining = remaining.replace(pattern, () => {
      currencies.add(currency);
      return ' ';
    });
  }
  return [...currencies].sort();
}

function equalFacts(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((value, index) => value === after[index]);
}

/** Checks explicit facts, not semantic equivalence or which subject a number describes. */
export function validateTranslationFacts(
  before: string,
  after: string,
  tickers: readonly string[] = [],
): void {
  const original = calendarFacts(before);
  const translated = calendarFacts(after);
  const originalHalf = halfYearFacts(original.text);
  const translatedHalf = halfYearFacts(translated.text);
  let originalClock = clockFacts(originalHalf.text);
  let translatedClock = clockFacts(translatedHalf.text);
  // Infer an unmarked 24-hour counterpart only when one side explicitly identifies
  // a clock with AM/PM. Otherwise leave ratios and Korean administrative counts alone.
  if (originalClock.times.length > 0 || translatedClock.times.length > 0) {
    originalClock = addUnmarkedClockFacts(originalClock);
    translatedClock = addUnmarkedClockFacts(translatedClock);
  }
  if (!equalFacts(original.months, translated.months))
    throw new Error('Local translation changed calendar month facts.');
  if (!equalFacts(original.weekdays, translated.weekdays))
    throw new Error('Local translation changed weekday facts.');
  if (!equalFacts(originalHalf.periods, translatedHalf.periods))
    throw new Error('Local translation changed half-year facts.');
  if (!equalFacts(originalClock.times, translatedClock.times))
    throw new Error('Local translation changed clock time facts.');
  if (!equalFacts(easternTimeZoneFacts(before), easternTimeZoneFacts(after)))
    throw new Error('Local translation changed time zone facts.');
  if (!equalFacts(numericFacts(originalClock.text), numericFacts(translatedClock.text)))
    throw new Error('Local translation changed numeric facts.');
  if (!equalFacts(currencyFacts(before), currencyFacts(after)))
    throw new Error('Local translation changed currency facts.');
  for (const ticker of tickers) {
    const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'u');
    if (pattern.test(before) && !pattern.test(after))
      throw new Error('Local translation changed a ticker symbol.');
  }
}
