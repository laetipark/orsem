export interface ParseIntegrityMetrics {
  asOf: string;
  totalParseRuns: number;
  failedParseRuns: number;
  openReviewRows: number;
  currentReviewSubjects: number;
  currentUnrecoveredFilings: number;
  currentFailedFilings: number;
  staleOpenParseReviews: number;
  supersededReviews: number;
  documentUnavailableReviews: number;
  relationReviews: number;
  currentTypeMismatches: number;
  futureCreatedRows: number;
}

export const PARSE_INTEGRITY_METRICS_SQL = `WITH
 ranked_runs AS (
   SELECT p.id,p.filing_id,p.status,p.created_at,
     ROW_NUMBER() OVER (PARTITION BY filing_id ORDER BY created_at DESC,id DESC) AS position
   FROM parse_runs p
 ),
 latest_runs AS (SELECT * FROM ranked_runs WHERE position = 1),
 open_reviews AS (
   SELECT r.*, p.filing_id AS parse_filing_id, p.id AS linked_run_id,
     latest.id AS latest_run_id
   FROM reviews r
   LEFT JOIN parse_runs p ON p.id = COALESCE(r.parse_run_id,
     CASE WHEN r.dedupe_key REGEXP '^parse:[a-f0-9-]{36}(:failed)?$'
       THEN SUBSTRING(r.dedupe_key,7,36) END)
     AND r.subject_type = 'FILING' AND p.filing_id = r.subject_id
   LEFT JOIN latest_runs latest ON latest.filing_id = p.filing_id
   WHERE r.status = 'OPEN'
 )
 SELECT
   (SELECT COUNT(*) FROM parse_runs) AS totalParseRuns,
   (SELECT COUNT(*) FROM parse_runs WHERE status = 'FAILED') AS failedParseRuns,
   (SELECT COUNT(*) FROM open_reviews) AS openReviewRows,
   (SELECT COUNT(DISTINCT CONCAT(subject_type,':',subject_id,':',
     CASE WHEN linked_run_id IS NOT NULL THEN 'PARSE'
          WHEN dedupe_key LIKE 'document:%' THEN 'DOCUMENT' ELSE COALESCE(review_group,'OTHER') END))
     FROM open_reviews) AS currentReviewSubjects,
   (SELECT COUNT(DISTINCT parse_filing_id) FROM open_reviews
     WHERE linked_run_id = latest_run_id) AS currentUnrecoveredFilings,
   (SELECT COUNT(*) FROM latest_runs WHERE status = 'FAILED') AS currentFailedFilings,
   (SELECT COUNT(*) FROM open_reviews WHERE linked_run_id <> latest_run_id) AS staleOpenParseReviews,
   (SELECT COUNT(*) FROM reviews WHERE status = 'SUPERSEDED') AS supersededReviews,
   (SELECT COUNT(*) FROM open_reviews WHERE dedupe_key LIKE 'document:%') AS documentUnavailableReviews,
   (SELECT COUNT(*) FROM open_reviews WHERE subject_type = 'FILING_RELATION') AS relationReviews,
   (SELECT COUNT(*) FROM latest_runs p JOIN filings f ON f.id = p.filing_id
     JOIN parse_runs result ON result.id=p.id
     WHERE NULLIF(JSON_UNQUOTE(JSON_EXTRACT(result.result_json,'$.parsed.detailType')),'null')
       <> COALESCE(f.canonical_type,f.detail_type)) AS currentTypeMismatches,
   ((SELECT COUNT(*) FROM reviews WHERE created_at > CAST(? AS DATETIME(3))) +
    (SELECT COUNT(*) FROM parse_runs WHERE created_at > CAST(? AS DATETIME(3)))) AS futureCreatedRows`;

export function mapParseIntegrityMetrics(
  row: Record<string, unknown>,
  asOf: Date,
): ParseIntegrityMetrics {
  const count = (key: string) => {
    const value = Number(row[key]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Invalid integrity count: ${key}`);
    return value;
  };
  return {
    asOf: asOf.toISOString(),
    totalParseRuns: count('totalParseRuns'),
    failedParseRuns: count('failedParseRuns'),
    openReviewRows: count('openReviewRows'),
    currentReviewSubjects: count('currentReviewSubjects'),
    currentUnrecoveredFilings: count('currentUnrecoveredFilings'),
    currentFailedFilings: count('currentFailedFilings'),
    staleOpenParseReviews: count('staleOpenParseReviews'),
    supersededReviews: count('supersededReviews'),
    documentUnavailableReviews: count('documentUnavailableReviews'),
    relationReviews: count('relationReviews'),
    currentTypeMismatches: count('currentTypeMismatches'),
    futureCreatedRows: count('futureCreatedRows'),
  };
}
