import {
  parseSecCompanyInformation,
  secCompanyFactsUrl,
} from '../src/market-data/sec-company-information';

const OBSERVED = '2026-09-07T10:00:00.000Z';
const CIK = '0000123456';
const accession = '0000123456-26-000001';
const instant = (val: number, overrides: Record<string, unknown> = {}) => ({
  val,
  end: '2025-12-31',
  filed: '2026-02-15',
  accn: accession,
  form: '10-K',
  fp: 'FY',
  ...overrides,
});
const annual = (val: number, overrides: Record<string, unknown> = {}) =>
  instant(val, { start: '2025-01-01', ...overrides });
const concept = (unit: string, values: unknown[]) => ({ units: { [unit]: values } });
function data() {
  return {
    cik: 123456,
    facts: {
      'us-gaap': {
        Assets: concept('USD', [instant(1200)]),
        Liabilities: concept('USD', [instant(400)]),
        StockholdersEquity: concept('USD', [instant(800)]),
        CommonStockholdersEquity: concept('USD', [instant(750)]),
        CommonStockSharesOutstanding: concept('shares', [instant(100)]),
        EarningsPerShareBasic: concept('USD/shares', [annual(5)]),
      },
    },
  };
}
const parse = (input: unknown, perShareEligible = true) =>
  parseSecCompanyInformation(input, CIK, OBSERVED, { perShareEligible });
const field = (input: unknown, key: string, eligible = true) =>
  parse(input, eligible).fields.find((value) => value.key === key)!;

it('preserves exact source periods, accession, units and provenance when calculating same-period common BPS', () => {
  const raw = data();
  const copy = JSON.stringify(raw);
  const result = parse(raw);
  expect(result).toMatchObject({ basisDate: '2025-12-31', reportYear: 2025, reportCode: '10-K' });
  expect(field(raw, 'eps')).toMatchObject({
    value: '5',
    unit: 'USD',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    filingDate: '2026-02-15',
    accessionNumber: accession,
    observedAt: OBSERVED,
    source: 'SEC',
    sourceTags: ['us-gaap:EarningsPerShareBasic'],
    sourceUrl:
      'https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/0000123456-26-000001-index.html',
  });
  expect(field(raw, 'eps').basis).toContain('연간');
  expect(field(raw, 'bps')).toMatchObject({
    value: '7.5',
    unit: 'USD',
    sourceTags: ['us-gaap:CommonStockholdersEquity', 'us-gaap:CommonStockSharesOutstanding'],
  });
  expect(JSON.stringify(raw)).toBe(copy);
  expect(secCompanyFactsUrl('123456')).toBe(
    'https://data.sec.gov/api/xbrl/companyfacts/CIK0000123456.json',
  );
});

it('selects the newest annual period then its latest filing and never sums quarterly or comparative EPS', () => {
  const raw = data();
  raw.facts['us-gaap'].EarningsPerShareBasic = concept('USD/shares', [
    annual(5),
    annual(5.5, { filed: '2026-03-01', accn: '0000123456-26-000002', form: '10-K/A' }),
    annual(20, { start: '2024-01-01', end: '2024-12-31', filed: '2026-07-01' }),
    annual(100, {
      start: '2026-01-01',
      end: '2026-03-31',
      filed: '2026-05-01',
      form: '10-Q',
      fp: 'Q1',
    }),
  ]);
  expect(field(raw, 'eps')).toMatchObject({
    value: '5.5',
    filingDate: '2026-03-01',
    periodEnd: '2025-12-31',
  });
});

it.each([
  { start: '2025-10-01' },
  { start: '2024-12-01' },
  { form: '10-Q' },
  { fp: 'Q4' },
  { dimensions: { StockClass: 'A' } },
  { filed: '2027-01-01' },
  { end: '2025-02-30' },
  { val: Number.NaN },
])(
  'withholds EPS when the candidate is not a valid entity-wide filed annual fact: %p',
  (overrides) => {
    const raw = data();
    raw.facts['us-gaap'].EarningsPerShareBasic = concept('USD/shares', [annual(5, overrides)]);
    expect(field(raw, 'eps').value).toBeNull();
  },
);

it('rejects wrong EPS units and contradictory values at the latest period without falling back to an old year', () => {
  const raw = data();
  raw.facts['us-gaap'].EarningsPerShareBasic = concept('EUR/shares', [annual(5)]);
  expect(field(raw, 'eps').value).toBeNull();
  raw.facts['us-gaap'].EarningsPerShareBasic = concept('USD/shares', [
    annual(5),
    annual(6),
    annual(2, { start: '2024-01-01', end: '2024-12-31' }),
  ]);
  expect(field(raw, 'eps').value).toBeNull();
});

