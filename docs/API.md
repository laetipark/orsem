# REST API

## 조건부 개인 뉴스 metadata v2 (2026-09-07)

기존 뉴스·검색·대시보드 경로를 재사용한다. 신규 provider별 조회 endpoint나 범용 RSS proxy는 없다. 서버가 인증된 사용자에서 독자를 정하고 신규 개인용 뉴스는 관리자 세션의 `ADMIN_UI`로만 반환한다. 회원·공유방·봇에는 별도 승인이 없는 한 해당 레코드, 제목·요약·번역, 연결 회사, 개수·정렬 영향과 공식 참조를 노출하지 않는다. 클라이언트가 audience query로 권리를 올릴 수 없다.

뉴스 응답에는 선택적인 `providerCount`, `independentSourceCount`, `officialVerification: UNVERIFIED | LINKED | CONFIRMED`, `officialReferences`를 추가한다. 기존 `sourceKind`, `relatedCompanies`, 발행 시각·원문 URL과 함께 사용한다. `officialReferences`는 허용된 기존 DART 공시·SEC·기업 공식 자료의 kind/id/title/url, 관련성·검토 상태를 담으며 대상 해시가 바뀌면 확인 상태를 낮춘다. LINKED는 자동 관련 후보이고 CONFIRMED는 관리자의 관련성 확인이다. 뉴스 수치의 공식 검증이나 투자 신호를 뜻하지 않는다.

`GET /operations/sources`의 관리자 응답에 신규 provider/IR/RSS 상태를 합친다. `enabled`, `lastSuccessAt`, `lastErrorAt`, 정제된 `lastError`, `nextRunAt`, `dailyRequestCount/Budget`, `rollingRequestCount/Budget`, 안전하게 표시한 `lastCursor`, `rightsStatus`, `entitlementStatus`를 제공한다. 키, 원래 요청 URL, raw 오류/응답은 반환하지 않는다.

기존 `POST /ir-sources`, `PATCH /ir-sources/:id`는 코드의 정확한 URL 프로필과 정책·상장 company master를 검증한다. NVDA·AVGO·PANW는 해당 미국 상장기업만 연결할 수 있고 기본 inactive다. 미승인 프로필은 active 요청을 거부한다. Samsung의 기존 등록 계약은 유지한다.

기존 `POST /reviews/:id/resolve`는 `SOURCE_ITEM` 검토에 `sourceHash`, 선택적인 기존 `companyIds`, 등록된 `officialTarget: {kind: 'FILING' | 'SOURCE_ITEM', id}`를 받는다. 관리자만 현재 원본 해시와 권리를 검증하여 처리한다. 회사 자동 생성·공시 정정 계보 변경은 하지 않는다. 결정 전후 관계·관리자·시각은 기존 review와 source metadata에 감사 기록으로 남긴다.

모든 경로는 `/api/v1` 아래에 있습니다. 비공개 브라우저 경로에는 활성 로컬 관리자 계정이 필요하며, 승인된 카카오 조회 회원은 명시적으로 허용된 조회 경로와 본인 알림 설정만 이용할 수 있습니다. 신규 카카오 회원은 승인 전 비공개 데이터에 접근할 수 없습니다. 봇 경로는 범위가 제한된 bearer 토큰을 사용합니다. 일반 목록 경로는 `{ "items": [], "nextCursor": null }`을 반환하며, 소수와 큰 정수 수량은 JSON 문자열로 전달합니다.

## 시장 지표·공통 신선도

