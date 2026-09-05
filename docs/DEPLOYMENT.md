# 배포

저장소는 배포용 설정을 제공하지만 MySQL, Nginx, DNS, TLS, Redis, PM2를 자동으로 변경하지 않습니다.

## 1. 실행 데이터 준비

```bash
mkdir -p /home/laeti/orsem-data/raw /home/laeti/orsem-data/logs
chmod 700 /home/laeti/orsem-data
```

## 2. MySQL과 환경 설정

`deploy/mysql/bootstrap.example.sql`을 검토하고 비밀번호를 바꾼 뒤 MySQL 관리자로 실행합니다. 비밀번호가 포함된 연결 URL은 저장소 밖의 환경 파일이나 시크릿 저장소에 보관하고 프로세스 환경으로 주입합니다. 저장소 루트 `.env`에는 비밀이 아닌 실행 설정과 외부 자격 증명 파일 경로만 둡니다. 현재 실행기별 주입 방법과 우선순위는 [서비스별 자격 증명 관리](CREDENTIALS.md)를 참고합니다.

```bash
cp .env.example .env
chmod 600 .env
```

API, DB 마이그레이션 CLI, worker, Discord 프로세스, Vite 설정은 모두 이 루트 파일을 읽습니다. 직접 실행에서는 기존 프로세스 환경 값이 우선하지만, PM2 ecosystem의 AI·커넥터 변수와 부팅 스크립트에는 루트 파일이 우선하는 별도 처리가 있습니다. 외부 환경 파일로 옮긴 동일 키를 루트 `.env`에 중복해서 두지 않습니다. 작업 공간마다 서로 다른 `.env`를 만들지 않습니다.

### 운영 환경 계약

핵심 운영 API에는 다음 값이 필요합니다.

| 변수                                  | 요구사항                                                                |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`                            | `production`                                                            |
| `FIXTURE_MODE`                        | `false`, 운영 시작 시 `true` 거절                                       |
| `DATABASE_URL`                        | MySQL 8용 `mysql://` URL                                                |
| `REDIS_URL`                           | `redis://` 또는 `rediss://`, 사용할 수 없으면 운영 세션을 허용하지 않음 |
| `WEB_ORIGIN`                          | 정확한 공개 브라우저 출처, 예: `https://orsem.laetipark.me`             |
| `SESSION_SECRET`                      | 독립적으로 생성한 무작위 문자 32개 이상                                 |
| `TOTP_ENCRYPTION_KEY`                 | 정확히 32바이트인 무작위 값의 정규 base64 인코딩                        |
| `ORSEM_DATA_DIR` / `RAW_DOCUMENT_DIR` | 저장소 밖의 절대 경로                                                   |

예시 문구를 그대로 배포하지 말고 각각 독립적인 비밀 값을 생성합니다.

```bash
openssl rand -base64 48
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

첫 번째 출력은 `SESSION_SECRET`, 두 번째 출력은 `TOTP_ENCRYPTION_KEY`에 사용합니다. `REDIS_PREFIX`는 선택 값이며 기본값은 `orsem:`입니다. 다른 서비스와 Redis를 공유하면 별도의 접두사를 사용합니다. `PORT`, `LOG_LEVEL`, `TZ` 기본값은 각각 `3210`, `log`, 호스트 시간대입니다. 제공하는 배포 설정은 `TZ=Asia/Seoul`을 명시합니다.

소스 자격 증명은 선택 항목이며, 없으면 해당 커넥터만 비활성화합니다. `OPENDART_API_KEY`, 뉴스 검색용 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` 쌍, `SEC_USER_AGENT`, 자산 마스터용 `ALPACA_API_KEY`/`ALPACA_API_SECRET` 쌍은 서로 독립적입니다. Alpaca는 기업 식별 정보만 제공합니다. `SEC_USER_AGENT`에는 애플리케이션 식별 정보와 확인 가능한 연락처 이메일을 넣습니다. 뉴스 본문은 코드에 정책과 정확한 URL이 등록된 Samsung Global, Federal Reserve, BLS만 사용합니다. `IR_FEED_URLS`의 임의 URL은 거절하고 `GDELT_ENABLED=false`를 유지합니다. `AI_ENABLED`와 `NEWS_TRANSLATION_ENABLED`는 서로 독립적인 명시적 불리언 값입니다.

