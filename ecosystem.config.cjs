const path = require('node:path');
const { readFileSync } = require('node:fs');
const { parseEnv } = require('node:util');

const root = __dirname;
const envPath = path.join(root, '.env');
let fileEnvironment = {};
try {
  fileEnvironment = parseEnv(readFileSync(envPath, 'utf8'));
  // PM2는 자식 프로세스의 `--env-file` 처리 전에 이 파일을 평가합니다.
  // ORSEM_DATA_DIR이 원문·로그 경로 계산에 반영되도록 여기서도 저장소 환경을 읽습니다.
  // 기존 셸·PM2 변수의 우선순위는 유지합니다.
  process.loadEnvFile(envPath);
} catch {
  // 각 프로세스의 설정 검증에서 누락된 필수 값을 알립니다.
}

function fileBackedEnvironment(names) {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = Object.hasOwn(fileEnvironment, name)
        ? fileEnvironment[name]
        : process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

// PM2는 재시작해도 애플리케이션의 이전 환경을 유지합니다.
// AI 설정을 사용하는 두 프로세스에 분류기 키를 명시적으로 전달해,
// 오래된 AI_ENABLED/AI_MODEL 값이 수정된 .env 값을 가리지 않게 합니다.
const aiEnvironment = fileBackedEnvironment([
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'AI_ENABLED',
  'AI_TIMEOUT_MS',
]);
// 번역 설정도 PM2에 남은 이전 값보다 현재 환경 파일을 우선합니다.
const newsTranslationEnvironment = fileBackedEnvironment([
  'NEWS_TRANSLATION_ENABLED',
  'OLLAMA_URL',
  'NEWS_TRANSLATION_MODEL',
  'NEWS_TRANSLATION_BATCH_SIZE',
  'NEWS_TRANSLATION_TIMEOUT_MS',
]);
// 같은 이유로 커넥터 설정도 명시적으로 갱신합니다. Node의 --env-file은
// 상속받은 변수를 덮어쓰지 않으므로, 이렇게 하지 않으면 PM2에 남은
// 빈 SEC_USER_AGENT가 .env의 유효한 값을 가릴 수 있습니다.
const connectorEnvironment = fileBackedEnvironment([
  'LOGO_DEV_ENABLED',
  'LOGO_DEV_PUBLISHABLE_KEY',
  'LOGO_DEV_MONTHLY_LIMIT',
  'BRANDFETCH_ENABLED',
  'BRANDFETCH_CLIENT_ID',
  'BRANDFETCH_MONTHLY_LIMIT',
  'OPENDART_API_KEY',
  'OPENDART_GLOBAL_ALERT_TYPES',
  'OPENDART_POLL_OVERLAP_DAYS',
  'MARKET_DATA_PROVIDER',
  'TOSS_CREDENTIALS_FILE',
  'TOSS_CLIENT_ID',
  'TOSS_CLIENT_SECRET',
  'GOLD_API_KEY',
  'EIA_API_KEY',
  'WEB_PUSH_CREDENTIALS_FILE',
  'WEB_PUSH_PUBLIC_KEY',
  'WEB_PUSH_PRIVATE_KEY',
  'WEB_PUSH_SUBJECT',
  'TOSS_MAX_SUBSCRIPTIONS',
  'KAKAO_CREDENTIALS_FILE',
  'KAKAO_CLIENT_ID',
  'KAKAO_CLIENT_SECRET',
  'KAKAO_REDIRECT_URI',
  'NAVER_API_PROVIDER',
  'NAVER_CLIENT_ID',
  'NAVER_CLIENT_SECRET',
  'NAVER_NEWS_FREE_UNTIL',
  'NAVER_NEWS_FREE_MONTH',
  'NAVER_NEWS_FREE_REQUESTS',
  'NAVER_NEWS_DAILY_LIMIT',
  'NAVER_NEWS_MONTHLY_LIMIT',
  'SEC_USER_AGENT',
  'SEC_BACKFILL_MAX_REQUESTS',
  'SEC_FORM4_ENABLED',
  'ALPACA_NEWS_ENABLED',
  'MARKETAUX_NEWS_ENABLED',
  'MARKETAUX_API_TOKEN',
  'MARKETAUX_NEWS_DAILY_BUDGET',
  'MARKETAUX_NEWS_REQUESTS_PER_RUN',
  'ALPHAVANTAGE_NEWS_ENABLED',
  'ALPHAVANTAGE_API_KEY',
  'ALPHAVANTAGE_NEWS_DAILY_BUDGET',
  'ALPHAVANTAGE_NEWS_REQUESTS_PER_RUN',
  'FINNHUB_NEWS_ENABLED',
  'FINNHUB_API_KEY',
  'FINNHUB_NEWS_DAILY_BUDGET',
  'FINNHUB_NEWS_REQUESTS_PER_RUN',
  'GDELT_OVERLAP_MINUTES',
  'GDELT_MAX_SPLIT_DEPTH',
  'ALPACA_API_KEY',
  'ALPACA_API_SECRET',
  'ALPACA_TRADING_BASE_URL',
  'GDELT_ENABLED',
  'GDELT_NEWS_DOMAINS',
  'IR_FEED_URLS',
  'NEWS_RSS_FEEDS',
  'HTTP_TIMEOUT_MS',
]);
const dataDir = process.env.ORSEM_DATA_DIR || '/home/laeti/orsem-data';
const rawDocumentDir = process.env.RAW_DOCUMENT_DIR || path.join(dataDir, 'raw');
const ollamaRoot = process.env.OLLAMA_ROOT || path.join(dataDir, 'ollama');
const ollamaBinary = process.env.OLLAMA_BIN || path.join(ollamaRoot, 'runtime/bin/ollama');
const ollamaModels = process.env.OLLAMA_MODELS || path.join(ollamaRoot, 'models');
// 다른 앱이 이전 Node로 공용 PM2 데몬을 시작했을 수 있습니다.
// 부팅 복원 시 데몬의 실행 파일을 상속하지 않도록, Orsem 자식 프로세스를
// 이 명령이 사용하는 Node 또는 명시적으로 지정한 실행 파일로 고정합니다.
const nodeInterpreter = process.env.ORSEM_NODE_BIN || process.execPath;

const common = {
  cwd: root,
  autorestart: true,
  watch: false,
  time: true,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 3_000,
  exp_backoff_restart_delay: 200,
  kill_timeout: 15_000,
  listen_timeout: 15_000,
  merge_logs: true,
  env: {
    NODE_ENV: 'production',
    TZ: 'Asia/Seoul',
    ORSEM_DATA_DIR: dataDir,
    RAW_DOCUMENT_DIR: rawDocumentDir,
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'orsem-ollama',
      script: ollamaBinary,
      args: 'serve',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '12G',
      kill_timeout: 30_000,
      env: {
        ...common.env,
        OLLAMA_HOST: '127.0.0.1:11434',
        OLLAMA_MODELS: ollamaModels,
        OLLAMA_CONTEXT_LENGTH: '4096',
        OLLAMA_KEEP_ALIVE: '5m',
        OLLAMA_MAX_LOADED_MODELS: '1',
        OLLAMA_NUM_PARALLEL: '1',
        OLLAMA_NO_CLOUD: 'true',
        OLLAMA_NOHISTORY: 'true',
      },
    },
    {
      ...common,
      name: 'orsem-api',
      script: 'apps/api/dist/main.js',
      interpreter: nodeInterpreter,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      node_args: '--env-file=.env --max-old-space-size=416',
      env: {
        ...common.env,
        ...aiEnvironment,
        ...connectorEnvironment,
      },
    },
    {
      ...common,
      name: 'orsem-worker',
      script: path.join(dataDir, 'worker/current/bin/python'),
      args: '-m orsem_worker',
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '768M',
      kill_timeout: 660_000,
      env: {
        ...common.env,
        ...aiEnvironment,
        ...newsTranslationEnvironment,
        ...connectorEnvironment,
        ORSEM_REPO_ROOT: root,
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
    {
      ...common,
      name: 'orsem-discord',
      script: 'apps/discord-bot/dist/index.js',
      interpreter: nodeInterpreter,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      node_args: '--env-file=.env --max-old-space-size=192',
    },
  ],
};
