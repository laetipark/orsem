import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkKakaoConfig } from './check-kakao-config.mjs';

test('Kakao diagnostics identify a missing REST API key without printing the configured secret', () => {
  const result = checkKakaoConfig({ KAKAO_CLIENT_SECRET: 'private-test-secret' });
  assert.equal(result.state, 'DISABLED');
  assert.match(result.detail, /missing KAKAO_CLIENT_ID/);
  assert.doesNotMatch(JSON.stringify(result), /private-test-secret/);
});

test('Kakao diagnostics honor external file fields and environment overrides', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orsem-kakao-doctor-'));
  const file = join(directory, 'kakao.json');
  try {
    writeFileSync(
      file,
      JSON.stringify({
        clientId: 'test-id',
        clientSecret: 'private-test-secret',
        redirectUri: 'https://orsem.example/api/v1/auth/kakao/callback',
      }),
    );
    const env = {
      KAKAO_CREDENTIALS_FILE: ` ${file} `,
      WEB_ORIGIN: 'https://orsem.example',
      NODE_ENV: 'production',
    };
    assert.equal(checkKakaoConfig(env).state, 'OK');
    assert.equal(checkKakaoConfig({ ...env, FIXTURE_MODE: 'true' }).state, 'DISABLED');
    assert.equal(
      checkKakaoConfig({ ...env, KAKAO_REDIRECT_URI: 'https://wrong.example/callback' }).state,
      'FAIL',
    );
    assert.equal(checkKakaoConfig({ ...env, WEB_ORIGIN: 'http://orsem.example' }).state, 'FAIL');
    for (const invalid of ['{"private-test-secret":', 'null', '[]', '{"clientId":42}']) {
      writeFileSync(file, invalid);
      const result = checkKakaoConfig(env);
      assert.equal(result.state, 'FAIL');
      assert.doesNotMatch(JSON.stringify(result), /private-test-secret/);
      assert.equal(
        checkKakaoConfig({ ...env, KAKAO_CLIENT_ID: 'env-id', KAKAO_CLIENT_SECRET: 'env-secret' })
          .state,
        'OK',
      );
    }
    assert.equal(
      checkKakaoConfig({ KAKAO_CREDENTIALS_FILE: join(directory, 'missing') }).state,
      'FAIL',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
