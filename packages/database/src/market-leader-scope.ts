import type { Region } from '@orsem/contracts';
import type { DataSource } from 'typeorm';

/** Shared public news coverage: current representatives and verified component company IDs. */
export const MARKET_LEADER_COMPANIES_SQL =
  'SELECT company_id AS companyId FROM market_leader_company_links';

export async function marketLeaderCompanyIds(
  source: Pick<DataSource, 'query'>,
  region: Region = 'all',
): Promise<Set<string>> {
  const rows: Array<{ companyId: string }> = await source.query(
    MARKET_LEADER_COMPANIES_SQL + (region === 'all' ? '' : ' WHERE region=?'),
    region === 'all' ? [] : [region],
  );
  return new Set(rows.map((row) => row.companyId));
}
