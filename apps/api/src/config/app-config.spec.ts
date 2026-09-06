import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAppConfig } from './app-config';
import { NEWS_RSS_FEED_IDS } from '@orsem/contracts';

test('fixture configuration has safe local defaults', () => {
  const config = loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true' });
  assert.equal(config.fixtureMode, true);
  assert.equal(config.port, 3210);
  assert.equal(config.gdeltEnabled, false);
  assert.equal(config.marketDataProvider, 'toss');
});

test('NAVER API provider is explicitly selected and rejects unknown endpoints', () => {
  assert.equal(loadAppConfig({ NODE_ENV: 'test' }).naverApiProvider, 'developers');
  assert.equal(
    loadAppConfig({ NODE_ENV: 'test', NAVER_API_PROVIDER: 'ncloud' }).naverApiProvider,
    'ncloud',
  );
  assert.throws(() =>
    loadAppConfig({ NODE_ENV: 'test', NAVER_API_PROVIDER: 'https://other.example' }),
  );
});

test('news RSS is off by default and accepts only the approved feed identifiers', () => {
  for (const environment of [
    { NODE_ENV: 'test' },
    { NODE_ENV: 'test', FIXTURE_MODE: 'true' },
    { NODE_ENV: 'test', NEWS_RSS_FEEDS: ' , ' },
  ]) {
    assert.deepEqual(loadAppConfig(environment).newsRssFeeds, []);
  }
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', NEWS_RSS_FEEDS: ' fed-press,fed-press ' }).newsRssFeeds,
    ['fed-press'],
  );
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', NEWS_RSS_FEEDS: NEWS_RSS_FEED_IDS.join(',') }).newsRssFeeds,
    [...NEWS_RSS_FEED_IDS],
  );
  for (const feed of [
    'unknown',
    'newsis-bank',
    'mk-stock',
    'etoday-market',
    'fed-press,unknown',
    'https://rss.etoday.co.kr/eto/market_news.xml',
  ]) {
    assert.throws(() => loadAppConfig({ NODE_ENV: 'test', NEWS_RSS_FEEDS: feed }));
  }
});

test('GDELT config parses domain syntax without granting publisher approval', () => {
  assert.deepEqual(loadAppConfig({ NODE_ENV: 'test' }).gdeltNewsDomains, []);
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', GDELT_NEWS_DOMAINS: ' , ' }).gdeltNewsDomains,
    [],
  );
  assert.deepEqual(
    loadAppConfig({ NODE_ENV: 'test', GDELT_NEWS_DOMAINS: 'unapproved.example' }).gdeltNewsDomains,
    ['unapproved.example'],
  );
  assert.throws(() => loadAppConfig({ NODE_ENV: 'test', GDELT_NEWS_DOMAINS: 'localhost' }));
});

test('Kakao external credentials are optional, overrideable and isolated from malformed files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orsem-kakao-config-'));
  const path = join(directory, 'credentials.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({
        clientId: 'test-kakao-id',
        clientSecret: 'test-kakao-secret',
        redirectUri: 'https://orsem.example/api/v1/auth/kakao/callback',
      }),
    );
    const fromFile = loadAppConfig({ NODE_ENV: 'test', KAKAO_CREDENTIALS_FILE: ` ${path} ` });
    assert.equal(fromFile.kakaoClientId, 'test-kakao-id');
    assert.equal(fromFile.kakaoClientSecret, 'test-kakao-secret');
    assert.equal(fromFile.kakaoRedirectUri, 'https://orsem.example/api/v1/auth/kakao/callback');
    assert.equal(
      loadAppConfig({
        NODE_ENV: 'test',
        KAKAO_CREDENTIALS_FILE: path,
        KAKAO_CLIENT_ID: 'test-override',
      }).kakaoClientId,
      'test-override',
    );
    for (const invalid of [
      '{invalid',
      JSON.stringify({ clientId: 42, clientSecret: 'test-secret' }),
      'null',
    ]) {
      writeFileSync(path, invalid);
      const value = loadAppConfig({ NODE_ENV: 'test', KAKAO_CREDENTIALS_FILE: path });
      assert.equal(value.kakaoClientId, undefined);
      assert.equal(value.marketDataProvider, 'toss');
    }
    assert.equal(
      loadAppConfig({ NODE_ENV: 'test', KAKAO_CREDENTIALS_FILE: `${path}.missing` })
        .kakaoClientSecret,
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Toss supports external credentials with environment override and isolated missing-file behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orsem-toss-config-'));
  const path = join(directory, 'credentials.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({ clientId: 'test-file-id', clientSecret: 'test-file-secret' }),
    );
    const fromFile = loadAppConfig({ NODE_ENV: 'test', TOSS_CREDENTIALS_FILE: ` ${path} ` });
    assert.equal(fromFile.tossClientId, 'test-file-id');
    assert.equal(fromFile.tossClientSecret, 'test-file-secret');
    const override = loadAppConfig({
      NODE_ENV: 'test',
      TOSS_CREDENTIALS_FILE: path,
      TOSS_CLIENT_ID: 'test-env-id',
      MARKET_DATA_PROVIDER: 'toss',
    });
    assert.equal(override.tossClientId, 'test-env-id');
    assert.equal(override.marketDataProvider, 'toss');
    assert.throws(() => loadAppConfig({ NODE_ENV: 'test', MARKET_DATA_PROVIDER: 'legacy' }));
    writeFileSync(path, '{malformed-test-file');
    assert.equal(
      loadAppConfig({ NODE_ENV: 'test', TOSS_CREDENTIALS_FILE: path }).tossClientId,
      undefined,
    );
    assert.equal(
      loadAppConfig({ NODE_ENV: 'test', TOSS_CREDENTIALS_FILE: `${path}.missing` })
        .tossClientSecret,
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SEC user agent declares both application identity and contact email', () => {
  assert.throws(() => loadAppConfig({ NODE_ENV: 'test', SEC_USER_AGENT: 'ops@example.com' }));
  assert.equal(
    loadAppConfig({ NODE_ENV: 'test', SEC_USER_AGENT: 'Orsem ops@example.com' }).secUserAgent,
    'Orsem ops@example.com',
  );
});