- `GET /sources/freshness`는 관리자와 승인된 회원에게 `{asOf, items}`를 반환합니다. 저장된 이름·상태·마지막 성공 시각만 읽으며 외부 공급자를 호출하거나 운영 진단 메시지를 노출하지 않습니다.
- `GET /markets/overview?region=all|kr|us&historyRange=1m`는 시장 지표 요약을 반환합니다. 금리 변화는 `changeUnit=bp`, 코인의 `convertedValue`는 원/달러 참고 환율을 적용한 USD 환산값입니다. 시각·출처·단위·비교 기준·신선도를 포함하고, 위젯 전용 지수의 시세 값은 `null`입니다.
- `GET /markets/:id/history?range=1m|3m|1y`는 실제 저장된 날짜별 점만 반환합니다. 금·은은 `historyKind=daily_average`, 원/달러는 `observed`입니다. 수집 지연 시 기존 점과 `STALE` 상태를 함께 반환합니다.
- `GET /watchlist/quotes?ids=UUID,UUID`는 최대 100개 관심기업의 저장된 시세를 일괄 조회합니다. 응답은 `{asOf, items}`이며 `previousClose`, `change`, `changePercent`, `referenceDate`는 비교 기준이 없으면 `null`입니다. 캐시는 Redis MGET으로 읽습니다.
- 기업·관심기업·이벤트·공시·뉴스·검색의 `region=all|kr|us` 기본값은 `all`입니다. 서버에서 지역 조건을 적용한 다음 페이지를 나눕니다. 지역 미확인 뉴스와 글로벌 시장 지표는 `all`에만 포함됩니다.

시장 지표의 무료 키 발급·공급자별 정의는 [시장 지표 운영](MARKET_INDICATORS.md)을 참고하세요.

## 세션과 카카오 회원

- `GET /auth/session`은 `authenticated`, `canAccess`, `csrfToken`, `user`, `setupRequired`를 반환합니다. `user`는 null일 수 있으며, 값이 있으면 `id`, null이 가능한 `email`·`displayName`, `provider=LOCAL|KAKAO`, `role=ADMIN|VIEWER`, `status=PENDING|APPROVED|REJECTED`, `totpEnabled`를 포함합니다.
- 승인 대기·거절 회원은 인증된 상태를 유지하지만 `canAccess=false`입니다. 브라우저는 `authenticated=true`만으로 비공개 데이터 조회를 허용하면 안 됩니다.
- `GET /auth/kakao/config`는 공개 경로입니다. 설정이 없거나 잘못됐거나 테스트 데이터 모드이면 `{ "enabled": false, "startUrl": null }`을 반환합니다. 설정이 갖춰지면 `startUrl`은 `/api/v1/auth/kakao/start`입니다.
- `GET /auth/kakao/start`는 브라우저 리다이렉트 흐름을 시작합니다. `GET /auth/kakao/callback`은 세션에 연결된 일회용 state를 소비하고 ID 토큰을 검증합니다. 두 공개 경로는 카카오 또는 고정된 `/login?kakao=success|error` 화면으로 리다이렉트하며, 공급자 토큰을 반환하지 않습니다. 자격 증명 설정이 있다고 실제 외부 로그인 흐름까지 검증됐다는 뜻은 아닙니다.
- `GET /auth/members?status=PENDING|APPROVED|REJECTED`는 관리자 전용입니다. 선택적인 상태 필터를 적용해 최근 회원을 최대 100명 반환하며, 응답은 `{ "items": [...], "nextCursor": null }`입니다. 각 항목은 `id`, `provider`, `role`, `status`, null이 가능한 `displayName`, `createdAt`, `updatedAt`, null이 가능한 `lastLoginAt`·`reviewedAt`을 포함합니다.
- `PATCH /auth/members/:id`는 관리자 전용이며 정확히 `{ "status": "APPROVED" }` 또는 `{ "status": "REJECTED" }`를 받아 변경된 회원을 반환합니다. `ADMIN` 권한을 부여하지 않습니다.
- `POST /auth/logout`은 승인 대기 회원을 포함한 모든 세션에서 사용할 수 있습니다. 익명 Orsem 세션을 재생성하고 새 CSRF 토큰을 반환합니다. 카카오계정 로그아웃이나 연결 해제는 수행하지 않습니다.

