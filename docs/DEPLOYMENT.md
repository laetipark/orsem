# 배포

저장소는 배포용 설정을 제공하지만 MySQL, Nginx, DNS, TLS, Redis, PM2를 자동으로 변경하지 않습니다.

2026-09-24 뉴스 수집 복구, NAVER 확인 기간 갱신, NEW 오인식 방지 및 기존 연결 정리는 [뉴스 복구 기록](NEWS_RECOVERY_2026-09-24.md)에 배포 범위·실측·외부 백업·복구 절차를 기록했습니다. SEC 외부 403 차단은 별도로 남아 있습니다.

## Python 워커 전환 상태

2026-09-11 01:03 KST에 수정한 Python 3.12 워커로 운영 큐를 재개했습니다. 01:35 KST까지 31분 안정성 관측을 완료하고, 01:38 KST에 기존 소스 정리를 마쳤습니다. API·웹·Discord는 TypeScript를 유지하고 워커 실행기·파서·관리 CLI만 Python으로 실행합니다. 이 문서 하단의 날짜별 기록은 당시 상태를 보존합니다.

운영 워커 후보는 SHA256이 포함된 `apps/worker/python/requirements.lock`으로 의존성을 설치하고, 격리 빌드한 wheel을 저장소 밖의 버전별 환경에 설치합니다. `../orsem-data/worker/current`는 검증된 환경을 가리키도록 전환합니다. 개발·검사 환경은 `apps/worker/python/requirements-dev.lock`을 사용합니다. [설치와 운영 CLI](PYTHON_WORKER.md)를 참고하세요.

이번 전환의 TypeScript 복구 후보는 `../orsem-data/backups/python-worker-20260910/rollback`에 보관합니다. 이 후보는 뉴스 메타데이터 전용 동작과 종목별 알림 설정을 지원합니다. 복구 시 수집된 데이터·검토 기록·사용자 설정을 보존하며 DB 전체 복원이나 일반 대기·실행·지연 큐 작업의 일괄 삭제를 수행하지 않습니다.

### 2026-09-11 전환 기록

- 최초 Python 전환 뒤 예약 작업의 다음 회차 등록 누락, 뉴스 회사명 매칭기의 정규식 선생성에 따른 메모리 증가, 종료 지연을 발견했습니다. 00:47 KST에 종목별 알림 설정을 지원하는 기존 워커로 복구했습니다. API·웹과 수집된 DB 자료는 유지했습니다.
- 수정본은 다음 회차를 처리 전에 등록하고, 회사명 후보 인덱스와 필요한 정규식만 생성하는 기존 알고리즘을 복원했습니다. 큐 종료는 모든 수신을 멈춘 뒤 활성 작업의 잠금을 유지하며 마무리합니다.
- Treasury 요청에는 이전 실행 환경과 같은 User-Agent를 사용합니다. 회사 마스터·캔들·시장 지표의 묶음 조회와 저장도 복원했으며, MySQL advisory lock은 커밋·롤백 이후에 해제합니다.
- 수정본 release ID는 `2326ef49c9ad7ffb8a35c5b1ac06ad86b0ff6ce7aefaf9bdca9f31c14abe4994`, worker wheel SHA256은 `bd0dbc5d502ad0089bffc11b031154b41b59a7bf92eca38f444e4176816819f6`입니다. Python 소스·정적 계약 파일 66개와 고정 의존성 wheel 44개를 검증했습니다. 이전 로고 수집 모듈은 포함되지 않습니다.
- 재전환 전 `../orsem-data/backups/python-worker-20260910/retry-1`에 새 DB·큐 스냅샷을 보관했습니다. DB 압축 파일 SHA256은 `1f11e94c0e119a5e7400d54340e062e165247dab166c171eb00bb108bc57684f`입니다. 일반 작업 1,341개의 내용·재시도 설정과 예약 설정 30개의 실행 주기를 보존했습니다.
- `AddCompanyNotifications1789084800000`은 첫 전환 때 적용한 뒤 다시 실행하지 않았습니다. 두 번째 전환은 워커만 교체했으며 API·웹 산출물은 변경하지 않았습니다.
- 검증: 독립 MySQL·Redis에서 Python 전체 485개 테스트가 통과했습니다. 격리 프로젝트의 `npm run check`와 빌드도 통과했습니다. 실제 SEC 403 해제는 별도이며 [접근 정책 대조](SEC_PYTHON_ACCESS_REVIEW_2026-09-10.md)를 참고합니다.
- 운영 관측: 31분 34초 동안 재시작·실패 작업 0건, API 준비 상태와 공개 웹 응답 200을 유지했습니다. 15분 뉴스 수집 두 회차를 처리했으며 프로세스 최고 메모리는 약 374 MiB, 관측 종료 시 약 161 MiB였습니다. 8개 큐와 30개 예약 작업을 유지합니다.
- 소스 정리: 검토한 16개 경로의 540개 파일(4,647,719바이트)을 SHA256 대조한 외부 압축 백업에 보존한 뒤 제거했습니다. 잠금 파일에서 불필요한 의존성 항목 238개를 제거했으며, 유지한 패키지의 버전과 실행 중인 `node_modules`는 변경하지 않았습니다. 복구 환경·원본 자료·이전 웹 해시 자산은 보존했습니다. 근거는 위 백업의 `worker-monitor-complete.json`, `cleanup-complete.json`, `legacy-source-cleanup-backup.json`입니다.

