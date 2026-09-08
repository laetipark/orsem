import type { InformationField } from './company-information';

type Json = Record<string, unknown>;
type Fact = {
  val: number;
  start?: string;
  end: string;
  filed: string;
  accn: string;
  form: string;
  fp?: string;
  taxonomy: string;
  tag: string;
  unit: string;
};
export interface SecInformationField extends InformationField {
  periodStart: string | null;
  periodEnd: string | null;
  filingDate: string | null;
  accessionNumber: string | null;
  sourceTags: string[];
}
export interface SecCompanyInformation {
  fields: SecInformationField[];
  basisDate: string;
  reportYear: number;
  reportCode: string;
  sourceUrl: string;
}
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export function secCompanyFactsUrl(cik: string): string {
  if (!/^\d{1,10}$/u.test(cik) || Number(cik) <= 0) throw new Error('Invalid SEC CIK.');
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, '0')}.json`;
}
const reportUrl = (cik: string, fact: Fact) =>
  `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${fact.accn.replaceAll('-', '')}/${fact.accn}-index.html`;
const annual = (fact: Fact) => {
  const days = fact.start ? (Date.parse(fact.end) - Date.parse(fact.start)) / 86_400_000 + 1 : 0;
  return (
    ['10-K', '10-K/A', '20-F', '20-F/A'].includes(fact.form) &&
    fact.fp === 'FY' &&
    days >= 330 &&
    days <= 380
  );
};
const latest = (facts: Fact[]): Fact | undefined => {
  const sorted = [...facts].sort(
    (a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed),
  );
  const first = sorted[0];
  if (!first) return undefined;
  // Multiple conflicting values in the most recent context are not silently selected or summed.
  const peers = sorted.filter((fact) => fact.end === first.end && fact.filed === first.filed);
  if (new Set(peers.map((fact) => `${fact.start ?? ''}:${fact.val}`)).size > 1) return undefined;
  return first;
};

/** SEC Company Facts contains entity-wide standard taxonomy facts, not class-level financials.
 * https://www.sec.gov/search-filings/edgar-application-programming-interfaces
 */
export function parseSecCompanyInformation(
  input: unknown,
  cik: string,
  observedAt: string,
  options: { perShareEligible: boolean },
): SecCompanyInformation {
  secCompanyFactsUrl(cik);
  const raw = object(input);
  if (String(raw.cik).padStart(10, '0') !== cik.padStart(10, '0'))
    throw new Error('SEC Company Facts issuer mismatch.');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid SEC observation time.');
  const today = new Date(observedAt).toISOString().slice(0, 10);
  const facts = object(raw.facts);
  const read = (taxonomy: string, tag: string, unit: string): Fact[] => {
    const values = object(object(object(facts[taxonomy])[tag]).units)[unit];
    if (!Array.isArray(values)) return [];
    return values.flatMap((value: unknown) => {
      const row = object(value);
      if (
        typeof row.val !== 'number' ||
        !Number.isFinite(row.val) ||
        Math.abs(row.val) > Number.MAX_SAFE_INTEGER ||
        !date(row.end) ||
        !date(row.filed) ||
        row.end > row.filed ||
        row.filed > today ||
        (row.start !== undefined && (!date(row.start) || row.start > row.end)) ||
        typeof row.accn !== 'string' ||
        !/^\d{10}-\d{2}-\d{6}$/u.test(row.accn) ||
        typeof row.form !== 'string' ||
        !['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A'].includes(row.form) ||
        row.dimensions !== undefined ||
        row.segment !== undefined ||
        row.axis !== undefined
      )
        return [];
      return [
        {
          val: row.val,
          end: row.end,
          filed: row.filed,
          accn: row.accn,
          form: row.form,
          ...(typeof row.start === 'string' ? { start: row.start } : {}),
          ...(typeof row.fp === 'string' ? { fp: row.fp } : {}),
          taxonomy,
          tag,
          unit,
        },
      ];
    });
  };
  const candidates = (tags: string[], unit: string) =>
    tags.flatMap((qualified) => {
      const [taxonomy, tag] = qualified.split(':');
      return read(taxonomy!, tag!, unit);
    });
  const balanceTags = {
    assets: ['us-gaap:Assets', 'ifrs-full:Assets'],
    liabilities: ['us-gaap:Liabilities', 'ifrs-full:Liabilities'],
    equity: ['us-gaap:StockholdersEquity', 'ifrs-full:EquityAttributableToOwnersOfParent'],
    commonEquity: ['us-gaap:CommonStockholdersEquity'],
  };
  const balance =
    latest(candidates(balanceTags.assets, 'USD').filter((fact) => !fact.start)) ??
    latest(candidates(balanceTags.equity, 'USD').filter((fact) => !fact.start));
  const eps = latest(
    candidates(
      ['us-gaap:EarningsPerShareBasic', 'ifrs-full:BasicEarningsLossPerShare'],
      'USD/shares',
    ).filter(annual),
  );
  const anchor =
    !balance ||
    (eps && (eps.end > balance.end || (eps.end === balance.end && eps.filed > balance.filed)))
      ? eps
      : balance;
  if (!anchor) throw new Error('No supported SEC financial period is available.');
  const sameBalance = (tags: string[], unit: string) =>
    balance
      ? latest(
          candidates(tags, unit).filter(
            (fact) =>
              !fact.start &&
              fact.end === balance.end &&
              fact.accn === balance.accn &&
              fact.filed === balance.filed,
          ),
        )
      : undefined;
  const fields: SecInformationField[] = [];
  const push = (
    key: string,
    label: string,
    fact: Fact | undefined,
    unit: string,
    reason: string,
    value = fact?.val,
    sourceFacts: Fact[] = fact ? [fact] : [],
  ) => {
    fields.push({
      key,
      label,
      value: value === undefined ? null : String(value),
      unit,
      basis: fact
        ? `${fact.start ? `${fact.start}~` : ''}${fact.end} ${fact.start ? '연간' : '기말'} · ${fact.form} · ${fact.filed} 공시 · ${reason}`
        : reason,
      source: 'SEC',
      sourceUrl: fact ? reportUrl(cik, fact) : secCompanyFactsUrl(cik),
      observedAt,
      periodStart: fact?.start ?? null,
      periodEnd: fact?.end ?? null,
      filingDate: fact?.filed ?? null,
      accessionNumber: fact?.accn ?? null,
      sourceTags: sourceFacts.map((source) => `${source.taxonomy}:${source.tag}`),
    });
  };
  const equity = sameBalance(balanceTags.equity, 'USD');
  push('assets', '자산', sameBalance(balanceTags.assets, 'USD'), 'USD', '기업 전체 공시');
  push('liabilities', '부채', sameBalance(balanceTags.liabilities, 'USD'), 'USD', '기업 전체 공시');
  push('equity', '지배기업 귀속자본', equity, 'USD', '비지배지분 제외');
  // EPS is never reconstructed from quarterly EPS, earnings totals, or weighted-average shares.
  const splitFacts = Object.entries(facts).flatMap(([taxonomy, value]) =>
    Object.keys(object(value))
      .filter((tag) => /StockSplit.*Ratio|StockSplitConversionRatio/u.test(tag))
      .flatMap((tag) => read(taxonomy, tag, 'pure')),
  );
  const splitSince = (fact: Fact | undefined) =>
    Boolean(fact && splitFacts.some((split) => split.val !== 1 && split.end > fact.end));
  const usableEps = options.perShareEligible && !splitSince(eps) ? eps : undefined;
  push(
    'eps',
    'EPS',
    usableEps,
    'USD',
    usableEps ? '공시된 기본 주당순이익' : '검증된 연간 보통주 EPS·주식 종류·분할 기준 확인 대기',
  );
  let common = sameBalance(balanceTags.commonEquity, 'USD');
  let commonSources = common ? [common] : [];
  const preferredShares = sameBalance(['us-gaap:PreferredStockSharesOutstanding'], 'shares');
  // Total equity is not common equity unless no preferred shares is explicitly reported.
  if (!common && equity && preferredShares?.val === 0) {
    common = equity;
    commonSources = [equity, preferredShares];
  }
  const shares = sameBalance(['us-gaap:CommonStockSharesOutstanding'], 'shares');
  const safeCommon = options.perShareEligible && !splitSince(common) ? common : undefined;
  const safeShares =
    options.perShareEligible &&
    !splitSince(shares) &&
    shares &&
    Number.isSafeInteger(shares.val) &&
    shares.val > 0
      ? shares
      : undefined;
  push(
    'commonEquity',
    '보통주 귀속자본',
    safeCommon,
    'USD',
    safeCommon ? '보통주 기준 확인' : '보통주 귀속자본·주식 종류 확인 대기',
    safeCommon?.val,
    safeCommon ? commonSources : [],
  );
  push('commonShares', '기말 유통 보통주 수', safeShares, '주', '동일 공시·동일 기말 기준');
  const bps = safeCommon && safeShares ? safeCommon.val / safeShares.val : undefined;
  push(
    'bps',
    'BPS',
    bps !== undefined ? safeCommon : undefined,
    'USD',
    bps !== undefined
      ? '보통주 귀속자본 ÷ 동일 기말 유통 보통주 수'
      : '동일 공시·동일 기준일 보통주 BPS 확인 대기',
    bps === undefined ? undefined : Number(bps.toFixed(8)),
    bps === undefined ? [] : [...commonSources, safeShares!],
  );
  return {
    fields,
    basisDate: anchor.end,
    reportYear: Number(anchor.end.slice(0, 4)),
    reportCode: anchor.form,
    sourceUrl: reportUrl(cik, anchor),
  };
}