로그인·로그아웃을 포함해 상태를 바꾸는 브라우저 요청에는 세션의 `x-csrf-token`이 필요합니다. `Origin` 헤더가 있으면 `WEB_ORIGIN`과 일치해야 합니다. 로컬·카카오 로그인 성공 시 세션을 재생성하며, 보호된 요청은 계정의 현재 DB 상태를 다시 확인합니다. [카카오 설정과 검증](KAKAO_LOGIN.md)을 참고하세요.

## 개인 브라우저 알림

활성 관리자와 승인된 회원은 아래 경로에서 본인의 설정·기기만 관리합니다. 소유자 ID는 요청에서 받지 않고 세션으로 결정합니다. 변경 요청에는 기존 CSRF·Origin 검사가 적용됩니다.

- `GET /notifications/settings`: `enabled`, `topics`, `watchlistOnly`, `pushConfigured`, 공개 `publicKey`, 본인 기기의 `id`·`deviceName`·등록/확인 시각. 구독 endpoint·암호화 키·VAPID 비공개 키는 반환하지 않습니다.
- `PATCH /notifications/settings`: `{enabled, topics, watchlistOnly}`. 토픽은 `FILINGS`, `ANALYSIS`, `CORRECTIONS`, `NEWS`, 관리자 전용 `OPERATIONS`. 변경 시 기존 대기 발송을 취소합니다.
- `POST /notifications/subscriptions`: 브라우저가 생성한 `{endpoint, expirationTime, keys: {p256dh, auth}, deviceName}`. 지원하는 HTTPS Push 공급자만 허용하며 계정당 최대 10개입니다. 다른 계정에 연결된 endpoint는 `409`로 거절합니다.
- `DELETE /notifications/subscriptions/:id`: 본인 기기의 구독과 대기 발송을 해제합니다. 다른 소유자의 ID는 `404`입니다.
- `POST /notifications/test`: `{subscriptionId}`. 본인의 연결된 기기에 테스트 알림을 큐에 넣습니다. 분당 5회 제한이며 worker가 실제 전송합니다.

기본값은 알림 꺼짐입니다. 알림 수신에는 사용자 설정 활성화와 해당 브라우저의 명시적 권한 허용이 모두 필요합니다. 조회 회원의 변경 권한은 이 개인 알림 경로로 한정됩니다. [브라우저 알림 안내](WEB_PUSH.md)를 참고하세요.

