# 서비스별 자격 증명 관리

현재 개인 서버에는 **외부 `runtime.env`와 서비스별 JSON**을 권장합니다. 비밀 값은 `/home/laeti/.config/orsem`에 보관하고, 저장소에는 예시와 파일 경로만 둡니다. `CREDENTIALS_FILE`은 공통 규격이 아닙니다. Orsem이 직접 읽는 파일 변수는 `KAKAO_CREDENTIALS_FILE`, `TOSS_CREDENTIALS_FILE`, `WEB_PUSH_CREDENTIALS_FILE`이며, 나머지는 프로세스 환경 변수로 주입해야 합니다.

이 문서는 권장 배치와 현재 코드의 지원 범위를 설명합니다. 실제 파일 생성, 기존 비밀 값 이동, 공급자 키 발급이나 운영 프로세스 재시작을 수행했다는 뜻은 아닙니다.

## 위치와 권한

| 환경                      | 권장 위치                                                                                                                                      | 관리 방식                                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 현재 사용자·개인 PM2 서버 | `/home/laeti/.config/orsem/runtime.env`, `/home/laeti/.config/orsem/credentials/kakao.json`, `/home/laeti/.config/orsem/credentials/toss.json` | PM2와 API를 실행하는 사용자 소유, 디렉터리 `0700`, 파일 `0600`                                                            |
| 전용 Linux 운영 계정      | `/etc/orsem/runtime.env`, `/etc/orsem/credentials/kakao.json`, `/etc/orsem/credentials/toss.json`                                              | `orsem` 실행 계정만 읽도록 배치. 관리자 배포라면 `root:orsem`, 디렉터리 `0750`, 파일 `0640`도 가능하며 그룹 구성원을 제한 |
| 컨테이너·관리형 배포      | `/run/secrets/orsem-kakao.json`, `/run/secrets/orsem-toss.json`                                                                                | 배포 환경의 비밀 저장소에서 읽기 전용 파일로 마운트. 환경 변수 전용 서비스는 배포 도구가 환경으로 주입                    |

`/home/laeti/orsem-data/kakao-credentials.json`처럼 이미 저장소 밖에 둔 기존 경로도 사용할 수 있습니다. 새 구성에서는 원문·로그와 비밀 파일의 백업·접근 정책을 구분하기 쉽도록 `.config/orsem`에 모읍니다. 개발과 운영에는 별도의 디렉터리와 자격 증명을 사용합니다. `*_CREDENTIALS_FILE` 값에 `~`나 환경 변수 확장을 기대하지 말고 **절대 경로**를 지정합니다.

소유자는 서비스를 실제로 실행하는 계정이어야 합니다. `root`로 파일을 만들고 `0600`만 설정하면 사용자 PM2가 읽을 수 없습니다. 상위 디렉터리의 접근 권한도 함께 확인합니다. 운영 비밀을 웹 정적 디렉터리, 저장소, 채팅, 명령행 인자나 로그에 넣지 않습니다. 특히 `VITE_*`는 브라우저에 포함되는 설정이므로 모든 서비스 키에서 사용하지 않습니다.

## 서비스별 현재 지원

아래 `runtime.env`는 `/home/laeti/.config/orsem/runtime.env`, `credentials/`는 `/home/laeti/.config/orsem/credentials/`를 뜻합니다. 표의 파일 이름은 권장 이름이며 로더가 이름 자체를 요구하지는 않습니다.

