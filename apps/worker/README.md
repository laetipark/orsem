# Orsem worker

Nest 애플리케이션 컨텍스트에서 실행되는 worker입니다. OpenDART 주기 조회, 변경 불가능한 원문 저장, 결정적 파싱, 조회용 데이터 생성, 커넥터 상태 점검, 이용 권리가 확인된 뉴스 본문 수집·번역, 토스 시장 데이터 수집을 담당합니다. HTTP 포트를 열지 않으며 자동 거래 주문을 생성하지 않습니다.

## 실행 시 동작 계약

- OpenDART `D001`, `D002`, `D003`, `D004`, `D005`는 각각 별도 스트림으로 조회합니다.
- KST 기준 평일 `08:00–19:59`에는 2분, 나머지 평일 시간에는 5분, 주말에는 30분 주기를 사용합니다.
- `corpCode.xml`은 일요일 `03:30` KST에 갱신합니다.
- 정기 조회는 성공한 체크포인트와 겹치는 구간을 조회합니다. 과거 수집 작업은 최대 90일 구간으로 나누고 항상 `suppressAlerts=true`를 설정합니다.
- 체크포인트는 해당 구간의 모든 페이지가 성공한 뒤에만 전진합니다.
- 상태 `020`은 다음 KST 날짜까지 DB 기반 회로를 차단하고, 멱등성이 적용된 운영 알림 하나를 만듭니다. 반복 작업이 아닌 작업은 조용히 버리지 않고 지연합니다.
- 원본 압축 파일은 SHA-256 내용 해시로 식별하며, 쓰기와 `fsync` 뒤 같은 디렉터리 안의 원자적 링크로 확정합니다.
- DART 접수일과 거래일은 날짜로 유지합니다. 이 값으로 게시 시각이나 사건 발생 시각을 만들어내지 않습니다.
- D005/D002 연결은 검토가 필요한 `EXECUTION_CANDIDATE` 관계로 유지하며, 어느 보고서의 파싱이 먼저 끝나든 대조합니다.
- 모든 공시는 DB와 `WEB` 스트림에 남습니다. Discord/Messenger 실시간 전송은 `realtimeAlerts=true`인 P1/P2 관심 기업으로 제한하며, 기업에 속하지 않는 운영 알림은 계속 활성화합니다.

## 커넥터 이용 권리

| 커넥터                | 이용 권리 모드         | 설정                                                                     |
| --------------------- | ---------------------- | ------------------------------------------------------------------------ |
| OpenDART / SEC        | `OFFICIAL_PUBLIC_DATA` | API 키 또는 식별 가능한 User-Agent                                       |
| Samsung Global IR     | `PRIVATE_DISPLAY_ONLY` | 검토된 정확한 Global RSS와 로그인 개인 화면                              |
| Federal Reserve / BLS | `OFFICIAL_PUBLIC_DATA` | 검토된 공식 RSS와 공식 기사 호스트, 텍스트 본문만                        |
| GDELT                | `STORE_METADATA_ONLY` | 제목·출처·언어·원문 링크, 본문·이미지·자동 번역 없음                     |
| Alpaca 자산 마스터    | `PRIVATE_DISPLAY_ONLY` | Alpaca 자격 증명, 기업 식별 정보만 제공                                  |
| Toss Securities       | `PRIVATE_DISPLAY_ONLY` | `TOSS_CREDENTIALS_FILE` 또는 주입한 클라이언트 자격 증명, 허용된 서버 IP |

본문을 제공하는 IR과 뉴스 경로는 검토된 콘텐츠 프로필과 정확히 일치해야 하며 HTTPS를 사용해야 합니다. 리디렉트와 사설 주소로의 해석을 거절하고 발견한 본문 링크도 프로필의 공식 호스트로 제한합니다. GDELT의 외부 기사 링크는 별도 메타데이터 전용 정책과 공개 URL 검사를 적용합니다.

정기 발견 작업은 소스 계약을 따릅니다. SEC P1/P2와 승인 소유자의 개인 그룹 미국 종목은 기존 커넥터 큐에서 10분마다 중복 CIK를 합쳐 조회합니다. Samsung Global, Federal Reserve, BLS는 독립 `orsem-market-news` 큐에서 15분마다 조회합니다. GDELT는 같은 큐의 별도 30분 일정으로 제목과 원문 링크만 수집합니다. 이투데이·Microsoft IR과 임의 IR URL은 수집하지 않습니다.

NAVER는 API의 사용자 검색 화면만 사용합니다. 워커는 NAVER 반복 일정과 OpenDART P3 트리거를 만들지 않으며 남아 있는 이전 큐·outbox 작업은 요청 없이 완료합니다. 상태 점검에서도 NAVER 요청을 보내지 않습니다.

RSS는 피드별 HTTP 체크포인트(`RSS_HTTP:<feed URL SHA-256>`)에 ETag·Last-Modified를 보존합니다. 기사와 허용된 본문 저장이 완료된 뒤에만 검증자를 갱신하고 304는 정상 수집 확인으로 처리합니다. 손상된 항목·잘린 피드는 검증자를 갱신하지 않으며 건강한 다른 피드는 계속 처리합니다. 같은 원문 URL은 `news_articles`로 연결하고 피드별 원제목·GUID·날짜·최초 관측시각은 `source_items`에 보존합니다. 정화된 텍스트 본문은 출처별 `news_article_contents`에 저장하며 이미지·영상·실행 가능한 HTML은 저장하지 않습니다. 새 시장 뉴스·IR로 외부 알림을 생성하지 않습니다.

