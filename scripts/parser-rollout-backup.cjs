#!/usr/bin/env node
'use strict';

// Read-only production backup and isolated restore verification. Never restores production.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { prepareOutputDirectory } = require('./parser-corpus-audit.cjs');

const RELATED_TABLES = Object.freeze([
  'companies',
  'company_aliases',
  'watchlist_items',
  'filings',
  'filing_list_observations',
  'parse_runs',
  'reviews',
  'filing_documents',
  'filing_relations',
  'parse_issues',
  'event_clusters',
  'event_cluster_items',
  'insider_reports',
  'insider_transactions',
  'large_holder_reports',
  'large_holder_positions',
  'large_holding_changes',
  'trade_plans',
  'trade_plan_items',
  'plan_execution_matches',
  'alerts',
  'alert_outbox',
  'alert_deliveries',
  'job_outbox',
  'bot_deliveries',
  'push_deliveries',
  'notification_preferences',
  // Preferences own subscriptions. Backing up one without the other can make
  // a rollback delete the only browser endpoint or leave pending deliveries
  // without their encrypted browser key material.
  'push_subscriptions',
  'proxy_solicitations',
  'proxy_agenda_items',
  'tender_offers',
  'tender_offer_securities',
  'typeorm_migrations',
  'parse_integrity_review_history',
  'parser_clock_corrections',
]);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const identifier = (value) => {
  if (!/^[a-zA-Z0-9_]+$/u.test(value)) throw new Error('INVALID_IDENTIFIER');
  return '`' + value + '`';
};
function writePrivate(directory, name, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2));
  fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600, flag: 'wx' });
  return { file: name, bytes: bytes.length, sha256: sha(bytes) };
}
function optionsFromEnvironmentFile(filename) {
  const env = require('dotenv').parse(fs.readFileSync(filename));
  const url = new URL(env.DATABASE_URL);
  if (url.protocol !== 'mysql:') throw new Error('MYSQL_URL_REQUIRED');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    timezone: 'Z',
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  };
}
async function query(connection, sql, values) {
  return (await connection.query(sql, values))[0];
}
function ordered(rows, primaryKeys) {
  return [...rows].sort((a, b) =>
    JSON.stringify(primaryKeys.map((k) => a[k])).localeCompare(
      JSON.stringify(primaryKeys.map((k) => b[k])),
    ),
  );
}

