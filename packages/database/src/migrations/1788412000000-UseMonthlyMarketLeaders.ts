import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A complete active snapshot replaces the manual operating list without deleting its history. */
export class UseMonthlyMarketLeaders1788412000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW market_leader_watchlist AS
      SELECT m.company_id AS id, m.company_id,
        CAST('P1' AS CHAR(4)) AS priority,
        (1 = 1) AS realtime_alerts, (1 = 0) AS digest_alerts,
        CAST(NULL AS CHAR(1000)) AS notes,
        MIN(s.observed_at) AS created_at, MAX(s.observed_at) AS updated_at
      FROM market_cap_memberships m
      JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id
      JOIN market_cap_snapshots s ON s.id=m.snapshot_id AND s.region=st.region
      JOIN companies c ON c.id=m.company_id
      WHERE st.region IN ('kr','us') AND m.rank_no BETWEEN 1 AND 20 AND c.is_listed=1
        AND (SELECT COUNT(*) FROM market_cap_memberships complete
          WHERE complete.snapshot_id=m.snapshot_id AND complete.rank_no BETWEEN 1 AND 20)=20
      GROUP BY m.company_id`);
    // JSON_TABLE uses the connection collation. Compare its IDs bytewise and project
    // the verified database ID so UNION never combines JSON and table collations.
    await runner.query(`CREATE OR REPLACE SQL SECURITY INVOKER VIEW market_leader_company_links AS
      SELECT coverage.company_id AS id, coverage.company_id,
        MIN(coverage.representative_company_id) AS representative_company_id, coverage.region,
        CAST('P1' AS CHAR(4)) AS priority,
        (1 = 1) AS realtime_alerts, (1 = 0) AS digest_alerts,
        CAST(NULL AS CHAR(1000)) AS notes,
        MIN(coverage.observed_at) AS created_at, MAX(coverage.observed_at) AS updated_at
      FROM (
        SELECT m.company_id, m.company_id AS representative_company_id, st.region, s.observed_at
        FROM market_leader_watchlist representative
        JOIN market_cap_memberships m ON m.company_id=representative.company_id
        JOIN market_selection_state st ON st.active_snapshot_id=m.snapshot_id
        JOIN market_cap_snapshots s ON s.id=m.snapshot_id AND s.region=st.region
        JOIN companies c ON c.id=m.company_id AND c.is_listed=1
        WHERE m.rank_no BETWEEN 1 AND 20
          AND (SELECT COUNT(*) FROM market_cap_memberships complete
            WHERE complete.snapshot_id=m.snapshot_id AND complete.rank_no BETWEEN 1 AND 20)=20
          AND (
          (st.region='kr' AND c.market IN ('KRX','KOSPI','KOSDAQ','KONEX')) OR
          (st.region='us' AND c.market IN ('NASDAQ','NYSE','AMEX')))
        UNION ALL
        SELECT c.id AS company_id, m.company_id AS representative_company_id, st.region, s.observed_at
        FROM market_selection_state st
        JOIN market_cap_snapshots s ON s.id=st.active_snapshot_id AND s.region=st.region
        JOIN JSON_TABLE(COALESCE(JSON_EXTRACT(s.raw_json,'$.leaders'),JSON_ARRAY()), '$[*]' COLUMNS (
          representative_company_id VARCHAR(128) PATH '$.companyId' NULL ON EMPTY NULL ON ERROR,
          representative_symbol VARCHAR(64) PATH '$.stockCode' NULL ON EMPTY NULL ON ERROR,
          rank_no INT PATH '$.rank' NULL ON EMPTY NULL ON ERROR,
          NESTED PATH '$.components[*]' COLUMNS (
            company_id VARCHAR(128) PATH '$.companyId' NULL ON EMPTY NULL ON ERROR,
            symbol VARCHAR(64) PATH '$.symbol' NULL ON EMPTY NULL ON ERROR
          )
        )) component
        JOIN market_cap_memberships m ON m.snapshot_id=s.id
          AND BINARY m.company_id=BINARY component.representative_company_id AND m.rank_no=component.rank_no
          AND BINARY m.stock_code=BINARY component.representative_symbol
        JOIN market_leader_watchlist representative ON representative.company_id=m.company_id
        JOIN companies issuer ON issuer.id=m.company_id AND issuer.is_listed=1
        JOIN companies c ON BINARY c.id=BINARY component.company_id AND c.is_listed=1
        WHERE m.rank_no BETWEEN 1 AND 20 AND BINARY component.company_id<>BINARY m.company_id
          AND JSON_EXTRACT(s.raw_json,'$.version')=2
          AND (SELECT COUNT(*) FROM market_cap_memberships complete
            WHERE complete.snapshot_id=m.snapshot_id AND complete.rank_no BETWEEN 1 AND 20)=20
          AND ((st.region='kr' AND issuer.market IN ('KRX','KOSPI','KOSDAQ','KONEX'))
            OR (st.region='us' AND issuer.market IN ('NASDAQ','NYSE','AMEX')))
          AND NOT EXISTS (SELECT 1 FROM market_leader_watchlist primary_member
            WHERE BINARY primary_member.company_id=BINARY component.company_id)
          AND ((st.region='kr' AND c.market IN ('KRX','KOSPI','KOSDAQ','KONEX')
            AND BINARY c.stock_code=BINARY component.symbol)
            OR (st.region='us' AND c.market IN ('NASDAQ','NYSE','AMEX')
            AND BINARY c.ticker=BINARY component.symbol))
      ) coverage
      GROUP BY coverage.company_id, coverage.region
      HAVING COUNT(DISTINCT coverage.representative_company_id)=1`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP VIEW IF EXISTS market_leader_company_links');
    await runner.query('DROP VIEW IF EXISTS market_leader_watchlist');
  }
}