시장 데이터 수집은 토스증권의 `1d`·`1m` 봉만 사용합니다. 소스별 고유 키, 원본 응답·출처, 거래일, 관측 시각을 보존합니다. REST와 WebSocket은 순차적으로 발급·갱신하는 OAuth 토큰을 공유합니다. 실시간 시세는 인증된 웹 API용으로 캐시하며, 유실 가능한 스트림으로 봉 거래량을 만들지 않습니다. 기업 페이지 최초 조회는 한도가 있는 이력을 불러오고, 이후 조회는 최신 페이지를 갱신하며 같은 기업·봉 간격의 작업을 합칩니다. 수집 한도, 2초 브라우저 조회 동작, 설정은 [운영 문서](../../docs/OPERATIONS.md)를 참고하세요.

KRX/Alpaca EOD 작업은 종료되었으며 이전 작업이 큐에 남아 있어도 거절합니다. Alpaca 자산 마스터는 차트와 독립적으로 기업 식별 정보를 계속 제공합니다.

## 기업 이름 동기화

`sync-toss-stocks` 작업은 매일 07:30 KST에 관심·최근 조회 기업의 토스 공식 정보를 확인합니다. 대상은 `min(100, TOSS_MAX_SUBSCRIPTIONS)`로 제한하고 정상 `STOCK_INFO:<companyId>` 응답을 24시간 재사용합니다. 차트 조회도 같은 캐시를 사용합니다. 별도로 등록한 한국어 이름과 기존 영문명은 보존하고, 식별 정보가 일치하는 해외 기업에 토스 한글명만 보완합니다. 원본·출처·이용 권리·관측 이력을 유지하며, [상세 계약](../../docs/OPERATIONS.md#해외-기업의-한글명-보완)을 따릅니다.

## 뉴스 한국어 번역

`NEWS_TRANSLATION_ENABLED=true`이면 허용된 영문 뉴스 제목과 전문을 로컬 Ollama로 번역합니다. 공시 AI 분류와 독립적인 기능이며 번역도 별도 큐에서 순차 처리합니다. 기본 주기는 1분, 처리 상한은 3건, 요청 제한 시간은 120초입니다. 원문 제목·본문·시각·해시를 덮어쓰지 않고 완료된 한국어 번역을 별도로 저장합니다.

`sourcePolicyJson`의 본문 저장·표시·AI 권한이 모두 `true`인 출처만 번역합니다. NAVER·GDELT·이투데이·Microsoft IR, DART·SEC 공시와 `STORE_METADATA_ONLY`·`LINK_ONLY`·`NO_REDISTRIBUTION`은 번역에서 제외합니다. 외부 유료 API 대체 호출은 없습니다. 본문을 제공하는 영문 기사는 제목과 전문 번역이 모두 현재 해시와 일치하기 전에는 `/news`에 공개하지 않습니다. GDELT 외부 링크 카드는 별도 메타데이터 표시 경로를 사용합니다. 설정과 실패 시 동작은 [뉴스 번역 안내](../../docs/NEWS_TRANSLATION.md)를 참고하세요.

## 환경 설정

필수 인프라 설정은 `DATABASE_URL`과 `REDIS_URL`입니다. 소스 자격 증명이 없으면 해당 커넥터만 비활성화합니다. 관련 선택 변수는 `OPENDART_API_KEY`, `SEC_USER_AGENT`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `IR_FEED_URLS`, `NEWS_RSS_FEEDS`, `GDELT_ENABLED`, `GDELT_NEWS_DOMAINS`입니다. Alpaca 자격 증명은 자산 마스터에만 사용합니다. 토스에는 `TOSS_CREDENTIALS_FILE` 또는 `TOSS_CLIENT_ID`/`TOSS_CLIENT_SECRET` 쌍과 `MARKET_DATA_PROVIDER=toss`가 필요합니다. `TOSS_MAX_SUBSCRIPTIONS`의 기본값은 100이고 1–100을 허용합니다.

운영 환경의 `RAW_DOCUMENT_DIR`은 저장소 밖을 가리켜야 합니다. AI 검토는 선택 기능(`AI_ENABLED`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY`, `AI_TIMEOUT_MS`)이며 감사 가능한 검토 제안만 만들 수 있습니다. 결정적 허용 목록 분류를 최종 기준으로 유지합니다. 제공하는 로컬 Ollama 설정은 `qwen3.5:4b-q4_K_M`, 4,096토큰 문맥, 로드된 모델 하나, 동시 요청 하나, CPU 최초 시작을 고려한 120초 분류 제한 시간을 사용합니다. AI 작업은 동시 실행 수가 1인 전용 `orsem-ai-review` 큐를 사용하므로 로컬 추론이 결정적 공시 후처리를 막지 않습니다.

worker는 Nest 모듈을 평가하기 전에 작업 공간의 `.env`를 읽고, 이미 내보낸 프로세스 변수는 유지합니다. 운영 시작 시 개발용 DB·Redis 기본값과 잘못된 연결 프로토콜을 거절합니다.
