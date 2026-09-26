# 배포

저장소는 배포용 설정을 제공하지만 MySQL, Nginx, DNS, TLS, Redis, PM2를 자동으로 변경하지 않습니다.

이 문서의 **1–5단계와 검증**은 적용 절차입니다. 완료된 배포의 수치·백업·복구 증거는 [배포 이력](DEPLOYMENT_HISTORY.md)과 [날짜별 기록](README.md#날짜별-기록)에서 확인합니다. 기록 속 명령과 환경 주소를 새 배포에 그대로 적용하지 않습니다.

## 1. 실행 데이터 준비

```bash
mkdir -p ../orsem-data/raw ../orsem-data/logs
chmod 700 ../orsem-data
```

## 2. MySQL과 환경 설정

`deploy/mysql/bootstrap.example.sql`을 검토하고 비밀번호를 바꾼 뒤 MySQL 관리자로 실행합니다. 비밀번호가 포함된 연결 URL은 저장소 밖의 환경 파일이나 시크릿 저장소에 보관하고 프로세스 환경으로 주입합니다. 저장소 루트 `.env`에는 비밀이 아닌 실행 설정과 외부 자격 증명 파일 경로만 둡니다. 현재 실행기별 주입 방법과 우선순위는 [서비스별 자격 증명 관리](CREDENTIALS.md)를 참고합니다.

```bash
cp .env.example .env
chmod 600 .env
```

API, DB 마이그레이션 CLI, worker, Discord 프로세스, Vite 설정은 모두 이 루트 파일을 읽습니다. 직접 실행에서는 기존 프로세스 환경 값이 우선하지만, PM2 ecosystem의 AI·커넥터 변수와 부팅 스크립트에는 루트 파일이 우선하는 별도 처리가 있습니다. 외부 환경 파일로 옮긴 동일 키를 루트 `.env`에 중복해서 두지 않습니다. 작업 공간마다 서로 다른 `.env`를 만들지 않습니다.

### 운영 환경 계약

월간 시총 목록 마이그레이션은 `market_leader_watchlist`와 `market_leader_company_links` 뷰를 사용합니다. 기존 설치에서 뷰 생성 권한이 없다면 MySQL 관리자가 [객체별 권한 SQL](../deploy/mysql/monthly-market-leader-views.sql)을 먼저 실행합니다. 권한은 두 뷰 이름에만 한정하며 일반 테이블 삭제나 다른 뷰 생성 권한은 추가하지 않습니다. 운영 계정의 비밀번호를 관리자 비밀번호로 교체하지 않습니다.

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
| `ORSEM_DATA_DIR` / `RAW_DOCUMENT_DIR` | `../orsem-data` / `../orsem-data/raw`를 해석한 저장소 밖의 절대 경로    |

예시 문구를 그대로 배포하지 말고 각각 독립적인 비밀 값을 생성합니다.

파일 경로는 프로젝트 루트에서 `realpath ../orsem-data`와 `realpath ../orsem-data/raw`로 구한 값을 환경에 기록합니다. `.env` 자체는 셸 변수나 명령 치환을 실행하지 않습니다.

```bash
openssl rand -base64 48
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

첫 번째 출력은 `SESSION_SECRET`, 두 번째 출력은 `TOTP_ENCRYPTION_KEY`에 사용합니다. `REDIS_PREFIX`는 선택 값이며 기본값은 `orsem:`입니다. 다른 서비스와 Redis를 공유하면 별도의 접두사를 사용합니다. `PORT`, `LOG_LEVEL`, `TZ` 기본값은 각각 `3210`, `log`, 호스트 시간대입니다. 제공하는 배포 설정은 `TZ=Asia/Seoul`을 명시합니다.

소스 자격 증명은 선택 항목이며, 없으면 해당 커넥터만 비활성화합니다. `OPENDART_API_KEY`, 뉴스 검색용 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET` 쌍, `SEC_USER_AGENT`, 자산 마스터용 `ALPACA_API_KEY`/`ALPACA_API_SECRET` 쌍은 서로 독립적입니다. Alpaca는 기업 식별 정보만 제공합니다. `SEC_USER_AGENT`에는 애플리케이션 식별 정보와 확인 가능한 연락처 이메일을 넣습니다. 뉴스는 등록된 Samsung Global, Federal Reserve, BLS, EIA의 RSS 제목·제공 요약만 수집하며 기사 페이지와 임베디드 본문을 저장하지 않습니다. `IR_FEED_URLS`의 임의 URL은 거절하고 `GDELT_ENABLED=false`를 유지합니다. `AI_ENABLED`와 `NEWS_TRANSLATION_ENABLED`는 서로 독립적인 명시적 불리언 값입니다.

차트에는 `MARKET_DATA_PROVIDER=toss`가 필요합니다. 토스 클라이언트 ID와 시크릿은 `TOSS_CREDENTIALS_FILE`이 가리키는 외부 JSON 파일에 보관하거나 `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET`을 프로세스 환경에 직접 주입합니다. 토스 자격 증명이 없어도 나머지 애플리케이션은 실행되며 연결 설정 필요 상태를 표시합니다. 테스트 전에 토스 WTS에 서버 IP를 등록합니다. [토스 설정 절차](OPERATIONS.md#toss-securities-chart-setup)를 참고하세요. KRX/Alpaca EOD 일정은 종료되었고 이전 큐 작업으로 새 가격을 수집할 수 없습니다. 갱신된 API·worker를 시작하기 전에 소스 메타데이터 마이그레이션을 적용합니다. 스키마 마이그레이션은 기존 데이터를 보존하며, 종료된 가격 데이터와 수집 상태는 [운영 문서](OPERATIONS.md)에 따라 별도로 정리합니다. 마이그레이션·빌드 성공은 자격 증명이나 연결 성공을 검증하지 않습니다.

카카오 가입·로그인은 선택 기능입니다. API를 재시작하기 전에 `AddKakaoMembers` 마이그레이션을 적용하고, [카카오 로그인 설정](KAKAO_LOGIN.md)에 따라 외부 자격 증명 파일, 카카오 로그인·OpenID Connect, 정확한 콜백 URI를 설정합니다. 자격 증명이 없으면 로컬 관리자 로그인은 유지되고 카카오 로그인은 비활성화됩니다. 신규 카카오 회원이 데이터를 조회하려면 관리자 승인이 필요합니다.

worker 한도는 `OPENDART_POLL_OVERLAP_DAYS=3`(1–31), `HTTP_TIMEOUT_MS=15000`(1,000–120,000)입니다. AI 분류기를 활성화하면 `AI_BASE_URL`과 `AI_MODEL`도 필요합니다. 인증이 없는 로컬 경로에서는 `AI_API_KEY`를 생략할 수 있습니다. `AI_TIMEOUT_MS`는 소스 HTTP 제한 시간과 독립적이며 기본값은 120초입니다. CPU 모델의 최초 시작을 기다리면서도 소스 커넥터 한도를 늦추거나 완화하지 않기 위한 설정입니다.

### 로컬 Ollama 분류기

PM2 설정에는 `127.0.0.1:11434`에만 연결되는 선택적 Ollama 프로세스가 포함됩니다. Ollama 클라우드 추론을 끄고, 로드된 모델 하나와 동시 요청 하나로 제한하며, 모든 모델 데이터는 저장소 밖에 보관합니다. 모델은 마지막 추론 후 5분 유휴 시 해제합니다. 이 설정은 Ollama 재시작 후 적용되므로 활성 AI·번역 작업이 끝난 뒤 해당 서비스만 재시작합니다. 기본 경로는 다음과 같습니다.

- 실행 파일: `${ORSEM_DATA_DIR}/ollama/runtime/bin/ollama`
- 모델: `${ORSEM_DATA_DIR}/ollama/models`

`OLLAMA_ROOT`, `OLLAMA_BIN`, `OLLAMA_MODELS`로 경로를 바꿀 수 있습니다. 해당 위치에 공식 Linux 실행 파일을 설치하고 `orsem-ollama`를 시작한 뒤, CPU 실행에 맞춰 지정한 모델을 가져옵니다.

```bash
pm2 start ecosystem.config.cjs --only orsem-ollama
OLLAMA_HOST=127.0.0.1:11434 ../orsem-data/ollama/runtime/bin/ollama pull qwen3.5:4b-q4_K_M
```

`AI_BASE_URL=http://127.0.0.1:11434/v1`, `AI_API_KEY=ollama`, `AI_MODEL=qwen3.5:4b-q4_K_M`, `AI_ENABLED=true`를 설정합니다. 여기서 키는 비밀 값이 아닌 호환용 자리표시자입니다. Ollama 제안은 검토 증거로 저장하며 결정적 거래 분류를 덮어쓰지 않습니다.

AI 작업은 동시 실행 수가 1인 전용 `orsem-ai-review` 큐에서 실행하므로, 느린 CPU 추론이 공시 후처리나 지연된 조회용 데이터 생성 worker를 점유하지 않습니다.

뉴스 한국어 번역은 `NEWS_TRANSLATION_ENABLED`로 별도 활성화합니다. 승인된 `OLLAMA_URL`과 로컬 `NEWS_TRANSLATION_MODEL`을 지정하며 외부 번역 API나 클라우드 모델로 자동 전환하지 않습니다. `AddManualNewsTranslations1788405000000`이 아직 적용되지 않았다면 먼저 적용하고, `UseNewsMetadataOnly1788411000000`과 호환되는 API·worker를 배포합니다. 기본 1분·최대 3건의 제목·요약만 번역하며 본문 존재·본문 번역 완료 조건은 사용하지 않습니다. 번역 대기·실패 시 원문 메타데이터를 표시합니다. [뉴스 번역 설정](NEWS_TRANSLATION.md#설정과-재시도)과 [기존 본문 정리 순서](NEWS_TRANSLATION.md#기존-본문-정리와-배포-순서)를 참고하세요.

운영 웹 빌드에는 `VITE_FIXTURE_MODE=false`를 설정하고 일반적으로 `VITE_API_BASE_URL=/api/v1`을 유지합니다. `VITE_PORT`와 `VITE_API_PROXY_TARGET`은 Vite 개발 서버에만 영향을 줍니다. Discord에는 `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_CHANNEL_ID`와 API·봇 양쪽에 동일하게 설정한 독립적인 무작위 `DISCORD_SERVICE_TOKEN`이 필요합니다. 운영 허용 목록은 쉼표로 구분한 `DISCORD_ALLOWED_USER_IDS`를 사용합니다. `DISCORD_GUILD_ID`, 조회 주기, 내부 API URL은 선택 항목입니다.

## 3. 격리 빌드와 마이그레이션

운영 프로세스가 읽는 `apps/*/dist`와 `packages/*/dist`에서 빌드·타입 검사·테스트를 실행하지 않습니다. 저장소 밖의 별도 작업 복사본에서 Node.js 24로 빌드하며 workspace 패키지 링크도 그 복사본을 가리켜야 합니다. 운영 비밀 설정은 복사본에 넣지 않습니다.

```bash
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
python3 scripts/verify-in-isolation.py
```

검증기는 현재 변경 사항을 임시 복사본에 반영하고 그 안에서 `npm run check`와 `npm run build`를 실행합니다. Python 워커는 Ruff·mypy·pytest와 wheel 빌드로 검증합니다. MySQL·Redis 통합 검사는 폐기 가능한 스키마와 별도 Redis 접두사에서 수행하고 운영 데이터에 fixture를 넣지 않습니다. 운영 Python 환경에는 `pip install --require-hashes -r apps/worker/python/requirements.lock`으로 잠긴 의존성만 설치합니다.

배포 명세에는 파일별 대상·새 해시·기존 해시, 웹 산출물, 적용할 마이그레이션을 기록합니다. 운영 버전과 후보를 비교해 승인된 기능만 포함하고 다른 미배포 기능을 섞지 않습니다. 웹은 fixture 비활성 상태로 빌드합니다.

배포 전 MySQL 일관 스냅샷, 기존 실행 파일·웹 파일·비공개 설정·큐 정지 상태를 저장소 밖 백업 경로에 보존합니다. 해당 경로는 권한 700, 비공개 파일은 600을 사용합니다. 복구 스크립트와 파일 해시도 함께 보관합니다.

큐의 기존 정지 상태를 기록한 뒤 일시 정지하고 진행 중 작업이 끝난 다음 worker를 중지합니다. 뉴스 본문 정리 시에는 기존 편집 요청도 종료되도록 API를 중지하고 두 프로세스가 종료됐는지 확인합니다. Python 워커의 PM2 종료 유예는 660,000ms(11분)이며, 긴 AI·번역 작업은 큐 활성 수 0을 먼저 확인해 종료합니다. 명세에 등록된 마이그레이션만 순서대로 실행하고 API·Python 실행 환경 및 공유 패키지 산출물을 일관되게 교체합니다. API 준비 상태가 정상일 때 메타데이터 전용 worker를 시작하며 웹은 해시된 자산을 먼저 배치하고 index를 마지막으로 전환합니다. 큐는 배포 전 정지 상태로 복원합니다. 실패 시 이전 본문 작성 worker를 자동 재시작하는 일반 롤백을 실행하지 않습니다.

Python BullMQ는 기존 큐 이름·접두사·일반 작업 데이터를 재사용하고 정기 작업은 JobScheduler로 관리합니다. 전환 시 배포 명세에 포함된 정기 작업만 변경합니다. 일반 대기·실행·지연 작업은 보존하며, 남아 있는 legacy repeat가 있으면 워커 시작 검증이 중단됩니다. TypeScript 워커 소스·기존 파서 패키지·중복 스크립트 정리는 Python 전환 뒤 30분 관측을 통과하고 외부 복구 후보를 확인한 다음 수행합니다.

종목정보와 시장 선정은 `AddMarketSelectionProfiles1788410000000`의 네 개 추가 테이블을 사용합니다. 역마이그레이션으로 수집 자료를 지우지 않으며 애플리케이션 복구 시 추가 테이블은 보존합니다. `synchronize=false`를 유지합니다.

일반 배포의 복구 스크립트는 큐 정지·배수, 이전 서버 파일과 웹 index 복원, API·worker 재시작을 수행할 수 있습니다. 뉴스 본문 정리 이후에는 과거 `rollback.cjs`를 그대로 실행하면 본문 작성 worker가 다시 시작될 수 있으므로 메타데이터 전용 동작을 보존하는 복구 절차만 사용합니다. 본문 수집을 재활성화하거나 정리된 본문을 자동 복원하지 않습니다. 직전 웹 자산·실행 파일·과거 DB 백업은 보존하며 데이터베이스 전체 복원은 별도로 승인된 운영 절차입니다.

## 4. 프로세스 시작

Python 환경을 설치하고 `../orsem-data/worker/current`를 연결한 뒤 시작합니다. `ecosystem.config.cjs`의 워커 설정은 `script=../orsem-data/worker/current/bin/python`, `args=-m orsem_worker`, `interpreter=none`, 단일 fork 인스턴스입니다. `ORSEM_REPO_ROOT`로 공용 환경 설정 위치를 지정합니다. 워커는 Node.js나 npm을 거쳐 실행하지 않습니다.

```bash
pm2 start ecosystem.config.cjs --only orsem-api,orsem-worker
pm2 save
```

앞서 설명한 로컬 분류기를 설정해 사용할 때만 `orsem-ollama`를 시작합니다. Discord 토큰이 없으면 `orsem-discord`는 의도적으로 설정 검증에 실패합니다. Discord 변수와 비어 있지 않은 운영 허용 목록을 설정한 뒤 `pm2 start ecosystem.config.cjs --only orsem-discord`로 시작하고, 갱신된 프로세스 목록을 다시 저장합니다.

### PC 재부팅 후 자동 시작

`pm2 save`는 프로세스 목록을 저장할 뿐 부팅 작업을 설치하지는 않습니다. 이 호스트는 사용자 crontab으로 이미 시작하는 다른 애플리케이션과 PM2를 공유합니다. 기존 항목은 유지하고 `crontab -e`로 Orsem 전용 `@reboot` 항목 하나를 추가합니다. 먼저 프로젝트 루트와 Node.js 24의 실행 경로를 확인합니다.

```bash
pwd -P
command -v node
node --version
```

아래 `REPO_ROOT`와 `NODE_BINARY`는 각각 위에서 확인한 경로로 바꿉니다. cron에는 로그인 셸의 Node 버전 선택이 적용되지 않으므로 실행 파일을 명시합니다. `cd` 이후의 파일 경로는 프로젝트 루트를 기준으로 합니다.

```cron
@reboot cd "REPO_ROOT" && flock -n ../orsem-data/orsem-boot.lock "NODE_BINARY" scripts/start-at-boot.mjs >> ../orsem-data/logs/boot.log 2>&1
```

Node 24를 업그레이드하거나 옮기면 절대 경로를 수정합니다. 부팅 스크립트는 다른 앱이 이전 Node로 공용 PM2 데몬을 시작했더라도 Orsem의 PM2 자식 프로세스가 이 Node 실행 파일을 사용하도록 고정합니다. 수동 ecosystem 명령에서도 `ORSEM_NODE_BIN`으로 실행 파일을 명시할 수 있습니다.

스크립트는 MySQL·Redis TCP 연결을 최대 3분 기다린 뒤 API와 worker를 시작하고, 필요한 설정이 있을 때만 로컬 Ollama·Discord를 시작합니다. 이미 실행 중이거나 시작 중인 Orsem 프로세스는 건드리지 않습니다. 패키지 설치, 코드 빌드, 마이그레이션, 전역 PM2 저장본 복원, 다른 애플리케이션의 중지·재시작은 수행하지 않습니다. 기존 `cron`, MySQL, Redis, Nginx 서비스를 활성화 상태로 유지합니다. 사용자 crontab 부팅 작업에는 데스크톱 로그인이나 `loginctl enable-linger`가 필요하지 않습니다.

실행 중인 프로세스를 바꾸지 않고 검증합니다.

```bash
node scripts/start-at-boot.mjs --check
npm run test:boot
```

부팅 설정을 변경한 뒤에는 해당 스크립트를 한 번 직접 실행해 API 준비 상태, worker 시작, 선택 프로세스를 확인합니다. 다음 실제 부팅 후 `../orsem-data/logs/boot.log`를 확인합니다. 수정 전에 기존 crontab을 백업하며, 이 항목에 별도의 Orsem 부팅 작업이나 전역 `pm2 kill`을 함께 적용하지 않습니다.

## 5. Nginx와 TLS

`deploy/nginx/orsem.laetipark.me.conf`를 검토하고 시스템 Nginx 설정에 복사하거나 심볼릭 링크로 연결한 뒤, `nginx -t`를 실행하고 Nginx를 다시 불러옵니다. 이어 `orsem.laetipark.me`의 유효한 인증서를 준비합니다. 앱과 API는 같은 출처를 사용하므로 브라우저에 광범위한 CORS 허용이 필요하지 않습니다.

관심 종목의 PC 새창·항상 위 기능을 배포할 때는 API와 웹, Nginx 설정을 함께 반영합니다. `/watchlist/popout`의 정확한 경로만 `X-Frame-Options: SAMEORIGIN`과 `Content-Security-Policy: frame-ancestors 'self'`를 반환해야 같은 출처의 PiP iframe이 표시됩니다. 나머지 HTML 경로는 기존 `DENY`를 유지합니다. `curl -I https://orsem.laetipark.me/watchlist/popout`과 `/watchlist`의 응답 헤더를 비교해 확인하세요. 경로 안에서 SPA 파일을 직접 제공하고 보안 헤더를 모두 반복한 것은 Nginx의 [try_files 처리](https://nginx.org/en/docs/http/ngx_http_core_module.html#try_files)와 [add_header 상속 규칙](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header)을 따르기 위해서입니다.

새창은 기존 그룹 기능을 유지하며 저장된 시세만 2초마다 확인합니다. 공급자 구독 한도·수집 범위는 바뀌지 않습니다. 항상 위 기능은 HTTPS 또는 localhost의 지원 PC 브라우저에서 제공하며, 고정 창을 연 일반 팝업을 닫으면 고정 창도 닫힙니다. 배포 후에는 일반 팝업을 가린 상태의 고정 창 갱신, 그룹 선택 후 고정 해제, 재로그인 복귀를 확인하세요.

## 검증

- `/api/v1/health/live`는 MySQL에 접근하지 않고 응답합니다.
- `/api/v1/health/ready`는 MySQL과 Redis를 확인합니다.
- 로컬 AI가 활성화되어 있으면 `http://127.0.0.1:11434/v1/models`가 지정한 Ollama 모델을 로컬에서 보여줍니다.
- 로그인, TOTP, 로그아웃, CSRF 실패 경로가 동작합니다.
- 개발용 테스트 데이터 미리보기는 소스 키 없이 표시됩니다. 운영에서는 미설정 소스의 상태를 비활성으로 표시하며 가짜 이벤트를 만들지 않습니다.
- 보이는 기업 페이지는 토스 차트와 현재가를 2초마다 조회합니다. [토스 검증 절차](OPERATIONS.md#toss-securities-chart-setup)에 따라 공급자 시각과 신선도를 비교합니다.
- OpenDART 반복 조회나 프로세스 재시작으로 공시·알림이 중복되지 않습니다.