| 서비스                      | 권장 보관·정확한 입력                                                                                        | 사용하는 프로세스·주의사항                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 카카오 회원 로그인          | `credentials/kakao.json` → `KAKAO_CREDENTIALS_FILE`; JSON은 `clientId`, `clientSecret`, 선택적 `redirectUri` | API. `clientId`는 REST API 키. 직접 주입 시 `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`, `KAKAO_REDIRECT_URI`        |
| 토스증권 시세               | `credentials/toss.json` → `TOSS_CREDENTIALS_FILE`; JSON은 `clientId`, `clientSecret`                         | API·worker. 직접 주입 시 `TOSS_CLIENT_ID`, `TOSS_CLIENT_SECRET`. `MARKET_DATA_PROVIDER=toss`                      |
| 모바일·브라우저 알림        | `credentials/web-push.json` → `WEB_PUSH_CREDENTIALS_FILE`; JSON은 `publicKey`, `privateKey`, `subject`       | API·worker. `npm run push:setup`으로 한 번 생성. 저장소 밖 절대 경로와 파일 `0600` 필수. [설정 안내](WEB_PUSH.md) |
| Gold API 금·은 이력         | `runtime.env`의 `GOLD_API_KEY`                                                                               | worker. [로그인·무료 가입](https://gold-api.com/login) 후 계정에서 API 키 확인. 현재가에는 키 불필요              |
| EIA WTI 현물 가격           | `runtime.env`의 `EIA_API_KEY`                                                                                | worker. [키 등록](https://www.eia.gov/opendata/register.php) 후 이메일로 수신                                     |
| 빗썸 시세·TradingView 위젯  | 키 불필요                                                                                                    | 빗썸은 공개 현재가·일봉 API, 미국 지수는 TradingView의 FRED 일별 지수 위젯 사용                                   |
| OpenDART                    | `runtime.env`의 `OPENDART_API_KEY`                                                                           | API·worker. `OPENDART_CREDENTIALS_FILE`은 지원하지 않음                                                           |
| NAVER 뉴스 검색             | `runtime.env`의 `NAVER_API_PROVIDER`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`                               | API·worker. `developers`(기본값) 또는 `ncloud`와 키 발급처를 일치시킴. 전용 JSON 로더 없음                        |
| Alpaca 기업 식별 정보       | `runtime.env`의 `ALPACA_API_KEY`, `ALPACA_API_SECRET`; 공개 설정 `ALPACA_TRADING_BASE_URL`                   | API·worker. 현재 자산 마스터용이며 가격 수집·주문 실행에 사용하지 않음. 전용 JSON 로더 없음                       |
| SEC                         | `runtime.env` 또는 비밀이 없는 일반 설정의 `SEC_USER_AGENT="Orsem monitored-email@example.com"`              | API·worker. API 키가 아니라 앱 식별 정보와 실제 확인하는 연락처                                                   |
| Discord                     | `runtime.env`의 `DISCORD_BOT_TOKEN`, `DISCORD_SERVICE_TOKEN`; ID·허용 목록은 아래 예시                       | 봇 토큰은 Discord 프로세스, 서비스 토큰은 API와 Discord에 같은 값. 두 토큰은 서로 다른 값. 전용 JSON 로더 없음    |
| MessengerBotR 카카오톡 알림 | Android 봇의 비공개 `Database/orsem-state.json`                                                              | 연결 과정에서 `deviceToken` 생성·저장. 서버에는 토큰 해시 저장. 카카오 로그인 키와 독립적                         |
| MySQL                       | `runtime.env`의 `DATABASE_URL`                                                                               | API·worker·DB 마이그레이션·관리자 생성 CLI. `DATABASE_CREDENTIALS_FILE`은 지원하지 않음                           |
| Redis                       | `runtime.env`의 `REDIS_URL`; 공개 설정 `REDIS_PREFIX`                                                        | API·worker. 세션·큐·토스 토큰 캐시를 보관하므로 접근 및 백업 권한 제한. `REDIS_CREDENTIALS_FILE`은 지원하지 않음  |
| Orsem 세션·관리자 TOTP      | `runtime.env`의 `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`                                                      | API·관리자 생성 CLI. 서로 독립적으로 생성하고 백업. 관리자 로그인 비밀번호는 이 파일에 상시 보관하지 않음         |
| 선택적 AI 분류기            | `runtime.env`의 `AI_API_KEY`, 일반 설정 `AI_BASE_URL`, `AI_MODEL`, `AI_ENABLED`                              | API·worker. 인증 없는 로컬 Ollama의 `ollama` 값은 호환용 자리표시자이며 비밀 키가 아님                            |
| 선택적 뉴스 한국어 번역     | `runtime.env`의 `NEWS_TRANSLATION_ENABLED`, `OLLAMA_URL`, `NEWS_TRANSLATION_MODEL`, 처리 상한·제한 시간      | worker 전용 로컬 Ollama, 외부 API 키 불필요. [번역 설정](NEWS_TRANSLATION.md#설정과-재시도) 참고                  |
| 사이트 뉴스 피드            | 비밀 파일 없음; `NEWS_RSS_FEEDS`, 검토된 Samsung `IR_FEED_URLS`                                              | 코드의 정확한 콘텐츠 프로필과 일치하는 URL만 지원. `GDELT_ENABLED=false` 유지                                     |
| KIS·한국투자증권            | 현재 커넥터·자격 증명 변수 없음                                                                              | 키를 배치해도 연결되지 않음                                                                                       |
| KRX 가격                    | 현재 키 설정 없음                                                                                            | 이전 가격 수집은 종료됨. 토스의 국내 시세에 나오는 KRX 표시는 별도 KRX 키가 필요하다는 뜻이 아님                  |
| Telegram                    | 현재 봇 구현·자격 증명 변수 없음                                                                             | 계약의 채널 유형에 이름이 있어도 `TELEGRAM_BOT_TOKEN`을 읽거나 전송하지 않음                                      |

단일 사용자 운영에서는 환경 변수 전용 값을 `runtime.env`에 모으면 설정 누락을 줄일 수 있습니다. 프로세스별 운영 계정이나 배포가 나뉘면 `/etc/orsem/api.env`, `/etc/orsem/worker.env`, `/etc/orsem/discord.env`로 나누어 각 프로세스에 필요한 값만 전달하는 구성을 권장합니다. 현재 PM2 템플릿은 이 분리를 자동으로 수행하지 않습니다.

## 카카오와 토스 JSON 형식

`/home/laeti/.config/orsem/credentials/kakao.json`:

```json
{
  "clientId": "YOUR_KAKAO_REST_API_KEY",
  "clientSecret": "YOUR_KAKAO_CLIENT_SECRET",
  "redirectUri": "https://orsem.laetipark.me/api/v1/auth/kakao/callback"
}
```

`redirectUri`를 생략하면 `WEB_ORIGIN` + `/api/v1/auth/kakao/callback`을 사용합니다. 지정하는 경우 그 주소와 정확히 같아야 합니다. 카카오 로그인·OpenID Connect 사용 설정과 리다이렉트 URI 등록은 [카카오 로그인 운영](KAKAO_LOGIN.md)을 따릅니다. 카카오톡 메시지 발송용 어드민 키나 MessengerBotR 기기 토큰을 여기에 넣지 않습니다.

`/home/laeti/.config/orsem/credentials/toss.json`:

```json
{
  "clientId": "YOUR_TOSS_CLIENT_ID",
  "clientSecret": "YOUR_TOSS_CLIENT_SECRET"
}
```

토스 발급·서버 IP·실시간 수신 검증은 [토스 설정 절차](OPERATIONS.md#toss-securities-chart-setup)를 따릅니다.

두 파일 모두 JSON 객체에 문자열 값을 사용하며 주석·끝 쉼표는 허용하지 않습니다. **각 항목에서 비어 있지 않은 직접 환경 값이 JSON보다 우선**합니다. 파일 방식으로 옮길 때 예전 `*_CLIENT_ID`와 `*_CLIENT_SECRET`을 계속 주입하면 새 JSON과 오래된 환경 값이 섞일 수 있으므로 함께 정리합니다. 읽기 실패·잘못된 JSON은 해당 파일을 무시하며, 환경 값으로도 완전한 자격 증명을 얻지 못하면 해당 기능만 비활성화합니다. 파일은 시작 시 읽으므로 교체 후 해당 프로세스를 재시작해야 합니다.

## 환경 변수 파일 형식

`/home/laeti/.config/orsem/runtime.env`는 JSON이 아닌 **`이름=값` 형식의 UTF-8 파일**입니다. 아래는 자리표시자입니다. 활성화할 서비스에만 실제 값을 넣고 나머지 선택 서비스 항목은 생략합니다.

```dotenv
KAKAO_CREDENTIALS_FILE=/home/laeti/.config/orsem/credentials/kakao.json
TOSS_CREDENTIALS_FILE=/home/laeti/.config/orsem/credentials/toss.json
WEB_PUSH_CREDENTIALS_FILE=/home/laeti/.config/orsem/credentials/web-push.json

DATABASE_URL="mysql://orsem:URL_ENCODED_PASSWORD@127.0.0.1:3306/orsem"
REDIS_URL="redis://default:URL_ENCODED_PASSWORD@127.0.0.1:6379/0"
SESSION_SECRET="INDEPENDENT_RANDOM_VALUE_AT_LEAST_32_CHARACTERS"
TOTP_ENCRYPTION_KEY="BASE64_OF_EXACTLY_32_RANDOM_BYTES"

OPENDART_API_KEY="YOUR_OPENDART_KEY"
GOLD_API_KEY="YOUR_GOLD_API_HISTORY_KEY"
EIA_API_KEY="YOUR_EIA_KEY"
# NAVER Cloud API HUB에서 발급한 키의 예시입니다. 개발자센터 키는 developers를 사용합니다.
NAVER_API_PROVIDER=ncloud
NAVER_CLIENT_ID="YOUR_NAVER_CLIENT_ID"
NAVER_CLIENT_SECRET="YOUR_NAVER_CLIENT_SECRET"
ALPACA_API_KEY="YOUR_ALPACA_KEY"
ALPACA_API_SECRET="YOUR_ALPACA_SECRET"
SEC_USER_AGENT="Orsem monitored-email@example.com"

DISCORD_BOT_TOKEN="YOUR_DISCORD_BOT_TOKEN"
DISCORD_SERVICE_TOKEN="INDEPENDENT_RANDOM_VALUE_AT_LEAST_32_CHARACTERS"
DISCORD_APPLICATION_ID="YOUR_APPLICATION_ID"
DISCORD_CHANNEL_ID="YOUR_CHANNEL_ID"
DISCORD_ALLOWED_USER_IDS="USER_ID_1,USER_ID_2"
# DISCORD_GUILD_ID="YOUR_OPTIONAL_GUILD_ID"
```

MySQL·Redis URL의 비밀번호에 `@`, `:`, `/`, `#`, `%` 등이 있으면 URL 구성요소로 인코딩합니다. Redis ACL 사용자나 인증 방식은 실제 서버 설정과 맞춰야 하며, 위 `default`와 비밀번호 예시는 인증 설정을 자동으로 만드는 명령이 아닙니다. 운영 API는 MySQL·Redis 연결 설정, 32자 이상의 세션 비밀 값과 정확히 32바이트의 정규 base64 TOTP 키를 요구합니다. [배포 문서](DEPLOYMENT.md)의 나머지 필수 환경 설정도 필요합니다.

### NAVER 키 발급처와 공급자 선택

`NAVER_API_PROVIDER`는 `developers` 또는 `ncloud`를 명시합니다. 생략하면 기존 배포와의 호환성을 위해 `developers`를 사용하므로 Cloud 키를 넣을 때는 `ncloud`를 함께 설정해야 합니다. 변수 이름 `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`은 공통이지만, 값은 선택한 서비스의 같은 Application에서 발급한 쌍이어야 합니다. 인증 실패 시 다른 공급자로 자동 전환하지 않습니다.

| 선택 값      | 발급·확인 위치                                                                | 사용 API          |
| ------------ | ----------------------------------------------------------------------------- | ----------------- |
| `ncloud`     | NAVER Cloud 콘솔 → NAVER API HUB → Application → 해당 Application → 인증 정보 | NAVER 검색 → 뉴스 |
| `developers` | NAVER 개발자센터 → Application → 내 애플리케이션 → 해당 앱 → 개요             | API 설정 → 검색   |

Cloud에는 **API HUB Application의 Client ID·Client Secret**을 넣습니다. 클라우드 계정의 일반 Access Key·Secret Key는 이 입력이 아닙니다. 발급처별 키와 호출 주소·인증 헤더의 차이는 [공식 HUB 이관 안내](https://guide.ncloud-docs.com/docs/apihub-migration), [개발자센터 앱 설정 안내](https://developers.naver.com/docs/serviceapi/search/blog/blog.md), [Orsem 소스 설정](SOURCES.md)에 설명되어 있습니다. 공급자를 바꾸거나 키를 갱신하면 아래 절차로 **API와 worker 모두** 다시 로드합니다.

## 현재 실행기에 외부 파일 연결하기

Orsem에는 공통 `CREDENTIALS_FILE`, `ORSEM_ENV_FILE` 또는 임의의 `*_FILE`을 자동으로 읽는 기능이 없습니다. 현재 앱·마이그레이션·PM2·부팅 스크립트는 저장소 루트 `.env`를 기본 설정으로 사용합니다. 외부 `runtime.env`는 **Node 또는 배포 도구가 읽어 프로세스 환경에 주입**해야 합니다.

기존 `.env`를 비밀이 없는 설정으로 남기고, 외부 파일로 옮긴 변수는 기존 `.env`에서 **줄 자체를 제거**합니다. PM2 템플릿은 커넥터·AI 항목에 대해 `.env` 값을 우선하며, 부팅 스크립트는 모든 같은 이름의 `.env` 값을 우선하므로 빈 줄 `KEY=`도 외부 값을 가릴 수 있습니다. 외부 환경을 넣는 것으로 이미 있는 `.env` 비밀 값이 자동 제거되지는 않습니다.

Node 24로 빌드한 API를 직접 실행하는 예시입니다. 필요한 비밀이 아닌 기본 설정은 기존 `.env`에서 읽습니다.

```bash
node --env-file=/home/laeti/.config/orsem/runtime.env apps/api/dist/main.js
```

`--env-file`은 파일을 쉘 스크립트로 실행하지 않고 환경 변수로 읽습니다. 이미 셸에 있는 같은 이름의 값은 파일보다 우선하므로 오래된 값을 먼저 정리합니다. 여러 파일을 쓰면 `--env-file` 옵션을 반복할 수 있습니다. [Node 환경 파일 문서](https://nodejs.org/api/cli.html#--env-filefile)

현재 PM2 템플릿을 유지하면서 외부 파일을 주입하는 예시입니다. 저장소 루트에서 기존 PM2와 같은 사용자로 실행하며, 코드 변경 시 빌드·마이그레이션을 먼저 마칩니다.

```bash
node --env-file=/home/laeti/.config/orsem/runtime.env -e '
const { spawnSync } = require("node:child_process");
const result = spawnSync("pm2", [
  "startOrReload", "ecosystem.config.cjs",
  "--only", "orsem-api,orsem-worker", "--update-env"
], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
'
```

Discord를 운영할 경우 대상 목록에 `orsem-discord`도 포함하고 API와 봇의 서비스 토큰을 함께 반영합니다. PM2의 기존 환경을 갱신하려면 `--update-env`가 필요합니다. [PM2 환경 갱신 문서](https://pm2.keymetrics.io/docs/usage/process-management/#updating-environment-variables-and-options)

부팅 시에도 같은 외부 파일을 주입해야 합니다. [기존 부팅 명령](DEPLOYMENT.md#pc-재부팅-후-자동-시작)의 Node 실행 파일 바로 뒤에 `--env-file=/home/laeti/.config/orsem/runtime.env`를 추가하는 방식입니다. 기존 자동 시작 항목을 중복 생성하지 않습니다. `start-at-boot.mjs --check`는 선택 프로세스를 확인할 뿐 실제 비밀 값·공급자 연결을 검증하지 않습니다. 외부 파일을 주입하지 않는 `npm run db:migrate`·`npm run admin:create` 역시 자동으로 외부 설정을 찾지 못하므로, 위 `spawnSync` 방식으로 `npm` 명령에도 같은 환경을 전달해야 합니다.

PM2의 환경 출력·진단 자료·저장된 프로세스 덤프에는 주입한 비밀이 포함될 수 있습니다. 실행 사용자 외에는 PM2 홈 디렉터리를 읽지 못하도록 하고, 덤프를 저장소나 지원 문의에 첨부하지 않습니다. `pm2 save`는 프로세스 목록을 저장하는 동작이며 자격 증명 파일을 보호하거나 부팅 시 외부 파일을 읽도록 설정하는 동작은 아닙니다.

## 갱신과 복구

- Web Push: VAPID 키는 외부 업체에서 발급하지 않고 `npm run push:setup`으로 생성합니다. 공개 키만 브라우저로 전달하며 비공개 키는 서버 밖으로 반환하지 않습니다. 재시작마다 재생성하지 않으며, 키를 교체하면 기존 브라우저에서 알림을 해제하고 다시 연결해야 합니다. JSON 파일 권한은 그룹 읽기를 포함해 `0600`만 허용합니다.
- 카카오·토스: 새 JSON을 같은 비공개 디렉터리의 임시 파일에 작성하고 권한과 형식을 확인한 뒤 원자적으로 교체합니다. 카카오는 API, 토스는 API·worker를 재시작하고 기능 상태를 확인합니다. 이전 환경 값이 JSON보다 우선하지 않는지도 확인합니다.
- 토스 OAuth: 액세스 토큰을 JSON에 손으로 보관하지 않습니다. worker가 REST·WebSocket용 토큰을 Redis에 공유합니다. 같은 자격 증명을 쓰는 별도 클라이언트를 조정 없이 실행하지 말고 기존 [토스 토큰 운영 정책](OPERATIONS.md#toss-securities-chart-setup)을 따릅니다. Redis 전체를 비워 토큰을 갱신하면 세션과 큐도 영향을 받으므로 사용하지 않습니다.
- OpenDART·NAVER·Alpaca·AI: 외부 환경 값을 교체하고 API·worker에 다시 주입합니다. 키가 없으면 해당 선택 커넥터만 비활성화됩니다. DB·Redis·필수 인증 비밀의 누락은 운영 시작 실패 원인이므로 선택 커넥터와 구분합니다.
- Discord: 공급자 봇 토큰 교체는 Discord 프로세스에 반영합니다. `DISCORD_SERVICE_TOKEN` 교체는 API와 봇을 함께 갱신합니다. 현재 단일 토큰만 검증하므로 양쪽 값이 다르면 내부 요청이 거절됩니다.
- MessengerBotR: `Database/orsem-state.json`을 카카오 로그인 JSON에 합치지 않습니다. 분실·유출 시 서버에서 기기를 폐기하고 새 연결 코드로 다시 연결합니다. 앱의 비공개 저장소와 암호화된 백업만 사용합니다. [브리지 설정](../integrations/messengerbot-r/README.md)
- `SESSION_SECRET`: 교체하면 기존 서명 쿠키가 유효하지 않아 사용자가 다시 로그인해야 합니다. 관리자·회원에게 미치는 영향을 고려해 API를 재시작합니다.
- `TOTP_ENCRYPTION_KEY`: 단순 교체하면 DB에 저장된 기존 TOTP 비밀을 복호화할 수 없습니다. 현재 자동 재암호화·키 순환 기능이 없으므로 이전 키와 DB를 함께 복구 가능하게 보관하고, 별도의 재암호화·재등록 절차를 마련한 뒤 변경합니다.
- 관리자 비밀번호·복구 코드: `ADMIN_PASSWORD`는 관리자 생성 CLI의 일회용 입력일 뿐입니다. 생성 후 환경에서 제거하고 비밀번호·TOTP 복구 코드는 개인 비밀번호 관리자에 보관합니다. 세션 비밀 값과 TOTP 암호화 키를 서로 재사용하지 않습니다.

키 발급 시점·담당자·갱신 예정일·사용 서비스·파일 경로만 비밀이 없는 운영 기록에 남깁니다. 실제 값과 백업은 접근을 제한한 비밀 저장소에 두며, 파일을 옮기거나 삭제하는 것만으로 공급자의 기존 키가 폐기되지는 않습니다.