## 브라우저

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/session`
- `GET /dashboard`
- `GET /search?q=...&limit=5` — 저장된 종목, 표시가 허용된 뉴스 제목·제공 요약, 국내외 공시 메타데이터 통합 검색
- `GET /events`, `GET /events/:id`
- `GET /filings`, `GET /filings/:id` — 메타데이터
- `GET /companies`, `GET /companies/:id`, `GET /companies/:id/timeline`
- `GET /companies/:id/live-price` — 캐시에 있는 최신 토스 시세와 신선도 상태 반환
- `GET /news` — 허용된 뉴스 메타데이터와 별도의 임시 `providerGroups` 응답
- `GET /news/:id` — 기존 주소 호환용 메타데이터와 안전한 원문 URL, `content: null` 응답
- `GET|PATCH /news/:id/translation-edit` — 종료된 본문 편집 경로. 기존 관리자·CSRF 검사를 유지하고 `410 Gone` 반환
- `GET|POST /watchlist`, `PATCH|DELETE /watchlist/:id`
- `GET|POST /ir-sources`, `PATCH|DELETE /ir-sources/:id` — 쓰기는 코드에 등록된 정확한 콘텐츠 프로필만 허용
- `GET /reviews`, `POST /reviews/:id/resolve`
- `GET /operations/sources`, `GET /operations/runs`, `GET /operations/queues`
- `POST /operations/backfills`
- `POST /operations/alpaca/assets/sync` — 중복 제거된 Alpaca 자산 마스터 갱신 작업 하나를 등록하며 분당 요청 2회로 제한
- `POST /operations/retry/:runId` — 현재 `501` 반환. 안전한 실행 이력 재처리가 구현되기 전에는 단일 실패 공시에 공시 재처리 기능 사용
- `POST /operations/filings/:id/reprocess`
- `GET /filings/:id/document`

승인된 조회 회원은 대시보드, 통합 검색, 기업(타임라인·현재가 포함), 공시 메타데이터, 이벤트, 뉴스, 관심 목록의 명시적으로 허용된 `GET`/`HEAD` 경로와 본인 알림 설정만 이용할 수 있습니다. 공용 데이터 변경, 검토, IR 소스, 운영, 회원 관리, 공시 문서 다운로드, 비밀번호·TOTP 관리 등 나머지 비공개 브라우저 경로는 관리자 전용입니다. 위에서 설명한 인증·세션 경로에는 각각의 공개 접근 규칙을 적용합니다.

필터는 `detailType`, `priority`, `companyId`, `nature`, `reviewStatus`, `from`, `to`, `limit`, 내부 구조가 노출되지 않는 `cursor` 같은 명시적 쿼리 매개변수를 사용합니다. 각 이벤트·소스 응답은 해당되는 경우 소스, 소스 URL, 이용 권리 모드, 증거 등급, 관측 시각, 파서·검토 상태를 포함합니다.

기업 타임라인은 `range=1M|3M|1Y`와 `interval=1d|1m`을 받습니다. 차트 공급자는 토스만 사용하며 `source=legacy`는 거절합니다. 각 응답에는 한 소스만 포함됩니다. 토스 데이터가 없어도 KRX나 Alpaca 데이터로 대체하지 않습니다. `provider`, `interval`, `status`로 준비된 데이터, 자격 증명 누락, 수집 대기를 구분합니다. 화면 조회 요청은 브라우저나 API 프로세스에서 토스를 직접 호출하지 않고, 한도가 적용되고 중복이 제거된 갱신 작업을 등록합니다.

일봉의 `time`은 시장 거래일이며 분봉의 `time`은 UTC ISO 시각입니다. 분봉 응답에는 최근 봉을 최대 1,000개 포함합니다. `sessionDate`와 `observedAt`은 거래일과 관측 맥락을 별도로 보존합니다. 분봉 응답은 일간 수익률을 계산하거나 분 단위 공시 시각을 만들어내지 않습니다. 화면은 이벤트 수익률과 마커 목록에 사용할 일봉 데이터를 따로 조회합니다.

모든 봉은 `source`와 `rightsMode`를 포함합니다. `priceSources`는 출처 표기, 수정주가 여부, 피드, 제한사항을 제공합니다. 토스 REST 봉은 `adjusted=false`로 요청하며 `TOSS_KR` 또는 `TOSS_US`로 표시합니다. 국내 WebSocket 스트림만 `TOSS_KR_INTEGRATED`(KRX+NXT)로 명시합니다. REST 봉 명세에서는 같은 거래소 범위가 확인되지 않습니다.

인증이 필요한 현재가 경로는 `NOT_CONFIGURED`, `WAITING`, `LIVE`, `STALE`, `UNAVAILABLE` 중 하나와 null이 가능한 시세를 반환합니다. 시세에는 십진 문자열 `price`, 공급자 시각과 관측 시각, 통화, 소스, 이용 권리, `lossy=true`가 포함됩니다. OAuth 토큰이나 공급자의 원본 응답은 노출하지 않습니다. 브라우저는 페이지가 보이는 동안 현재가와 선택한 차트를 2초마다 조회하며, 분봉 화면은 이벤트 수익률용 일봉도 조회합니다. 차트 응답은 저장된 데이터를 포함하고, 중복 제거된 worker 작업이 비동기로 봉을 갱신합니다. 신선도는 공급자·관측 시각으로 판단하며, 조회 주기가 소스의 지연 시간을 보장하지는 않습니다.

## 통합 검색

`GET /search`는 현재 수집되어 DB에 저장된 메타데이터만 조회합니다. 외부 검색 엔진이나 데이터 공급자를 실시간으로 검색하지 않으며, 검색 요청으로 수집 작업을 등록하거나 저장된 데이터를 변경하지 않습니다. 로컬 관리자와 승인된 `VIEWER`만 사용할 수 있고, 비로그인·승인 대기·거절 회원은 차단합니다. 요청 한도는 분당 90회입니다.

| 매개변수 | 계약                            |
| -------- | ------------------------------- |
| `q`      | 필수, 앞뒤 공백 제거 후 1–120자 |
| `limit`  | 그룹별 결과 수, 1–10, 기본값 5  |

정의되지 않은 쿼리 매개변수는 `400`으로 거절합니다. 응답은 `{ query, companies, news, filings, hasMore: { companies, news, filings } }`입니다. 각 결과 배열은 그룹별 `limit`를 따르며, `hasMore`의 각 불리언은 추가 결과가 있는지를 나타냅니다.

각 항목은 `id`, `type=COMPANY|NEWS|FILING`, `title`, `subtitle`, `url`, `external`, `companyId`, `source`, `rightsMode`, `publishedAt`, `rceptDate`, `firstObservedAt`을 포함합니다. 부가 정보인 `companyId`, `source`, `rightsMode`, 세 가지 날짜·시각 필드는 값이 없으면 null을 사용합니다.

- 종목은 기업 식별자, 한글·영문명, 별칭으로 검색하고 `/companies/:id`로 연결합니다.
- 뉴스는 제목과 연결된 기업으로 검색하고 `url`의 원문을 새 탭으로 엽니다(`external: true`). `description`, `relatedCompanies`, `translationStatus`를 제공하며 본문이나 번역 준비 여부로 뉴스 노출을 막지 않습니다. SEC 공시는 공시 그룹에 포함합니다.
- 뉴스는 현재 원문·출처·권리 조건에 맞는 완료된 한국어 번역 제목으로도 검색합니다. 조회가 번역 작업을 실행하지는 않습니다.
- 공시는 제목, 접수번호, 기업으로 검색합니다. 국내 공시는 DART, 미국 공시는 SEC의 공식 원문 URL로 연결합니다.

검색 응답에는 메타데이터만 포함하며 기사·공시 본문을 반환하지 않습니다. 뉴스는 소스의 메타데이터 저장·표시 정책과 제공자 허용 목록을 적용합니다. 검토되지 않은 GDELT·Alpaca News 요약이나 번역을 추가로 노출하지 않습니다. `NO_REDISTRIBUTION` 항목, 자격 증명이 포함된 URL, HTTP(S)가 아닌 URL은 제외합니다. 웹의 종목·뉴스·공시 탭은 받은 결과를 분류해 보여주며 API에 `type` 필터를 전달하지 않습니다.

뉴스의 `SourceItem`에는 제목·제공 요약·출처와 `relatedCompanies`, `displayMode: 'EXTERNAL_LINK'`, `contentState: 'UNAVAILABLE'`, `contentSourceId: null`, `contentLanguage`, `translated`가 포함됩니다. 선택적인 `translationStatus=PENDING|COMPLETED|FAILED|UNAVAILABLE`로 번역 대기·완료·실패·비대상을 구분하고 `translation?: { language: 'ko', title, description, translatedAt, provider: 'LOCAL'|'AZURE', model } | null`로 검증된 메타데이터 번역을 제공합니다. `AZURE`는 기존 저장 결과의 출처 표시이며 신규 번역은 로컬 공급자를 사용합니다. `GET /news/:id`는 `content: null`을 반환하며 원문 URL이 안전하지 않거나 표시 권한이 없으면 404를 반환합니다. 원래 제목·요약·출처를 덮어쓰지 않고 본문 블록이나 내부 오류는 반환하지 않습니다. 수동 메타데이터 v2는 원문 해시와 저장된 감사 이력이 일치할 때 표시합니다. [번역 응답 계약](NEWS_TRANSLATION.md#api와-검색)을 참고하세요.

`GET /news`의 `scope=all|market|company` 기본값은 `all`입니다. `market`은 Federal Reserve·BLS와 네이버의 `증시`, `금리`, `환율` 주제 검색 결과를 반환하고 `company`는 확인된 기업 연결이 있는 기사를 반환합니다. `asset=gold|silver|wti|btc|eth`가 있으면 해당 자산의 임시 네이버 검색 결과만 반환하며 DB 뉴스는 섞지 않습니다. 자산 검색어는 각각 `국제 금값`, `국제 은값`, `WTI 유가`, `비트코인`, `이더리움`입니다. 네이버 경제탭의 편집 목록을 그대로 제공하는 API는 아닙니다.

## Discord 서비스

- `GET /bots/discord/status`
- `GET /bots/discord/recent?limit=5`
- `GET /bots/discord/company?q=005930`
- `POST /bots/discord/outbox/pull`
- `POST /bots/discord/outbox/:deliveryId/ack`

## MessengerBotR 기기

- `POST /bots/messenger/pairings` — 관리자 세션으로 짧은 유효기간의 코드 생성
- `POST /bots/messenger/pair`
- `POST /bots/messenger/heartbeat`
- `POST /bots/messenger/command`
- `POST /bots/messenger/outbox/pull`
- `POST /bots/messenger/outbox/:deliveryId/ack`

연결 코드는 인증된 관리자가 생성하며 10분 뒤 만료됩니다. 전송 대상 조회는 행을 60초 동안 점유하며, 수신 확인은 성공을 확정하거나 한도가 적용된 재시도를 예약합니다.

## 기업 차트 보조지표

`GET /companies/:id/timeline`은 선택 기간의 `prices`와 별도로 `indicatorWarmupPrices`를 제공합니다. 표시 기간 직전의 동일 공급자·동일 봉 주기에서 최대 119개 저장된 봉을 읽어 120봉 이동평균 등의 초기 계산에 사용합니다. 보충 봉은 표시 범위와 수익률 계산에 포함하지 않으며, 누락된 가격을 생성하거나 공급자를 새로 요청하지 않습니다. 이전 응답과의 호환을 위해 이 필드는 선택적입니다. 프런트엔드는 보충 봉을 포함해 SMA와 Wilder RSI를 계산한 뒤 표시 기간으로 자릅니다. 연속 유효 봉이 부족하면 지표 수치를 만들지 않고 안내합니다.

## 종목 주소·기본정보·개인 뉴스

- `GET /companies?q=...&region=all|kr|us&cursor=...`: 이름순 목록. 항목에 선택적인 `canonicalPath`, `quote`를 포함합니다. quote는 가격·등락률·거래량·시세 및 비교 기준일·별도 시총 기준일을 제공합니다. DB 조회를 기업별로 반복하지 않습니다.
- `GET /companies/quotes?ids=UUID,UUID`: 승인된 사용자가 최근조회 등 일반 기업의 저장된 시세를 최대 20개 고유 UUID로 조회합니다. `{asOf, items: [{companyId, displayPrice}]}`를 반환하며 그룹 시세와 같은 가격·종가 기준·비교 기준일·등락 계산을 사용합니다. 존재하지 않는 기업은 생략하고 나머지는 요청 순서를 유지합니다. 명시적 빈 `ids=`는 빈 결과입니다. 응답은 private/no-store이며 기존 `/watchlist/quotes`의 관심목록 제한은 변경하지 않습니다.
- `GET /companies/:codeOrTicker`: UUID 또는 코드·티커·거래소:티커를 해석하고 상세 응답에 내부 UUID와 `canonicalPath`를 반환합니다. 모호한 심볼은 409, 없는 종목은 404입니다.
- `GET /companies/:uuid/information`: 필드별 값·단위·보고기간·출처·관측 시각. 시세·기업개요·재무에 확인된 값만 제공합니다.
- `GET /search/suggestions?kind=all|companies|news|events&region=all|kr|us`: 검색어는 URI 인코딩한 `X-Orsem-Search-Query` 헤더로 전달합니다. 응답은 no-store이며 내부 정보만 조회합니다. 입력·후보 선택 중 NAVER 요청을 만들지 않습니다.
- `GET /dashboard/market-selection`: 국내·미국 각각 월간 시총 상위 20개 대표 종목. 상태·기준일·관측 시각·출처·선정 월·다음 KST 갱신 시각·통화·공급자 범위를 제공합니다. ETF·우선주·ADR은 제외합니다. 실패 시 마지막 정상 목록을 반환합니다.
- `GET /watchlist`: 위 월간 목록의 호환 읽기 경로입니다. 기존 수동 `POST /watchlist`, `PATCH /watchlist/:id`, `DELETE /watchlist/:id`는 410을 반환합니다. 개인·공유방 그룹 API는 그대로 유지합니다.
- `GET /dashboard/personal-news`, `GET /dashboard/personal-filings`: 세션 소유자의 개인 그룹 합집합. 쿼리로 다른 사용자를 지정할 수 없고 응답은 private/no-store입니다. 공시는 분석 전 원본도 포함합니다.
- `GET /watchlist-groups/:id/news?companyId=...&limit=20&cursor=...`: 세션 소유 개인 그룹 또는 참여 중인 공유방 그룹의 뉴스입니다. 종목 관리 권한 없이 읽을 수 있으며, `companyId`를 생략하면 그룹 전체 최대 200종목을 집계합니다. 뉴스 페이지에 `group`, 전체 그룹의 순서 있는 `companies`, 현재 필터의 `companyCount`, `asOf`를 추가합니다. 그룹 밖 종목 필터는 400, 접근 불가능한 그룹은 404입니다.
- `GET /watchlist-groups/:id/filings?companyId=...`: 같은 접근권한과 기업 필터로 최신 원본 공시 최대 8건을 반환합니다. `{group, companies, companyCount, asOf, items}` 형식이며 DART와 SEC의 접수·발표 날짜, 최초 수집 시각, 원문 주소를 유지합니다. 두 그룹 소식 응답은 private/no-store입니다.
- `GET /news?scope=company&companyIds=UUID,UUID`: 현재 브라우저의 최근조회 목록처럼 여러 기업의 관련 뉴스 합집합을 가져옵니다. 서로 다른 UUID 최대 20개를 받으며 `companyId`나 `asset`과 함께 사용할 수 없습니다. 명시적인 빈 `companyIds=`는 빈 결과를 반환합니다. 그룹·최근조회 배열은 이미 유효한 네이버 스냅샷만 읽고 기업별 신규 검색을 시작하지 않습니다. 단일 `companyId` 필터만 기존 온디맨드 검색을 사용할 수 있습니다.

`GET /news`의 DB `items`와 `nextCursor`는 저장된 기사 페이지입니다. 첫 페이지의 선택적 `providerGroups`는 네이버의 회사·시장·자산별 제공 순서이며 `naver`에 수집·갱신·다음 요청 상태가 있습니다. 화면은 이를 최신순으로 병합하되 각 공급자 목록 안의 순서를 보존합니다. 임시 기사는 DB cursor를 소비하지 않습니다. 각 네이버 항목에는 `expiresAt`, `collectedAt`, 변경하지 않은 원본 필드 `providerOriginal`이 있습니다. 관련 종목은 원제목과 제공 요약의 명확한 기업명·별칭으로 확인하며 검색 대상 종목이라는 이유만으로 부여하지 않습니다. 회사·주제 검색은 하나의 정기 순환 작업에서 15분마다 최대 10개를 처리하고 기존 무료 호출 한도를 공유합니다. 네이버 결과는 만료되는 메모리에서만 취급하며 DB·로그·AI에 저장하지 않습니다. 필터가 특정 공식 소스·출판사를 지정하면 해당하지 않는 네이버 결과는 포함하지 않습니다.

하위 차트·뉴스·그룹 요청에는 상세 응답의 UUID를 사용합니다. 웹 주소와 데이터 키의 차이는 [종목 화면](COMPANY_SCREEN.md), 데이터 보존은 [데이터 구조](DATA_MODEL.md)를 참고하세요.
