import { type Market, type PublicCompany } from '@orsem/contracts';

export const SEC_COMPANY_SOURCE = 'https://www.sec.gov/files/company_tickers_exchange.json';
export const DART_COMPANY_SOURCE =
  'https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018';

const json = (field: string) => `JSON_UNQUOTE(JSON_EXTRACT(mapping.metadata_json, '$.${field}'))`;
const raw = (field: string) => json(`rawPayload[0].${field}`);
const kr = "company.market IN ('KRX','KOSPI','KOSDAQ','KONEX')";

// Only the OpenDART master writes source_updated_date. US display names must come
// from the verified SEC snapshot, because companies may contain private vendor names.
export const PUBLIC_COMPANY_NAME_SQL = `CASE WHEN ${kr} THEN company.name_ko ELSE ${raw('name')} END`;
export const PUBLIC_COMPANY_SYMBOL_SQL = `CASE WHEN ${kr} THEN company.stock_code ELSE company.ticker END`;
export const PUBLIC_COMPANY_IDENTITY_SQL = `company.is_listed = true AND (
  (${kr} AND company.corp_code REGEXP '^[0-9]{8}$'
    AND company.stock_code REGEXP '^[0-9A-Z]{6}$' AND company.source_updated_date IS NOT NULL
    AND CHAR_LENGTH(TRIM(company.name_ko)) > 0)
  OR (company.market IN ('NASDAQ','NYSE','AMEX') AND company.cik REGEXP '^[0-9]{10}$'
    AND company.ticker REGEXP '^[A-Z0-9][A-Z0-9.-]{0,19}$'
    AND ${json('source')} = 'SEC_EDGAR' AND ${json('rightsMode')} = 'OFFICIAL_PUBLIC_DATA'
    AND ${json('provenanceUrl')} = :secCompanySource
    AND ${json('companyId')} = company.id AND ${json('market')} = company.market
    AND BINARY ${json('ticker')} = BINARY company.ticker
    AND ${json('outcome')} IN ('linked','alreadyLinked')
    AND ${json('appliedCik')} = company.cik
    AND JSON_EXTRACT(mapping.metadata_json, '$.candidateRows') = 1
    AND JSON_LENGTH(JSON_EXTRACT(mapping.metadata_json, '$.rawPayload')) = 1
    AND LPAD(${raw('cik')}, 10, '0') = company.cik
    AND UPPER(REPLACE(${raw('ticker')}, '.', '-')) = REPLACE(company.ticker, '.', '-')
    AND (UPPER(${raw('exchange')}) = company.market OR
      (UPPER(${raw('exchange')}) = 'NYSE AMERICAN' AND company.market = 'AMEX'))
    AND CHAR_LENGTH(TRIM(${raw('name')})) > 0 AND mapping.last_success_at IS NOT NULL))`;

export const PUBLIC_COMPANY_SELECTION = [
  'company.id AS id',
  'company.market AS market',
  `${PUBLIC_COMPANY_NAME_SQL} AS name`,
  `${PUBLIC_COMPANY_SYMBOL_SQL} AS symbol`,
  `${raw('ticker')} AS verifiedTicker`,
  `CASE WHEN ${kr} THEN NULL ELSE mapping.last_success_at END AS observedAt`,
];

export interface PublicCompanyRow {
  id: string;
  market: Market;
  name: string;
  symbol: string;
  verifiedTicker: string | null;
  observedAt: Date | string | null;
}

export function mapPublicCompany(row: PublicCompanyRow): PublicCompany {
  const region = ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(row.market) ? 'kr' : 'us';
  const chartSymbol =
    ['NASDAQ', 'NYSE'].includes(row.market) &&
    row.verifiedTicker === row.symbol &&
    /^[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(row.symbol)
      ? `${row.market}:${row.symbol}`
      : null;
  return {
    id: row.id,
    name: row.name,
    market: row.market,
    symbol: row.symbol,
    region,
    // A stable ID also remains safe when an exchange reuses a historical symbol.
    canonicalPath: `/companies/${row.id}`,
    chartSymbol,
    sourceUrl: region === 'kr' ? DART_COMPANY_SOURCE : SEC_COMPANY_SOURCE,
    observedAt: row.observedAt ? new Date(row.observedAt).toISOString() : null,
  };
}
