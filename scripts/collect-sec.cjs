#!/usr/bin/env node
'use strict';

// Run after migrations and API/worker deployment:
// node --env-file=.env scripts/collect-sec.cjs [--status | --verify] [--collect-only]
// The normal run maps all listed US companies, then collects recent filings only
// for watched, recently viewed, or explicitly registered IR companies. No alerts.
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { Queue } = require('bullmq');
const { loadWorkerConfig } = require('../apps/worker/dist/config/worker-config.js');
const { discoverLinksJobSchema } = require('../apps/worker/dist/queues/job-data.js');
const { JobName, QueueName } = require('../apps/worker/dist/queues/queue.constants.js');
const { matchesRepeatSchedule } = require('../apps/worker/dist/queues/repeat-schedule-identity.js');
const {
  NEWS_DISCOVERY_SCHEDULES,
  SEC_CIK_SYNC_SCHEDULE,
} = require('../apps/worker/dist/scheduling/schedule-definitions.js');

const args = process.argv.slice(2);
const output = (value) => console.log(JSON.stringify(value));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownedJobs = [];
let database;
let queue;
let stage = 'configuration';
function fail(code) {
  const error = new Error(code);
  error.safeCode = code;
  throw error;
}

function connectionOptions(redisUrl) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  };
}

async function rows(sql, values = []) {
  return (await database.query({ sql, values, timeout: 10000 }))[0];
}

async function reportSecState() {
  const [health] = await rows(`SELECT status, checked_at, last_success_at,
    JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.httpStatus')) http_status,
    JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.healthSource')) health_source
    FROM connector_health WHERE connector='sec'`);
  const [cooldown] = await rows(`SELECT
    JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.retryAt')) retry_at,
    JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.providerStatus')) provider_status
    FROM source_checkpoints WHERE connector='SEC' AND stream='ACCESS_COOLDOWN'`);
  const retryAt = cooldown?.retry_at ? new Date(cooldown.retry_at) : null;
  output({
    stage: 'provider_state',
    status: health?.status ?? null,
    healthSource: health?.health_source ?? null,
    checkedAtUTC: health?.checked_at ?? null,
    lastSuccessAtUTC: health?.last_success_at ?? null,
    httpStatus: health?.http_status ?? null,
    cooldownActive: Boolean(retryAt && retryAt.getTime() > Date.now()),
    cooldownProviderStatus: cooldown?.provider_status ?? null,
    retryAtUTC: retryAt?.toISOString() ?? null,
    retryAtKST: retryAt
      ? new Intl.DateTimeFormat('ko-KR', {
          timeZone: 'Asia/Seoul',
          dateStyle: 'short',
          timeStyle: 'medium',
        }).format(retryAt)
      : null,
  });
}

async function snapshot(label) {
  const [coverage] = await rows(`SELECT COUNT(*) registered,
    COALESCE(SUM(cik IS NOT NULL AND cik <> ''),0) mapped, COUNT(DISTINCT cik) issuers
    FROM companies WHERE is_listed=1 AND market IN ('NASDAQ','NYSE','AMEX')`);
  const [sources] =
    await rows(`SELECT COUNT(*) filings, MAX(first_observed_at) latest_observation_utc
    FROM source_items WHERE source='SEC'`);
  const [events] = await rows(`SELECT COUNT(*) events FROM event_clusters
    WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata_json,'$.source'))='SEC'`);
  const [push] = await rows(`SELECT COUNT(*) deliveries FROM push_deliveries p WHERE EXISTS (
    SELECT 1 FROM news_items n JOIN source_items s ON s.id=n.source_item_id
    WHERE s.source='SEC' AND CAST(p.dedupe_key AS BINARY) LIKE CAST(CONCAT('%:news:',n.id) AS BINARY))`);
  const observations = await rows(`SELECT id,CAST(first_observed_at AS CHAR) observed
    FROM source_items WHERE source='SEC'`);
  const summary = {
    registered: Number(coverage.registered),
    mapped: Number(coverage.mapped),
    issuers: Number(coverage.issuers),
    filings: Number(sources.filings),
    events: Number(events.events),
    pushDeliveries: Number(push.deliveries),
    latestObservationUTC: sources.latest_observation_utc,
  };
  output({ stage: label, ...summary });
  return { ...summary, observations: new Map(observations.map((row) => [row.id, row.observed])) };
}