### 2026-09-11 화면·로고 후속 정리 배포

01:58:01 KST에 화면·로고 후속 변경과 API 리팩토링을 운영에 반영했습니다. 백업은 `../orsem-data/backups/ui-refactor-2026-09-10T16-57-51-884Z`이며 최종 웹 index SHA256은 `a69a9f8ff14ce3dfdeb4acd6801a8968c4e6db2f3df6235630b36abaff353a09`입니다. 01:57 KST 최초 시도는 공개 응답 확인 지연으로 이전 API와 index를 자동 복구한 뒤 재배포했습니다.

적용 범위는 웹 78개와 API `news-content` 산출물 3개, 총 81개 파일입니다. API 실행 코드 차이는 `news-content.js` 하나이며 기존 프로세스 환경을 유지한 채 API만 재시작했습니다. 기존 웹 자산 295개(최초 시도 전 250개와 최초 시도에서 추가된 45개)를 보존했습니다. Python worker는 PID `453811`, 재시작 0회 상태를 유지했고 DB·마이그레이션·큐를 변경하지 않았습니다.

격리 프로젝트의 전체 `npm run check`와 빌드가 통과했습니다. 마지막 로고 로더의 시간 경계 수정 이후에는 웹 77개 테스트 파일의 614개 테스트 전부와 TypeScript·ESLint·빌드를 다시 확인했습니다. 동일한 후보 구성이 유지될 때 참조도 보존하여 시간 경계만으로 표시 중인 로고를 다시 로딩하지 않도록 했습니다.

실제 브라우저의 fixture 화면에서 다음 크기를 실측했습니다. 운영 데이터나 외부 이미지 커버리지를 추가 검수한 결과는 아닙니다.

| 화면            | 확인한 너비(px)               | 결과                                                          |
| --------------- | ----------------------------- | ------------------------------------------------------------- |
| `/companies`    | 280·320·375·420·768·1280·1440 | 가로 넘침 0                                                   |
| `/logo-sources` | 280·320·375·420·768·1280      | 가로 넘침 0, Logo.dev 본문 출처 유지, footer 로고 출처 링크 0 |
| 종목 상세       | 320·375·768·1024·1280·1440    | 가로 넘침 0                                                   |