async function backup(connection, outputDirectory) {
  const output = prepareOutputDirectory(outputDirectory);
  if (fs.readdirSync(output).length) throw new Error('BACKUP_DIRECTORY_MUST_BE_EMPTY');
  await query(connection, "SET SESSION time_zone='+00:00'");
  await query(connection, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await query(connection, 'SET TRANSACTION READ ONLY');
  await query(connection, 'START TRANSACTION WITH CONSISTENT SNAPSHOT');
  try {
    await query(connection, 'SELECT id FROM parse_runs LIMIT 1');
    const [clock] = await query(connection, 'SELECT UTC_TIMESTAMP(3) AS snapshot_utc');
    const available = await query(
      connection,
      "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
    );
    const schema = {};
    const tables = {};
    for (const { name } of available) {
      const [definition] = await query(connection, 'SHOW CREATE TABLE ' + identifier(name));
      schema[name] = definition['Create Table'];
      if (!RELATED_TABLES.includes(name)) continue;
      const columns = await query(connection, 'SHOW FULL COLUMNS FROM ' + identifier(name));
      const insertColumns = columns
        .filter((c) => !/(?:VIRTUAL|STORED) GENERATED/u.test(c.Extra))
        .map((c) => c.Field);
      const keys = await query(
        connection,
        'SHOW KEYS FROM ' + identifier(name) + " WHERE Key_name='PRIMARY'",
      );
      const primaryKeys = keys
        .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
        .map((k) => k.Column_name);
      if (!primaryKeys.length) throw new Error('BACKUP_REQUIRES_PRIMARY_KEY');
      const rows = ordered(
        await query(
          connection,
          'SELECT ' + insertColumns.map(identifier).join(',') + ' FROM ' + identifier(name),
        ),
        primaryKeys,
      );
      tables[name] = {
        columns: insertColumns,
        primaryKeys,
        count: rows.length,
        ...writePrivate(output, name + '.json', rows),
      };
    }
    await connection.commit();
    const schemaFile = writePrivate(output, 'schemas.json', schema);
    const manifest = {
      version: 1,
      snapshotUtc: clock.snapshot_utc,
      tables,
      schema: schemaFile,
      absentRelatedTables: RELATED_TABLES.filter((name) => !(name in tables)),
      note: 'Related table data plus complete DDL. Other table data is not included. Original documents remain in external immutable storage.',
    };
    const manifestFile = writePrivate(output, 'manifest.json', manifest);
    writePrivate(output, 'backup-complete.json', {
      manifestSha256: manifestFile.sha256,
      completedAt: new Date().toISOString(),
    });
    return {
      output,
      tables: Object.keys(tables).length,
      rows: Object.values(tables).reduce((n, t) => n + t.count, 0),
      manifestSha256: manifestFile.sha256,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

function readVerifiedBackup(directory) {
  const root = fs.realpathSync(directory);
  const read = (name) => {
    if (path.basename(name) !== name) throw new Error('INVALID_BACKUP_PATH');
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error('BACKUP_MUST_BE_PRIVATE_REGULAR_FILE');
    return fs.readFileSync(file);
  };
  const manifestBytes = read('manifest.json'),
    complete = JSON.parse(read('backup-complete.json'));
  if (sha(manifestBytes) !== complete.manifestSha256)
    throw new Error('BACKUP_MANIFEST_HASH_MISMATCH');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1) throw new Error('BACKUP_VERSION_UNSUPPORTED');
  const verifiedFile = (entry) => {
    const bytes = read(entry.file);
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256)
      throw new Error('BACKUP_FILE_HASH_MISMATCH');
    return JSON.parse(bytes);
  };
  const schemas = verifiedFile(manifest.schema);
  const tables = {};
  for (const [name, entry] of Object.entries(manifest.tables)) {
    identifier(name);
    tables[name] = verifiedFile(entry);
    if (tables[name].length !== entry.count) throw new Error('BACKUP_ROW_COUNT_MISMATCH');
  }
  return { manifest, schemas, tables, manifestSha256: sha(manifestBytes) };
}

async function restoreCheck({ socketPath, database, backupDirectory, outputDirectory }) {
  const socket = fs.realpathSync(socketPath);
  if (!socket.startsWith('/tmp/') || !fs.statSync(socket).isSocket())
    throw new Error('ISOLATED_TMP_SOCKET_REQUIRED');
  if (!/^orsem_[a-z0-9_]+_test$/u.test(database))
    throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const saved = readVerifiedBackup(backupDirectory);
  const output = prepareOutputDirectory(outputDirectory);
  if (fs.readdirSync(output).length) throw new Error('RESTORE_PROOF_DIRECTORY_MUST_BE_EMPTY');
  const connection = await mysql.createConnection({
    socketPath: socket,
    user: 'root',
    dateStrings: true,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    await query(connection, "SET SESSION time_zone='+00:00'");
    // CREATE without IF NOT EXISTS guarantees we never overwrite another test or live database.
    await query(
      connection,
      'CREATE DATABASE ' +
        identifier(database) +
        ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );
    await query(connection, 'USE ' + identifier(database));
    await query(connection, 'SET FOREIGN_KEY_CHECKS=0');
    for (const definition of Object.values(saved.schemas)) await query(connection, definition);
    for (const [name, rows] of Object.entries(saved.tables)) {
      const columns = saved.manifest.tables[name].columns;
      let batch = [],
        batchBytes = 0;
      const flush = async () => {
        if (batch.length)
          await query(
            connection,
            'INSERT INTO ' +
              identifier(name) +
              ' (' +
              columns.map(identifier).join(',') +
              ') VALUES ?',
            [batch],
          );
        batch = [];
        batchBytes = 0;
      };
      for (const sourceRow of rows) {
        const values = columns.map((key) => {
          const value = sourceRow[key];
          return value && typeof value === 'object' ? JSON.stringify(value) : value;
        });
        const size = Buffer.byteLength(JSON.stringify(values));
        if (batch.length && (batch.length >= 100 || batchBytes + size > 1024 * 1024)) await flush();
        batch.push(values);
        batchBytes += size;
      }
      await flush();
    }
    await query(connection, 'SET FOREIGN_KEY_CHECKS=1');
    for (const [name, rows] of Object.entries(saved.tables)) {
      const entry = saved.manifest.tables[name];
      const restored = ordered(
        await query(
          connection,
          'SELECT ' + entry.columns.map(identifier).join(',') + ' FROM ' + identifier(name),
        ),
        entry.primaryKeys,
      );
      if (sha(JSON.stringify(restored)) !== sha(JSON.stringify(rows)))
        throw new Error('RESTORED_DATA_MISMATCH');
    }
    const proof = {
      manifestSha256: saved.manifestSha256,
      verifiedAt: new Date().toISOString(),
      database,
      socketPath: socket,
      tablesVerified: Object.keys(saved.tables),
      dataMatches: true,
    };
    writePrivate(output, 'restore-proof.json', proof);
    return proof;
  } finally {
    await connection.end();
  }
}

async function main(argv) {
  const [mode, ...args] = argv,
    options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1] || options[args[i]])
      throw new Error('INVALID_ARGUMENTS');
    options[args[i]] = args[i + 1];
  }
  if (mode === 'backup' && options['--env-file'] && options['--output-dir']) {
    const connection = await mysql.createConnection(
      optionsFromEnvironmentFile(options['--env-file']),
    );
    try {
      return await backup(connection, options['--output-dir']);
    } finally {
      await connection.end();
    }
  }
  if (mode === 'restore-check')
    return restoreCheck({
      socketPath: options['--socket-path'],
      database: options['--database'],
      backupDirectory: options['--backup-dir'],
      outputDirectory: options['--output-dir'],
    });
  throw new Error('EXPECTED_BACKUP_OR_RESTORE_CHECK');
}
if (require.main === module)
  main(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          error: /^[A-Z_]+$/u.test(error.message)
            ? error.message
            : error.code || 'BACKUP_OPERATION_FAILED',
        }),
      );
      process.exitCode = 1;
    });
module.exports = { backup, readVerifiedBackup, restoreCheck, RELATED_TABLES };
