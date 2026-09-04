# Orsem contributor guidance

- Node.js 24, npm workspaces, TypeScript strict mode.
- Keep data and secrets outside this repository. Never commit real API keys or raw filings.
- OpenDART `D001`, `D002`, and `D005` are distinct domains. Do not infer a market buy from a positive quantity alone.
- Preserve raw source fields, provenance, rights mode, event date, publication date, and first-observed time.
- Production never auto-seeds fixture data. Missing credentials disable only that connector.
- Use migrations; TypeORM `synchronize` must remain false.
- User-facing time is KST. Persist instants as UTC and date-only source fields as dates.
- Do not add order execution or automated buy/sell recommendations.