test('production refuses fixture mode and missing secrets', () => {
  assert.throws(() => loadAppConfig({ NODE_ENV: 'production', FIXTURE_MODE: 'true' }));
});

test('production refuses the example database credential', () => {
  assert.throws(() =>
    loadAppConfig({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://orsem.example',
      DATABASE_URL: 'mysql://orsem:change-me@127.0.0.1:3306/orsem',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      SESSION_SECRET: 's'.repeat(32),
      TOTP_ENCRYPTION_KEY: `${'A'.repeat(43)}=`,
    }),
  );
});

test('configured Discord bearer token must have service-token entropy', () => {
  assert.throws(() => loadAppConfig({ NODE_ENV: 'test', DISCORD_SERVICE_TOKEN: 'too-short' }));
});

test('production TOTP encryption key must be canonical 32-byte base64', () => {
  const base = {
    NODE_ENV: 'production',
    WEB_ORIGIN: 'https://orsem.example',
    DATABASE_URL: 'mysql://orsem:test@127.0.0.1:3306/orsem',
    REDIS_URL: 'redis://127.0.0.1:6379/0',
    SESSION_SECRET: 's'.repeat(32),
    RAW_DOCUMENT_DIR: '/var/lib/orsem/raw',
  };
  assert.throws(() => loadAppConfig({ ...base, TOTP_ENCRYPTION_KEY: '!'.repeat(44) }));
  assert.equal(
    loadAppConfig({ ...base, TOTP_ENCRYPTION_KEY: `${'A'.repeat(43)}=` }).nodeEnv,
    'production',
  );
});

test('production requires an HTTPS browser origin', () => {
  assert.throws(() =>
    loadAppConfig({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'http://orsem.example',
      DATABASE_URL: 'mysql://orsem:test@127.0.0.1:3306/orsem',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      SESSION_SECRET: 's'.repeat(32),
      TOTP_ENCRYPTION_KEY: `${'A'.repeat(43)}=`,
    }),
  );
});

test('production refuses temporary raw-document storage', () => {
  assert.throws(() =>
    loadAppConfig({
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://orsem.example',
      DATABASE_URL: 'mysql://orsem:test@127.0.0.1:3306/orsem',
      REDIS_URL: 'redis://127.0.0.1:6379/0',
      SESSION_SECRET: 's'.repeat(32),
      TOTP_ENCRYPTION_KEY: `${'A'.repeat(43)}=`,
      RAW_DOCUMENT_DIR: '/tmp/orsem/raw',
    }),
  );
});

test('service connection strings reject the wrong protocols at the config boundary', () => {
  assert.equal(
    loadAppConfig({
      NODE_ENV: 'test',
      FIXTURE_MODE: 'true',
      DATABASE_URL: 'mysql://user:pass@db/orsem',
    }).databaseUrl,
    'mysql://user:pass@db/orsem',
  );
  assert.throws(() =>
    loadAppConfig({
      NODE_ENV: 'test',
      FIXTURE_MODE: 'true',
      DATABASE_URL: 'https://db.example/orsem',
    }),
  );
  assert.throws(() =>
    loadAppConfig({ NODE_ENV: 'test', FIXTURE_MODE: 'true', REDIS_URL: 'mysql://cache/orsem' }),
  );
});