async function runJob(name, data, label) {
  stage = label;
  const job = await queue.add(name, data, {
    jobId: `sec-collection-${randomUUID()}`,
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
  ownedJobs.push(job.id);
  const start = Date.now();
  let lastProgress = start;
  while (Date.now() - start < 10 * 60_000) {
    const current = await queue.getJob(job.id);
    if (!current) fail('SUBMITTED_JOB_MISSING');
    const state = await current.getState();
    if (state === 'completed') {
      const result = current.returnvalue;
      if (name === JobName.DISCOVER_LINKS) {
        if (!Array.isArray(result) || result.length !== 1 || result[0]?.connector !== 'SEC')
          fail('INVALID_DISCOVERY_RESULT');
        const { status, seen, created } = result[0];
        output({ stage: label, status, seen, created });
        if (status !== 'HEALTHY') fail('SEC_DISCOVERY_NOT_HEALTHY');
      } else {
        output({
          stage: label,
          result: Object.fromEntries(
            Object.entries(result ?? {}).filter(
              ([, value]) => typeof value === 'number' || typeof value === 'boolean',
            ),
          ),
        });
        if (result?.disabled) fail('CIK_SYNC_DISABLED');
      }
      return result;
    }
    if (state === 'failed') fail('WORKER_JOB_FAILED');
    if (Date.now() - lastProgress > 15000) {
      output({ stage: label, state, elapsedSeconds: Math.floor((Date.now() - start) / 1000) });
      lastProgress = Date.now();
    }
    await pause(500);
  }
  fail('WORKER_JOB_WAIT_TIMEOUT');
}

async function main() {
  if (args.some((arg) => !['--status', '--verify', '--collect-only'].includes(arg)))
    fail('INVALID_ARGUMENT');
  const config = loadWorkerConfig();
  if (config.nodeEnv === 'production' && !process.env.DATABASE_URL) fail('DATABASE_REQUIRED');
  const url = new URL(config.databaseUrl);
  database = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    timezone: 'Z',
    dateStrings: true,
  });
  await database.query('SET SESSION TRANSACTION READ ONLY');
  const before = await snapshot('before');
  if (args.includes('--status')) {
    await reportSecState();
    return;
  }
  if (!config.secUserAgent) fail('SEC_USER_AGENT_REQUIRED');
  queue = new Queue(QueueName.CONNECTOR_HEALTH, {
    connection: connectionOptions(config.redisUrl),
    prefix: config.redisPrefix,
  });
  queue.on('error', () => {});
  await queue.waitUntilReady();
  const repeats = await queue.getRepeatableJobs();
  const discoverySchedule = NEWS_DISCOVERY_SCHEDULES.find((row) =>
    row.payload.connectors.includes('SEC'),
  );
  for (const [name, schedule] of [
    [JobName.SYNC_SEC_CIK, SEC_CIK_SYNC_SCHEDULE],
    [JobName.DISCOVER_LINKS, discoverySchedule],
  ]) {
    const matched = repeats.filter((row) => matchesRepeatSchedule(row, name, schedule));
    output({
      stage: 'schedule',
      name,
      count: matched.length,
      pattern: schedule.pattern,
      timezone: schedule.timezone,
    });
    if (matched.length !== 1) fail('EXPECTED_SCHEDULE_NOT_REGISTERED_ONCE');
  }
  if (!args.includes('--collect-only')) await runJob(JobName.SYNC_SEC_CIK, {}, 'map_cik');
  const companies = await rows(`SELECT c.id,c.ticker,c.name_ko,c.cik FROM companies c
    WHERE c.is_listed=1 AND c.market IN ('NASDAQ','NYSE','AMEX') AND (
      EXISTS (SELECT 1 FROM market_leader_company_links w WHERE w.company_id=c.id AND w.priority IN ('P1','P2'))
      OR EXISTS (SELECT 1 FROM ir_sources ir WHERE ir.company_id=c.id AND ir.is_active=1)
      OR EXISTS (SELECT 1 FROM source_checkpoints cp WHERE cp.connector='TOSS'
        AND cp.stream LIKE 'PRICE_BARS:%' AND cp.last_success_at>=UTC_TIMESTAMP()-INTERVAL 1 DAY
        AND CAST(SUBSTRING_INDEX(cp.stream,':',-1) AS BINARY)=CAST(c.id AS BINARY))
    ) ORDER BY c.ticker,c.id`);
  const eligible = companies.filter((company) => company.cik);
  output({
    stage: 'scope',
    selected: companies.length,
    mapped: eligible.length,
    unmapped: companies.length - eligible.length,
    tickers: eligible.map((company) => company.ticker),
  });
  if (!eligible.length) fail('NO_MAPPED_COMPANIES_IN_SCOPE');
  const collect = async (label) => {
    for (let offset = 0; offset < eligible.length; offset += 100) {
      const payload = discoverLinksJobSchema.parse({
        connectors: ['SEC'],
        priorities: [],
        companyIds: eligible.slice(offset, offset + 100).map((row) => row.id),
        reason: 'BACKFILL',
        suppressAlerts: true,
      });
      await runJob(JobName.DISCOVER_LINKS, payload, `${label}_${offset / 100 + 1}`);
    }
  };
  await collect('collect');
  const first = await snapshot('after');
  if (first.pushDeliveries !== before.pushDeliveries) fail('BACKFILL_GENERATED_ALERTS');
  if (first.filings === 0 || first.events === 0) fail('NO_SEC_FILINGS_OR_EVENTS');
  if (args.includes('--verify')) {
    await collect('recollect');
    const second = await snapshot('after_recollection');
    const changed = [...first.observations].filter(
      ([id, time]) => second.observations.get(id) !== time,
    ).length;
    output({
      stage: 'verification',
      existingFirstObservationsChanged: changed,
      additionalFilings: second.filings - first.filings,
      additionalEvents: second.events - first.events,
      additionalPushDeliveries: second.pushDeliveries - before.pushDeliveries,
    });
    if (changed || second.pushDeliveries !== before.pushDeliveries)
      fail('RECOLLECTION_INVARIANT_FAILED');
  }
}

main()
  .catch(async (error) => {
    output({
      stage,
      error: error.safeCode || 'OPERATION_FAILED',
      ...(/^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? { code: error.code } : {}),
    });
    if (database) await reportSecState().catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    if (queue) {
      for (const id of ownedJobs) {
        const job = await queue.getJob(id).catch(() => null);
        const state = await job?.getState().catch(() => null);
        if (job && ['completed', 'failed'].includes(state)) await job.remove().catch(() => {});
      }
      await queue.close();
    }
    if (database) await database.end();
  });