PC의 상세 동작 버튼 4개는 높이 44px와 같은 테두리·배경·8px 모서리를 사용하며 아이콘 버튼 3개의 너비도 44px임을 확인했습니다. 로고 로더·출처 화면의 현재 동작과 실물 이미지 검수의 한계는 [종목 로고 문서](STOCK_LOGOS.md#검증-및-운영-반영-기록)에 기록합니다. 복구 시 이 배포의 백업과 최종 해시를 대조하고, 유지 중인 Python worker나 DB 전체를 되돌리지 않습니다.

검증용 MySQL·Redis·Vite와 남아 있던 테스트 프로세스를 종료하고 임시 빌드·가상환경 20개 디렉터리(1,211,147,099바이트)를 정리했습니다. 최종 산출물 81개와 소스 636개는 위 배포 백업에, 검사 로그·측정 결과·복구 도구는 Python 전환 백업의 `final-evidence`와 `operations`에 해시 검증하여 보관했습니다. 운영 실행 환경과 이전 웹 자산은 보존했습니다.

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

2026-09-26부터 운영 워커는 로그인 전 가용성을 확인한 사설 Ollama `172.30.1.99:11434`를 사용합니다. 워커의 실제 `AI_BASE_URL`은 `http://172.30.1.99:11434/v1`, `OLLAMA_URL`은 `http://172.30.1.99:11434`이며 두 모델 태그는 `qwen3.5:4b-q4_K_M`입니다. 분류·번역 제한 시간은 각각 120초입니다. 기존 로컬 Ollama PM2 프로세스와 API 프로세스는 이 워커 전환에서 재시작하지 않았습니다. 워커의 이전 설정과 릴리스 복구 기준은 저장소 밖 `../orsem-data/backups/ollama-cutover-20260926`에 있습니다.

AI 작업은 동시 실행 수가 1인 전용 `orsem-ai-review` 큐에서 실행하므로, 느린 CPU 추론이 공시 후처리나 지연된 조회용 데이터 생성 worker를 점유하지 않습니다.

뉴스 한국어 번역은 `NEWS_TRANSLATION_ENABLED`로 별도 활성화합니다. 현재 워커는 승인된 `OLLAMA_URL=http://172.30.1.99:11434`와 `NEWS_TRANSLATION_MODEL=qwen3.5:4b-q4_K_M`로 연결하며 외부 번역 API나 클라우드 모델로 자동 전환하지 않습니다. `AddManualNewsTranslations1788405000000`이 아직 적용되지 않았다면 먼저 적용하고, `UseNewsMetadataOnly1788411000000`과 호환되는 API·worker를 배포합니다. 기본 1분·최대 3건의 제목·요약만 번역하며 본문 존재·본문 번역 완료 조건은 사용하지 않습니다. 번역 대기·실패 시 원문 메타데이터를 표시합니다. [뉴스 번역 설정](NEWS_TRANSLATION.md#설정과-재시도)과 [기존 본문 정리 순서](NEWS_TRANSLATION.md#기존-본문-정리와-배포-순서)를 참고하세요.

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

## 2026-09-07 KST 배포 완료 기록

본 배포 백업은 `../orsem-data/backups/metadata-design-20260906T151201Z`입니다. `AddManualNewsTranslations1788405000000`과 `UseNewsMetadataOnly1788411000000` 두 마이그레이션만 적용했습니다. 정리 대상 본문·본문 번역·수정 이력의 본문 사본은 0건이며, 큐 재개 후에도 0건을 확인했습니다. 원본 메타데이터·출처·권리·관계·공시를 포함한 24개 테이블의 보존 해시가 일치했고, 8개 큐를 원래 상태로 복원한 뒤 API와 Worker의 `online` 상태를 확인했습니다. 과거 백업과 공시 원본은 보존했습니다.

뉴스 목록 스크롤과 관련 종목 오인 표시의 후속 배포 백업은 `../orsem-data/backups/news-scroll-followup-20260906T152858Z`입니다. 서버 파일 6개와 웹 파일 80개를 교체하고 API만 재시작했습니다. Worker와 다른 프로세스는 유지했으며 DB·마이그레이션·큐 상태는 변경하지 않았습니다. 격리 환경에서 웹 310개, API 290개, Worker 741개, contracts 25개 테스트와 후속 수정 36개 테스트가 통과했습니다.

복구에는 가장 최근 배포의 메타데이터 전용 후보를 사용합니다. 후속 배포가 완료된 뒤 이전 백업의 서버 파일을 섞어 복원하지 않습니다. 본문 작성 Worker를 되살리는 과거 `rollback.cjs`는 실행하지 않습니다.

### 국내 ETF와 뉴스·관심 종목 후속 배포

2026-09-07 01:04:59 KST에 적용을 완료했습니다. 백업은 `../orsem-data/backups/etf-news-20260906T160210Z`, 배포 명세 SHA256은 `d61756ebfab61e97f6a5ef3e97f9296fe4bc84510072dd91d1819723c6211808`입니다. 서버 산출물 24개와 웹 파일 80개를 적용했고 나머지 실행 파일 728개와 기존 해시 웹 자산을 보존했습니다. 새 SQL 마이그레이션은 없습니다.

공식 토스 목록에서 국내 ETF 1,167개를 등록했으며 영문자가 포함된 6자리 종목 코드도 303개 포함했습니다. API와 Worker를 멈춘 상태에서 기존 기업 127,636개 행 전체가 동일하고 뉴스·공시·출처 데이터의 보존 해시가 일치함을 확인했습니다. 기업 수정·삭제·식별 정보 충돌은 0건입니다. 이름·코드 검색, `069500`과 `0000D0`의 종목 주소 연결, 국내·미국 검색 분리를 실제 운영 DB와 API 서비스로 읽기 전용 검증했습니다.

`/news`의 관련 종목 오인 표시와 범위·수집 상태 디자인을 개선하고, `/watchlist`의 시장 뉴스를 제거해 모든 화면에서 관심 종목 → 내 관심 종목 소식 순서의 1열로 변경했습니다. 개인 소식은 관심 카드 높이를 따르며 목록만 스크롤됩니다. 네이버 전체 15분당 최대 10회 제한은 기존 일일·월별 한도와 함께 DB 잠금으로 유지합니다. 격리 MySQL 8에서 동시 20건 중 정확히 10건 허용, 나머지 429, 잠금 충돌과 503 오류 0건을 확인했습니다.

최종 웹 테스트 311개, ETF 실행 후보 테스트 55개, ETF API 회귀 테스트 14개와 관련 타입 검사·빌드가 통과했습니다. 320·390·768·1440px의 관심 페이지 1열·높이 일치와 320·390·1440px의 뉴스 상태 영역을 밝은·어두운 테마에서 검증했습니다. 큐 재개 후 뉴스 본문·본문 번역·수정 이력의 본문 사본은 0건이며 8개 큐가 모두 기존 상태로 복원됐습니다. API·Worker는 정상이고 Ollama·Discord 프로세스는 유지했습니다. 공개 API의 준비 상태 200과 비로그인 개인 뉴스 접근 401을 확인했습니다. 새 브라우저 세션의 로그인 후 화면 검증은 수행하지 않았으며 화면 검증은 격리 환경에서 완료했습니다.

이 백업의 `RECOVERY.md`와 `repair-forward.cjs`는 배포 도중 실패했을 때 검증된 후보만 재설치하는 절차입니다. 정확한 명세 해시를 요구하고 `before/`나 DB 덤프를 자동 복원하지 않으며, 이미 완료된 배포에는 실행을 거부합니다. 이후 장애 복구에는 최신 운영 상태를 확인한 별도 배포 명세가 필요합니다. 과거 백업과 공시 원본은 계속 보존합니다.

### 월간 시총 상위 종목·봇·공통 헤더 배포

2026-09-07 03:06 KST에 최종 운영 검증을 완료했습니다. `/companies` 목록에 공통 제목을 적용하고, 모든 페이지의 사이트 헤더·본문·푸터 너비와 반응형 좌우 여백을 통일했습니다. 종목 상세의 별도 사이트 헤더 스타일을 제거해 상세 방문 후 목록으로 돌아와도 배치가 유지됩니다. 320·390·768·1024·1440px의 주요 6개 페이지와 밝은·어두운 테마, `/companies/` 직접 진입을 격리 브라우저에서 확인했습니다. 웹 테스트 311개와 최종 라우팅 테스트 10개, 타입 검사·빌드가 통과했습니다.

`UseMonthlyMarketLeaders1788412000000`으로 읽기 전용 뷰 두 개를 추가했습니다. 국내·미국 보통주 대표 각 20개와 검증된 주식 유형을 포함한 뉴스 연결 42개가 활성화됐으며, 다음 월간 갱신은 2026-10-01 00:00 KST입니다. 수집·알림은 월간 목록을 사용하고 기존 수동 운영 목록과 개인 그룹의 기록은 보존했습니다. 디스코드의 `market`, `news`, `status`, `recent`, `company` 명령 등록을 실제 Discord API로 확인했습니다. 메신저봇 스크립트도 갱신했으며 Android 기기에서의 스크립트 교체·컴파일은 별도로 필요합니다.

최초 백업은 `../orsem-data/backups/monthly-leaders-20260906T175521Z`입니다. 운영 DB의 `utf8mb4_general_ci` JSON 문자열과 `utf8mb4_unicode_ci` 식별자 비교 충돌로 두 번째 뷰 생성이 중단됐습니다. 바이트 비교와 검증된 DB ID 반환으로 수정하고, 같은 혼합 정렬 규칙의 격리 MySQL에서 오류 재현·재실행·40/42개 결과·기존 데이터 보존을 검증했습니다. 원래 백업과 DB 덤프를 보존한 새 복구 백업 `../orsem-data/backups/monthly-leaders-20260906T180056Z`에서 수정된 마이그레이션 두 산출물만 갱신해 배포를 완료했습니다. 계획 SHA256은 `51cbea83fd3c7c6043e524f7660ed8d59a500b5b95918158fc7992277b16990c`입니다.

후속 조회 검증에서 SQL 예약어 `rank` 별칭을 인용하도록 수정했습니다. 실제 운영 DB에서 읽기 전용으로 국내·미국 각 20개와 종목 주소를 확인하고 API 두 파일만 적용했습니다. 이 백업은 `../orsem-data/backups/monthly-rank-fix-20260906T180545Z`, 계획 SHA256은 `a962e63674debba7773ff2e3097acfe7fa906637c3aa99e4ff7c4d16730c7073`입니다. API만 재시작했으며 Worker·Discord·큐·DB는 변경하지 않았습니다. 관련 API 테스트와 타입 검사가 통과했습니다.

최종 공개 웹은 `index-B_WFu_BC.js`와 `index-BJFaqJZk.css`이며 배포 산출물 해시와 일치합니다. 준비 상태 200, 서비스 토큰으로 국내·미국 월간 목록 각 20개와 전체·국내·미국 뉴스 각 5개, 비인증 봇·개인 뉴스 접근 401을 확인했습니다. 기존 기업 128,803개·개인 그룹·공시·뉴스 메타데이터의 정지 상태 보존 검증이 완료됐고 뉴스 본문은 0건입니다. 8개 큐를 원래 상태로 복원했으며 API·Worker·Discord가 정상 실행 중입니다. 봇 시험 메시지는 전송하지 않았습니다. 새 브라우저 로그인 후 화면 검증은 수행하지 않았습니다.

복구 시에는 위 후속 API 수정까지 포함한 최신 운영 산출물을 기준으로 새 계획을 작성합니다. 완료된 배포의 복구 스크립트나 최초 실패 후보를 그대로 재실행하지 않습니다.

### 조건부 뉴스 확장·자동완성·개인 관심그룹 복사

2026-09-07 12:32:36 KST에 뉴스 확장과 대소문자를 구분하지 않는 자동완성 배포를 완료했습니다. 비공개 백업은 `../orsem-data/backups/free-news-accounts-20260907T033120Z`, 계획 SHA256은 `9e66ad352bb3ecac020603582a7017f35c4103918cee91654b84db172de45e00`입니다. 서버 산출물 108개와 웹 파일 80개를 적용하고 관련 없는 운영 파일 697개를 보존했습니다. API·worker만 재시작했으며 Discord·Ollama와 다른 서비스는 유지했습니다.

DB 일관 백업 273,333,054바이트를 보존한 뒤 `AddNewsTitleHash1788413000000`만 적용했습니다. 새 nullable 컬럼과 인덱스·마이그레이션 기록을 확인했고, 마이그레이션 전후 75개 테이블의 기존 데이터 보존 해시가 일치했습니다. 8개 큐를 원래 상태로 복원했으며 뉴스 본문 저장은 0건입니다. Marketaux·Alpha Vantage·Finnhub와 새 IR/RSS 프로필 4개는 비활성·권리 `UNKNOWN` 상태를 유지합니다.

배포본은 운영 산출물에 이번 변경만 겹쳐 구성했습니다. 소스에 이미 존재하지만 운영에는 없던 SEC 과거 공시·ownership 확장, GDELT 복구 경로, Alpaca News 라우팅·스케줄은 이번 배포에 포함하지 않았습니다. 기존 SEC·GDELT 클래스와 수집·저장·기준선 동작은 배포 전 코드와 AST 일치를 검증했습니다. 미배포 Markdown 편집 API 변경도 제외했습니다. 명세·worker 구성 스크립트·검증 결과는 백업의 `worker-stage/`에 보존합니다. 향후 전체 소스 빌드를 운영 산출물에 직접 덮어쓰지 않습니다.

별도로 확인된 일반 회원에게 관리자 개인 그룹 사본 1개와 사진의 그룹 5개를 일회성으로 추가했습니다. 사진 그룹에는 ETF를 포함해 순서대로 11·11·10·7·11개 종목이 있습니다. 최초 예행연습 이후 기존 회원 그룹이 삭제된 상태를 감지해 첫 적용을 변경 전에 중단했고, 현재 빈 목록을 기준으로 새 명세를 만들어 삭제 상태를 보존했습니다. 최종 결과는 개인 그룹 6개·종목 관계 51개이며, 같은 명세 재실행은 `ALREADY_APPLIED`로 종료돼 중복을 만들지 않았습니다. 일반 알림 기본값만 복사하고 `APPROVED / VIEWER`와 별도의 인증·기기 정보를 유지했습니다. 회원 식별 정보·종목 ID·실행 명세·감사 결과는 저장소 밖 백업의 `account-import/`에 보관합니다.

격리 소스의 format·lint·typecheck·전체 테스트 1,742개·build·메신저 스크립트 검사가 통과했습니다. 선별 worker의 범위 보존 검사 17개, API·예산·RSS 검사 69개와 계정 복사 합성 검사 8개도 통과했습니다. 실제 운영 DB에서 종목 `nvda/NVDA/NvDa`와 뉴스 제목 `federal/FEDERAL/FeDeRaL` 각각 비어 있지 않은 동일 결과·순위를 확인했습니다. 실제 회원을 조회하는 운영 권한 가드로 개인 그룹 편집 허용과 관리자 운영 접근 403을 검증했습니다. 공개 웹 및 준비 상태는 200, 비로그인 개인 그룹·자동완성 접근은 401이며 공개 웹 index 해시가 배포본과 일치합니다. 새 브라우저 로그인 후 화면 검증은 수행하지 않았습니다.

복구는 이 백업의 직전 메타데이터 전용 산출물을 기준으로 합니다. 추가된 DB 컬럼은 유지하고, 계정 복사 이후의 사용자 편집은 감사기록과 대조합니다. DB 덤프 전체 복원이나 과거 본문 수집 worker 재활성화는 수행하지 않습니다.

### 모바일 관심 종목·소식 표시 개선

2026-09-07 13:09:49 KST에 웹 화면 변경을 적용했습니다. 백업은 `../orsem-data/backups/mobile-watchlist-20260907T040948Z`, 계획 SHA256은 `65b05c16c4ae80defec3aaac96710c686789e65efe79c576d6e8fac41c24895b`입니다. 웹 파일 80개 중 새 해시 자산 45개를 추가하고 진입 HTML을 교체했으며, 기존 자산 965개를 보존했습니다. API·worker·DB는 변경하거나 재시작하지 않았습니다. 공개 웹 HTML 해시가 후보와 일치하고 웹·API 준비 상태가 모두 200입니다.

메인과 관심 목록의 카드 테두리·제목·여백·페이지 이동 디자인을 통일했습니다. PC는 종목과 뉴스·공시를 각각 6개씩, 900px 이하에서는 종목 3개·소식 4개씩 표시합니다. 그리드는 최대 2열이며 620px 이하에서는 1열입니다. 모바일의 기본 종목 보기는 목록이고 명시적으로 선택한 보기 방식은 URL에 유지합니다. 기존 API의 limit을 재사용했으며 다른 화면의 기본 조회 한도는 유지합니다. 그룹 목록 캐시와 최신 종목 수가 다를 때도 새 종목으로 페이지 이동이 가능합니다.

900px 이하에서 두 카드의 높이 연동과 숨은 그리드의 높이 점유를 제거했습니다. 뉴스·공시 및 관심 목록은 페이지의 터치 스크롤을 사용합니다. 좁은 PC 카드의 목록 배치는 카드 자체의 폭을 기준으로 바뀌어 오른쪽 정보 잘림을 방지합니다. 데스크톱에서는 기존 높이 연동을 유지합니다.

격리 환경에서 format·lint·웹 typecheck·웹 테스트 326개·웹 build가 통과했습니다. 실제 Google Chrome의 화면 크기·터치 에뮬레이션으로 17개 시나리오를 검증했습니다. 320·360·384·390·412·900px, 1440px PC, 915×412 가로 화면에서 개수·페이지 이동·높이·가로 넘침을 확인했고 실제 터치 이벤트 12회에서 문서 스크롤 이동과 뉴스 내부 scrollTop 0을 확인했습니다. 화면 검증의 API는 합성 자료이며 운영 데이터에 쓰지 않았습니다. S24+ 실물 기기에서 직접 검증한 것은 아닙니다.

복구가 필요하면 현재 HTML을 배포 명세와 대조한 뒤 이 백업의 `previous-index.html`만 복원합니다. 기존 해시 자산은 보존했으므로 서버 프로세스나 데이터베이스를 복원하지 않습니다.

### PC 관심 종목 새창·항상 위·시세 갱신

2026-09-08 23:04:44 KST에 웹과 API 반영을 완료했습니다. 백업은 `../orsem-data/backups/watchlist-popout-20260908T135550Z`, 배포 명세 SHA256은 `6cc9f0d58825fda2373c5ecbf0633d95ae1ef2687eac731f535652fe775c2b27`입니다. DB 일관 스냅샷 456,993,131바이트와 기존 산출물 941개, 비공개 설정 및 큐 정지 상태를 보존했습니다. API만 재시작했으며 Worker·Discord·Ollama·다른 서비스와 DB·마이그레이션·큐는 변경하지 않았습니다.

API의 관심 그룹 controller·service와 공유 계약 watchlist-groups 모듈만 선별했습니다. 기동 이후 재출력된 나머지 API·계약 파일은 기존 내용과 같음을 AST로 확인했습니다. 웹 후보 76개 파일을 배치하면서 기존 해시 자산을 보존했고 HTML을 마지막에 교체했습니다. 기존·후보의 실제 자산 참조 66개 중 해시 참조를 제외한 변경은 관심 종목 패널 청크 하나이며 CSS는 모두 같습니다. 공개 HTML SHA256은 `6fce5b63ed8411b879572b425cf23c266e709e89a192039e82f33d39ab03b45b`입니다.

관리자 인증 후 백업의 `apply-nginx.sh`로 정확한 `/watchlist/popout` 경로만 추가했습니다. 운영 HTTPS에서 해당 경로의 `SAMEORIGIN`·`frame-ancestors 'self'`, 일반 `/watchlist`의 `DENY`, 웹·API 준비 상태 200과 비인증 그룹 시세 요청 401을 확인했습니다. 기존 TLS·리디렉션·다른 Nginx 경로는 보존했습니다.

격리 복사본에서 웹 553개 및 관련 API·계약 26개 테스트와 빌드·타입 검사가 통과했습니다. 로그인된 운영 Chrome에서 관심 종목·새창 목록과 성공 확인 시각 갱신, 항상 위 상태 전환을 확인했습니다. 고정 전환 후 브라우저 연결을 사용할 수 없어 고정 창 내부의 지속 갱신과 고정 해제는 운영 브라우저에서 끝까지 검증하지 못했습니다. 새창은 유효한 저장 시세만 종목별로 갱신하고, 누락·무효 응답에서는 이전 가격을 유지하며 갱신 실패 알림은 표시하지 않습니다.

복구 시 이 백업의 `RECOVERY.md`와 현재 파일 해시를 먼저 확인합니다. 이후 배포가 없다면 `apply.cjs rollback`으로 직전 명세의 서버·웹 index·Nginx를 복원할 수 있으며 Nginx 복원에는 관리자 인증이 필요합니다. 이전 Worker나 DB 전체를 자동 복원하지 않습니다.