차트에는 `MARKET_DATA_PROVIDER=toss`가 필요합니다. 토스 클라이언트 ID와 시크릿은 `TOSS_CREDENTIALS_FILE`이 가리키는 외부 JSON 파일에 보관하거나 `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`을 프로세스 환경에 직접 주입합니다. 토스 자격 증명이 없어도 나머지 애플리케이션은 실행되며 연결 설정 필요 상태를 표시합니다. 테스트 전에 토스 WTS에 서버 IP를 등록합니다. [토스 설정 절차](OPERATIONS.md#toss-securities-chart-setup)를 참고하세요. KRX/Alpaca EOD 일정은 종료되었고 이전 큐 작업으로 새 가격을 수집할 수 없습니다. 갱신된 API·worker를 시작하기 전에 소스 메타데이터 마이그레이션을 적용합니다. 스키마 마이그레이션은 기존 데이터를 보존하며, 종료된 가격 데이터와 수집 상태는 [운영 문서](OPERATIONS.md)에 따라 별도로 정리합니다. 마이그레이션·빌드 성공은 자격 증명이나 연결 성공을 검증하지 않습니다.

카카오 가입·로그인은 선택 기능입니다. API를 재시작하기 전에 `AddKakaoMembers` 마이그레이션을 적용하고, [카카오 로그인 설정](KAKAO_LOGIN.md)에 따라 외부 자격 증명 파일, 카카오 로그인·OpenID Connect, 정확한 콜백 URI를 설정합니다. 자격 증명이 없으면 로컬 관리자 로그인은 유지되고 카카오 로그인은 비활성화됩니다. 신규 카카오 회원이 데이터를 조회하려면 관리자 승인이 필요합니다.

worker 한도는 `OPENDART_POLL_OVERLAP_DAYS=3`(1–31), `HTTP_TIMEOUT_MS=15000`(1,000–120,000)입니다. AI 분류기를 활성화하면 `AI_BASE_URL`과 `AI_MODEL`도 필요합니다. 인증이 없는 로컬 경로에서는 `AI_API_KEY`를 생략할 수 있습니다. `AI_TIMEOUT_MS`는 소스 HTTP 제한 시간과 독립적이며 기본값은 120초입니다. CPU 모델의 최초 시작을 기다리면서도 소스 커넥터 한도를 늦추거나 완화하지 않기 위한 설정입니다.

### 로컬 Ollama 분류기

PM2 설정에는 `127.0.0.1:11434`에만 연결되는 선택적 Ollama 프로세스가 포함됩니다. Ollama 클라우드 추론을 끄고, 로드된 모델 하나와 동시 요청 하나로 제한하며, 모든 모델 데이터는 저장소 밖에 보관합니다. 기본 경로는 다음과 같습니다.

- 실행 파일: `${ORSEM_DATA_DIR}/ollama/runtime/bin/ollama`
- 모델: `${ORSEM_DATA_DIR}/ollama/models`

`OLLAMA_ROOT`, `OLLAMA_BIN`, `OLLAMA_MODELS`로 경로를 바꿀 수 있습니다. 해당 위치에 공식 Linux 실행 파일을 설치하고 `orsem-ollama`를 시작한 뒤, CPU 실행에 맞춰 지정한 모델을 가져옵니다.

```bash
pm2 start ecosystem.config.cjs --only orsem-ollama
OLLAMA_HOST=127.0.0.1:11434 /home/laeti/orsem-data/ollama/runtime/bin/ollama pull qwen3.5:4b-q4_K_M
```

`AI_BASE_URL=http://127.0.0.1:11434/v1`, `AI_API_KEY=ollama`, `AI_MODEL=qwen3.5:4b-q4_K_M`, `AI_ENABLED=true`를 설정합니다. 여기서 키는 비밀 값이 아닌 호환용 자리표시자입니다. Ollama 제안은 검토 증거로 저장하며 결정적 거래 분류를 덮어쓰지 않습니다.

AI 작업은 동시 실행 수가 1인 전용 `orsem-ai-review` 큐에서 실행하므로, 느린 CPU 추론이 공시 후처리나 지연된 조회용 데이터 생성 worker를 점유하지 않습니다.

뉴스 한국어 번역은 `NEWS_TRANSLATION_ENABLED`로 별도 활성화합니다. 같은 Ollama를 사용하되 `OLLAMA_URL=http://127.0.0.1:11434`와 `NEWS_TRANSLATION_MODEL`로 연결하며 외부 번역 API나 클라우드 모델로 자동 전환하지 않습니다. `news_article_contents` 마이그레이션을 적용하고 로컬 모델을 준비한 뒤 실행합니다. 기본 1분·3건 처리, 제목·전문 완료 게이트, 원문 보존과 표시 확인 절차는 [뉴스 번역 설정](NEWS_TRANSLATION.md#설정)을 참고하세요.

운영 웹 빌드에는 `VITE_FIXTURE_MODE=false`를 설정하고 일반적으로 `VITE_API_BASE_URL=/api/v1`을 유지합니다. `VITE_PORT`와 `VITE_API_PROXY_TARGET`은 Vite 개발 서버에만 영향을 줍니다. Discord에는 `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_CHANNEL_ID`와 API·봇 양쪽에 동일하게 설정한 독립적인 무작위 `DISCORD_SERVICE_TOKEN`이 필요합니다. 운영 허용 목록은 쉼표로 구분한 `DISCORD_ALLOWED_USER_IDS`를 사용합니다. `DISCORD_GUILD_ID`, 조회 주기, 내부 API URL은 선택 항목입니다.

## 3. 빌드와 마이그레이션

```bash
npm ci
npm run build
npm run db:migrate
npm run admin:create -- --email you@example.com
```

관리자 명령은 `--password`를 생략하면 비밀번호를 생성하고, 해당 비밀번호·TOTP 등록 URI·일회용 복구 코드를 정확히 한 번 출력합니다. 이 값은 저장소 밖에 보관합니다. `ADMIN_EMAIL`과 `ADMIN_PASSWORD`는 CLI에서 한 번 사용할 수 있는 대체 환경 변수이며, 서비스 환경에 `ADMIN_PASSWORD`를 계속 남겨 두지 않습니다.

`NODE_ENV=production`이면 API와 마이그레이션 CLI는 명시적으로 유효한 `mysql://` `DATABASE_URL`이 없을 때 시작을 거절하고, 개발용 예시 `change-me`도 거절합니다. 로컬 개발 자격 증명으로 대체하지 않습니다.

## 4. 프로세스 시작

```bash
pm2 start ecosystem.config.cjs --only orsem-api,orsem-worker
pm2 save
```

앞서 설명한 로컬 분류기를 설정해 사용할 때만 `orsem-ollama`를 시작합니다. Discord 토큰이 없으면 `orsem-discord`는 의도적으로 설정 검증에 실패합니다. Discord 변수와 비어 있지 않은 운영 허용 목록을 설정한 뒤 `pm2 start ecosystem.config.cjs --only orsem-discord`로 시작하고, 갱신된 프로세스 목록을 다시 저장합니다.

### PC 재부팅 후 자동 시작

`pm2 save`는 프로세스 목록을 저장할 뿐 부팅 작업을 설치하지는 않습니다. 이 호스트는 사용자 crontab으로 이미 시작하는 다른 애플리케이션과 PM2를 공유합니다. 기존 항목은 유지하고 `crontab -e`로 Orsem 전용 `@reboot` 항목 하나를 추가합니다.

```cron
@reboot /usr/bin/flock -n /home/laeti/orsem-data/orsem-boot.lock /home/laeti/.nvm/versions/node/v24.14.1/bin/node /home/laeti/orsem/scripts/start-at-boot.mjs >> /home/laeti/orsem-data/logs/boot.log 2>&1
```

Node 24를 업그레이드하거나 옮기면 절대 경로를 수정합니다. 부팅 스크립트는 다른 앱이 이전 Node로 공용 PM2 데몬을 시작했더라도 Orsem의 PM2 자식 프로세스가 이 Node 실행 파일을 사용하도록 고정합니다. 수동 ecosystem 명령에서도 `ORSEM_NODE_BIN`으로 실행 파일을 명시할 수 있습니다.

스크립트는 MySQL·Redis TCP 연결을 최대 3분 기다린 뒤 API와 worker를 시작하고, 필요한 설정이 있을 때만 로컬 Ollama·Discord를 시작합니다. 이미 실행 중이거나 시작 중인 Orsem 프로세스는 건드리지 않습니다. 패키지 설치, 코드 빌드, 마이그레이션, 전역 PM2 저장본 복원, 다른 애플리케이션의 중지·재시작은 수행하지 않습니다. 기존 `cron`, MySQL, Redis, Nginx 서비스를 활성화 상태로 유지합니다. 사용자 crontab 부팅 작업에는 데스크톱 로그인이나 `loginctl enable-linger`가 필요하지 않습니다.

실행 중인 프로세스를 바꾸지 않고 검증합니다.

```bash
/home/laeti/.nvm/versions/node/v24.14.1/bin/node scripts/start-at-boot.mjs --check
npm run test:boot
```

부팅 설정을 변경한 뒤에는 해당 스크립트를 한 번 직접 실행해 API 준비 상태, worker 시작, 선택 프로세스를 확인합니다. 다음 실제 부팅 후 `/home/laeti/orsem-data/logs/boot.log`를 확인합니다. 수정 전에 기존 crontab을 백업하며, 이 항목에 별도의 Orsem 부팅 작업이나 전역 `pm2 kill`을 함께 적용하지 않습니다.

## 5. Nginx와 TLS

`deploy/nginx/orsem.laetipark.me.conf`를 검토하고 시스템 Nginx 설정에 복사하거나 심볼릭 링크로 연결한 뒤, `nginx -t`를 실행하고 Nginx를 다시 불러옵니다. 이어 `orsem.laetipark.me`의 유효한 인증서를 준비합니다. 앱과 API는 같은 출처를 사용하므로 브라우저에 광범위한 CORS 허용이 필요하지 않습니다.

## 검증

- `/api/v1/health/live`는 MySQL에 접근하지 않고 응답합니다.
- `/api/v1/health/ready`는 MySQL과 Redis를 확인합니다.
- 로컬 AI가 활성화되어 있으면 `http://127.0.0.1:11434/v1/models`가 지정한 Ollama 모델을 로컬에서 보여줍니다.
- 로그인, TOTP, 로그아웃, CSRF 실패 경로가 동작합니다.
- 개발용 테스트 데이터 미리보기는 소스 키 없이 표시됩니다. 운영에서는 미설정 소스의 상태를 비활성으로 표시하며 가짜 이벤트를 만들지 않습니다.
- 보이는 기업 페이지는 토스 차트와 현재가를 2초마다 조회합니다. [토스 검증 절차](OPERATIONS.md#toss-securities-chart-setup)에 따라 공급자 시각과 신선도를 비교합니다.
- OpenDART 반복 조회나 프로세스 재시작으로 공시·알림이 중복되지 않습니다.