it('retains valid negative EPS and uses standard IFRS annual USD facts for 20-F issuers', () => {
  const raw = {
    cik: 123456,
    facts: {
      'ifrs-full': {
        Assets: concept('USD', [instant(1200, { form: '20-F' })]),
        EquityAttributableToOwnersOfParent: concept('USD', [instant(800, { form: '20-F' })]),
        BasicEarningsLossPerShare: concept('USD/shares', [annual(-2, { form: '20-F' })]),
      },
    },
  };
  expect(field(raw, 'eps')).toMatchObject({ value: '-2', unit: 'USD' });
  expect(field(raw, 'bps').value).toBeNull();
});

it('does not borrow balance fields or share counts from a different date or accession', () => {
  const raw = data();
  raw.facts['us-gaap'].CommonStockSharesOutstanding = concept('shares', [
    instant(100, { end: '2026-01-15' }),
  ]);
  expect(field(raw, 'bps').value).toBeNull();
  raw.facts['us-gaap'].CommonStockSharesOutstanding = concept('shares', [
    instant(100, { accn: '0000123456-26-000002' }),
  ]);
  expect(field(raw, 'bps').value).toBeNull();
  raw.facts['us-gaap'].Assets = concept('USD', [
    instant(2000, {
      end: '2026-06-30',
      filed: '2026-08-01',
      form: '10-Q',
      accn: '0000123456-26-000010',
    }),
  ]);
  expect(field(raw, 'assets').value).toBe('2000');
  expect(field(raw, 'equity').value).toBeNull();
  expect(field(raw, 'bps').value).toBeNull();
});

it('requires explicit common equity or zero preferred shares and never substitutes issued or weighted-average shares', () => {
  const raw = data();
  raw.facts['us-gaap'].CommonStockholdersEquity = concept('USD', []);
  expect(field(raw, 'bps').value).toBeNull();
  Object.assign(raw.facts['us-gaap'], {
    PreferredStockSharesOutstanding: concept('shares', [instant(0)]),
  });
  expect(field(raw, 'bps').value).toBe('8');
  Object.assign(raw.facts['us-gaap'], {
    PreferredStockSharesOutstanding: concept('shares', [instant(20)]),
  });
  expect(field(raw, 'bps').value).toBeNull();
  raw.facts['us-gaap'].CommonStockSharesOutstanding = concept('shares', []);
  Object.assign(raw.facts['us-gaap'], {
    CommonStockSharesIssued: concept('shares', [instant(100)]),
    WeightedAverageNumberOfSharesOutstandingBasic: concept('shares', [annual(100)]),
  });
  expect(field(raw, 'commonShares').value).toBeNull();
});

it('withholds per-share data for unverified or multiple share classes and later disclosed splits', () => {
  const raw = data();
  for (const key of ['eps', 'bps', 'commonEquity', 'commonShares'])
    expect(field(raw, key, false).value).toBeNull();
  expect(field(raw, 'assets', false).value).toBe('1200');
  Object.assign(raw.facts['us-gaap'], {
    StockholdersEquityNoteStockSplitConversionRatio1: concept('pure', [
      instant(2, { end: '2026-06-30', filed: '2026-08-01', form: '10-Q' }),
    ]),
  });
  expect(field(raw, 'eps').value).toBeNull();
  expect(field(raw, 'bps').value).toBeNull();
});

it('rejects issuer mismatches, unsafe identifiers and payloads with no recognized financial period', () => {
  expect(() => parse({ ...data(), cik: 42 })).toThrow('issuer mismatch');
  expect(() => secCompanyFactsUrl('../123')).toThrow('Invalid SEC CIK');
  expect(() => parse({ cik: 123456, facts: {} })).toThrow('No supported SEC financial period');
});

it('keeps snapshot metadata on the newest annual disclosure when only older balance data is available', () => {
  const raw = data();
  raw.facts['us-gaap'].Assets = concept('USD', [
    instant(900, { end: '2024-12-31', filed: '2025-02-15' }),
  ]);
  expect(parse(raw)).toMatchObject({ basisDate: '2025-12-31', reportYear: 2025 });
  expect(field(raw, 'eps').periodEnd).toBe('2025-12-31');
});
