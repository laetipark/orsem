# 뉴스 수집과 표시

시장 공통 뉴스는 증시·금리·환율에 관한 네이버 키워드 검색 결과와 Federal Reserve·BLS 소식으로 구성합니다. 개인 뉴스는 로그인한 사용자의 개인 그룹에 등록된 기업을 기준으로 하며 다른 회원이나 공유방의 기업을 섞지 않습니다.

## 공식 뉴스 메타데이터

| 소스 ID                                                             | 공급자                  | 주기              | 권리와 표시 범위                           |
| ------------------------------------------------------------------- | ----------------------- | ----------------- | ------------------------------------------ |
| `samsung-global`                                                    | Samsung Global Newsroom | 15분              | `PRIVATE_DISPLAY_ONLY`, 승인된 개인 화면   |
| `fed-press`, `fed-speeches`                                         | Federal Reserve         | 15분              | 공식 공개 메타데이터                       |
| `bls-latest`                                                        | BLS                     | 15분              | 공식 공개 메타데이터                       |
| `eia-today`, `eia-press`                                            | EIA                     | 15분              | 공식 공개 메타데이터                       |
| `nvidia-ir-press`, `broadcom-ir-news`, `palo-alto-networks-ir-news` | NVDA·AVGO·PANW 공식 IR  | 승인 후 기존 15분 | 현재 비활성·UNKNOWN; 관리자 개인 화면 대상 |
| `hankyung-finance-rss`                                              | 한국경제 증권           | 승인 후 기존 15분 | 현재 비활성·UNKNOWN; 국내 언론 metadata    |

RSS 요청만 수행하고 기사 URL을 서버에서 요청하지 않습니다. RSS `description`·Atom `summary`의 제공 요약을 정화해 저장합니다. `content:encoded` 등 임베디드 본문은 추출·저장하지 않습니다. 제공 요약이 없으면 빈 상태를 유지하며 제목이나 본문으로 요약을 만들지 않습니다.

`source_items`와 `news_items`는 원제목·제공 요약·원문 URL·GUID·작성자·원래 발행 문자열·발행 시각·최초 관측 시각·권리를 보존합니다. 원래 등록 소스의 권리 스냅샷은 바꾸지 않으며 메타데이터 저장과 표시가 허용되는 후보만 저장합니다. 네이버 검색 결과도 기존 테이블에 메타데이터로 저장하며, 원응답 필드는 `raw_metadata_json.providerOriginal`에 별도로 보존합니다. 신규 수집은 `news_article_contents`를 읽거나 쓰지 않습니다.

Samsung Global의 KST 시각 규칙과 원본 문자열을 유지합니다. 다른 소스는 명시된 UTC 오프셋을 존중합니다. EIA XML의 ISO-8859-1 선언과 상대 기사 링크를 처리하며 EST를 임의로 EDT로 바꾸지 않습니다. 피드 요청의 크기·XML 구조·DNS·HTTPS·리디렉션 제한은 유지합니다.

RSS·Atom의 실제 발행 시각과 수정 시각을 구분합니다. Atom에 `updated`만 있으면 그것을 `publishedAt`으로 바꾸지 않습니다. publishedAt·provider updatedAt·firstObservedAt·collectedAt의 역할을 구분하고 원래 timestamp 문자열을 보존합니다. `collectedAt`은 수집 시도별 시각이며 최초 관측을 덮어쓰지 않습니다.

소스 권리 기준은 등록 정책에 기록합니다. 기존 참고 문서는 [Samsung 이용약관](https://news.samsung.com/global/terms), [Fed 저작권](https://www.federalreserve.gov/disclaimer.htm), [BLS 저작권](https://www.bls.gov/opub/copyright-information.htm), [EIA 재사용 정책](https://www.eia.gov/about/copyrights_reuse.php)입니다.

## 네이버 검색

기업과 주제 검색은 교대로 순환하며 전체 15분당 최대 10회와 기존 무료 호출 한도를 공유합니다. 국내 주제는 `국내 증시`, `한국은행 기준금리`, `원달러 환율`, 미국 주제는 `미국 증시`, `미국 연준 금리`, `미국 경제`입니다. 자산 뉴스 API의 `asset=gold|silver|wti|btc|eth`는 각각 `국제 금값`, `국제 은값`, `WTI 유가`, `비트코인`, `이더리움` 검색 결과를 사용합니다.

무료 조건 확인 시각은 `NAVER_NEWS_FREE_VERIFIED_AT`, 유효 기한은 `NAVER_NEWS_FREE_UNTIL`에 UTC 시각으로 기록합니다. 확인 기간은 최대 30일이며 월이 바뀌어도 이 기간과 일·월 한도 안에서는 허용합니다. 만료 7일 전 경고와 만료 사유를 표시하고, 기한이 끝나면 조건을 다시 확인할 때까지 중단합니다. 새 확인 시각이 없는 기존 설정은 기존 월별 승인 조건을 유지합니다.

정기·기업 상세·수동 검색의 모든 공급자 호출은 공통 `source_checkpoints` 예산 잠금에서 최근 15분의 예약을 확인합니다. 이 잠금은 API 재시작과 월 경계에도 같으며, JSON에는 최대 10개의 UTC 예약 시각만 남깁니다. 실패한 호출도 예약과 일·월 사용량에 포함합니다. 한도가 차면 상태 응답에 다음 요청 가능 시각을 표시합니다. 기존 버전에서 전환할 때 개별 예약 이력이 없으면 마지막 호출로부터 15분이 지날 때까지 보수적으로 기다립니다. 검색어·기사·인증 값은 예산 기록에 저장하지 않습니다.

네이버 경제탭의 편집 순위나 주요 기사 목록을 그대로 가져오는 기능은 아닙니다. [뉴스 검색 API](https://developers.naver.com/docs/serviceapi/search/news/news.md)의 키워드 검색 결과를 사용합니다.

승인 개인 그룹과 국내·미국 월간 시총 상위 20개 기업을 정기 대상으로 사용하고, 공유방에만 등록된 기업은 넣지 않습니다. 월간 대표 종목의 검증된 보통주 클래스도 같은 범위로 확인합니다. 기업 상세 요청은 등록된 기업명만 사용합니다. 유효한 메모리 결과와 같은 대상의 진행 중 요청은 재사용하고 실패 뒤 기존 대기 시간을 유지합니다. 키·무료 이용 기한·일간/월간 잔량을 확인할 수 없으면 해당 검색만 중단합니다.

사용자 설정에 따라 제목·제공 요약·원문 링크·네이버 링크·원래 발행 문자열을 `source_items`와 `news_items`에 저장합니다. 발행 시각과 최초 관측은 UTC로 보존하며 재수집해도 최초 관측은 바꾸지 않습니다. 기존 `news_articles`와 `news_source_companies`를 재사용해 기사 중복과 관련 종목을 관리하므로 신규 테이블이나 마이그레이션은 필요하지 않습니다. 검색어·인증 값·기사 전문을 저장하지 않고 기사 URL을 요청하지 않습니다. `naver-news-metadata-v1` 정책은 기존 `LINK_ONLY` 권리 모드를 유지하며 관리자·회원 개인 화면에만 저장 메타데이터 표시를 허용합니다. AI·번역·전문·알림·저장 기사 봇/공유방 배포는 허용하지 않습니다. 정책 없는 과거 NAVER 행과 다른 소스의 권한은 그대로 제한됩니다. 무료 조건 만료나 키 누락은 새 수집을 중지하며, 이미 저장한 기사는 현재 등록 정책과 행별 권한이 유효한 동안 조회할 수 있습니다. 기존 봇의 명시적 조회는 제한된 현재 메모리만 읽는 동작을 유지합니다. 일반 메모리 TTL은 15분, 정기 결과는 최대 24시간이고 저장 기사의 보존 기간과는 별개입니다. 응답은 `private, no-store`를 사용합니다.

네이버 원제목과 원래 강조 문자열은 원응답 필드에 보존하고 표시용 메타데이터에서는 강조 태그와 엔터티를 정리합니다. HTML은 실행하지 않습니다. 관심 종목·최근 조회·뉴스 메뉴 모두 회사 뉴스와 네이버 뉴스를 발행 시각 기준 최신순으로 함께 표시하며 같은 기사는 한 번만 표시합니다. 발행 시각이 없으면 최초 관측 시각을 사용합니다. 원문과 네이버 링크를 보존하고 종목 배지는 제목·제공 요약에 확인한 관련성이 있는 경우에만 표시합니다.

## 목록·종목 연결·원문 이동

목록은 제목·출처·KST 발행 날짜와 관련 종목을 표시합니다. 화면 폭을 넘는 종목은 +N으로 묶습니다. 제목을 누르면 팝업에서 제목과 제공 요약을 읽고 하단의 자세히 보기로 원문을 새 탭에서 엽니다. 기업발표·글로벌·자동 번역은 팝업 안에서 배지로 표시하며 이미지는 표시하지 않습니다. 요약이 없으면 `요약 미제공`입니다. 서버의 `summaryAllowed`는 실제 권한 검증을 통과한 제공 요약이 있을 때만 true입니다. 유효한 제목·요약 번역이 없으면 원문 메타데이터와 번역 상태를 사용합니다.

관련 종목은 기존 SEC CIK·등록 IR 관계와 제목·제공 요약의 명확한 기업명 증거를 사용합니다. 네이버 호환 응답의 관련성 판정은 현재 상장 여부·지원 거래소·유효 종목 코드를 확인한 등록 기업명과 명시적 심볼만 인정하며, 검수 여부가 없는 임의 별칭은 사용하지 않습니다. 영문 약어 `(DX)`만으로는 연결하지 않고 `$DX`, `NYSE:DX` 또는 기업명을 요구합니다. 한국 종목 코드 `(005930)`은 사용할 수 있습니다. 검색 대상 기업이라는 이유만으로 종목 관련성을 부여하지 않습니다. 기존 저장 관계는 유지하되 화면에서 `OTHER`·유효 종목 식별자가 없는 배지는 제외합니다. 저장된 뉴스의 제목 오른쪽 종목 배지는 기사 링크와 분리해 종목 페이지로 이동합니다.

NEW/NICE처럼 일반 단어와 충돌하는 별칭은 이름 단독으로 연결하지 않습니다. 정식 회사명이나 올바른 거래소·종목코드 표기 등 명확한 근거를 요구하며, 검색어도 가능한 정식 회사명을 사용합니다. 잘못된 거래소 조합인 `NASDAQ:160550`은 NEW의 근거로 인정하지 않습니다. matcher 버전은 2이며 과거 자동 연결 정리는 기본 dry-run인 `news-repair`로 범위를 지정합니다. 적용·복구와 보존 범위는 [2026-09-24 복구 기록](NEWS_RECOVERY_2026-09-24.md)을 참고하세요.

통합 뉴스 API의 `items`에는 권한·검색·종목·주제 조건을 적용한 저장 기사를 하나의 DB 커서로 반환합니다. `providerGroups`와 `providerResultSets`는 호환용 빈 배열이며 원응답을 목록에 추가하지 않습니다. 종목 열람 시 새 검색이 발생하면 저장이 끝난 뒤 목록을 조회합니다. 상단 새로고침은 현재 필터의 저장 기사를 마지막 커서까지 가져오고 외부 API 한도를 우회하지 않습니다. 뉴스 검색은 메타데이터를 사용하며 본문 또는 본문 번역 존재를 요구하지 않습니다.

## 설정과 정리

```dotenv
NEWS_RSS_FEEDS=fed-press,fed-speeches,bls-latest,eia-today,eia-press
IR_FEED_URLS=https://news.samsung.com/global/feed
NEWS_TRANSLATION_ENABLED=true
GDELT_ENABLED=false
```

NAVER 공급자는 `NAVER_API_PROVIDER=developers|ncloud`로 명시합니다. 인증 실패 시 다른 공급자 주소로 키를 보내지 않습니다. 무료 조건은 `NAVER_NEWS_FREE_MONTH`, `NAVER_NEWS_FREE_REQUESTS`, `NAVER_NEWS_FREE_UNTIL`과 일간 한도로 확인합니다. 세부 운영 설정은 [소스](SOURCES.md), [운영](OPERATIONS.md#naver-news-authentication)을 참고합니다.

기존 뉴스 본문·본문 번역·수정 이력의 본문 사본 정리는 [번역 문서의 배포 순서](NEWS_TRANSLATION.md#기존-본문-정리와-배포-순서)를 따릅니다. 운영 DB와 앱 캐시만 정리하며 과거 백업·공시 원본은 유지합니다. 운영 적용 완료 여부는 실제 배포 기록에서 확인합니다.

## 2026-09-07 조건부 API 확장

Marketaux·Alpha Vantage·Finnhub는 기존 `MARKET_NEWS` 큐의 `DISCOVER_LINKS` 작업에 추가했습니다. provider별로 별도 queue·scheduler service·뉴스 table을 만들지 않습니다. 기존 NAVER·SEC·GDELT·Alpaca 작업의 대상이나 가격 공급자를 변경하지 않습니다. 신규 API의 대상은 관리자 개인 관심종목을 우선하고 미국 월간 대표 종목으로 보완합니다. 한 provider의 전체 범위를 한 번 전달하고 어댑터가 순환 위치와 실행 예산을 관리합니다.

| Provider     | 기존 scheduler에 추가한 KST 일정 | 실행당 상한 | Orsem 최근 24시간 예산 | 요청 단위                                                            |
| ------------ | -------------------------------- | ----------- | ---------------------- | -------------------------------------------------------------------- |
| MARKETAUX    | 매시간 정각                      | 2요청       | 50요청                 | 최대 25종목씩 묶고 무료 limit=3; 승인된 정확한 출판사 domains만 조회 |
| ALPHAVANTAGE | 00:00·12:00                      | 10요청      | 20요청                 | 미국 ticker 하나씩; LOW_FREQUENCY_SUPPLEMENTAL                       |
| FINNHUB      | 매시간 정각                      | 5요청       | 120요청                | 미국 ticker 하나씩; Company News만 사용                              |

예산은 provider의 무료 한도와 별개인 Orsem의 보수적인 상한입니다. `.env.example`에서 낮출 수 있지만 위 기본값을 넘길 수 없습니다. Finnhub는 승인 registry에 실제 계정의 분당 제한을 기록하지 않으면 동작하지 않습니다. [2026-09-07 공급자 비교](NEWS_PROVIDER_COMPARISON.md)는 조사 근거이며 활성화 전 실제 계정의 현재 한도·권리를 다시 확인합니다.

모든 신규 env 플래그는 false입니다. 키와 enabled만으로 호출할 수 없습니다. contracts의 현재 provider 정책, 계정 News entitlement, 무료 확인 만료일, 정확한 publisher의 metadata 보관·개인 표시 정책이 모두 있어야 합니다. `APPROVED_FREE_NEWS_ACCESS`는 현재 provider별 null이고 정책은 UNKNOWN입니다. 권리나 실제 응답을 확인하기 전 운영 활성화를 하지 않습니다.

### 예산·복구·장애

- HTTP 전에 기존 source_checkpoints의 provider별 `NEWS_API_BUDGET` 행을 잠그고 UTC 요청 시각을 예약합니다. 같은 transaction에서 api_usage_counters를 올립니다. 실패·페이지 요청도 차감하며 재시작·KST/UTC 자정·월 변경으로 최근 24시간 예산이 초기화되지 않습니다.
- dailyRequestBudget·rollingRequestBudget·rollingRequestCount·retryAt·lastError를 예산 상태에 기록합니다. UTC 일별 통계와 최근 24시간 허용량은 서로 다른 지표입니다. provider의 reset 시각을 추측하지 않습니다.
- 성공한 항목을 기존 pipeline으로 저장한 뒤 `NEWS:<종목 묶음 해시>` 페이지 checkpoint를 확정합니다. `NEWS_ROTATION`은 다음 ticker를 보존합니다. 저장 실패는 다음 실행에서 안전하게 재처리하고 provider provenance를 유지합니다.
- 초기 조회는 최근 24시간, 이후 마지막 완료 window에서 10분 overlap을 적용합니다. Marketaux는 고정 window와 page를 이어가며 page 반복·형식 오류를 거절합니다. 한 실행 2요청, 복구 100페이지의 앱 안전 상한을 넘으면 검토가 필요하며 완료 cursor를 앞당기지 않습니다.
- Alpha Vantage는 limit=1000, Finnhub는 응답 항목 1000개의 앱 안전 상한에서 incomplete로 남깁니다. 문서에 없는 pagination을 추가하지 않으며 해당 상황을 완전 수집으로 보고하지 않습니다.
- 401 인증, 403 entitlement, 429 rate limit, 5xx 장애, timeout, malformed, pagination 실패를 분리합니다. Marketaux 402는 일일 한도로 별도 처리합니다. Alpha Vantage 200 Information/Note는 보수적인 한도 대기, Error Message는 권한·요청 확인 대상으로 처리합니다. 메시지 본문과 API 키를 오류에 포함하지 않습니다.
- 인증·entitlement·일일 한도 오류는 24시간, 429는 Retry-After 또는 최소 1분, 기타 요청 오류는 5분의 보수적인 대기를 저장합니다. 대기 중 실패 요청을 다른 공급자로 대체하지 않습니다. 다음 정기 일정에서 자신의 source만 재시도합니다.

### 저장·회사 연결·중복 제거

API candidate는 provider ID, 제목, 출처, original URL, 발행·관측 시각, entity, 허용된 provider metadata와 권리 스냅샷만 포함합니다. summary는 provider와 publisher의 summaryStorageAllowed가 둘 다 true인 경우에만 저장합니다. 본문·이미지·highlights는 candidate·raw hash·raw metadata·로그에 포함하지 않습니다. Alpha Vantage sentiment는 제공자가 계산한 미검증 metadata이고 공식 사실·매수매도 판단으로 사용하지 않습니다.

회사 식별자는 기존 UUID를 유지합니다. Marketaux의 KOSPI `.KS`·KOSDAQ `.KQ`는 기존 master의 시장을 확인한 경우에만 구성합니다. 미국 ticker 역시 기존 master에 연결합니다. 매핑 실패·모호한 entity는 `UNRESOLVED_ENTITY` 검토 대상이며 새 회사를 자동 생성하지 않습니다. Finnhub Company News의 단일 요청 기업은 `requestedSymbol`로 출처를 남기고, 일반 검색 대상이라는 이유로 다른 API 결과에 회사를 덧붙이지 않습니다.

canonical URL을 우선해 기존 news_articles에 연결합니다. 다른 URL의 제목 해시 병합은 같은 원출판사·관련 기업·24시간 이내 발행 조건을 함께 확인합니다. 숫자·부호를 보존하고 제목의 유사성만으로 서로 다른 사건을 자동 병합하지 않습니다. provider별 source_items와 원래 권리 스냅샷은 별개로 유지하며, 발견 경로 수인 providerCount와 독립 원출판사 수인 independentSourceCount를 구분합니다. 보도자료·기업 발표·출처를 확인하지 못한 전재를 독립 검증 건수에 넣지 않습니다.

### 공식 자료와 표시

뉴스는 후보 발견용입니다. 기존 DART 접수번호·SEC accession·공식 URL이 명시된 경우 저장된 공식 자료를 연결하고, 같은 회사·발행 전후 3일의 자료는 관련 후보로 제시합니다. 회사와 날짜만으로 주장·실적 수치·계약 금액을 공식 사실로 승격하지 않습니다. 기존 검토함에서 근거와 대상 자료를 확인하며 자동 공식 자료 연결과 관리자 확인을 구분합니다. 수동 연결은 재수집으로 삭제하지 않습니다.

기존 카드에 제목·관련 종목·출처 종류·KST 발행 시각·원문 링크·공식 근거 상태를 표시합니다. source kind는 공식·기업발표·보도자료·언론·집계API를 구분합니다. 승인된 API publisher가 PRESS_RELEASE라면 집계 경로를 보존하면서 카드도 보도자료로 표시합니다.

신규 개인 이용 정책은 서버 세션의 관리자 권한을 기준으로 조회합니다. 같은 canonical 그룹에 공개 기사와 개인 전용 기사가 섞여 있어도 회원·공유방·봇의 결과·출처 건수·관련 종목·정렬·cursor에 개인 전용 metadata가 섞이지 않아야 합니다. 신규 소스 알림은 꺼 두며 AI·번역 권리가 없으면 해당 queue에 넣지 않습니다. 기존 관리자 source 화면에서 enabled·성공·오류·다음 실행·예산·cursor·권리·entitlement를 확인하고 비밀 값은 반환하지 않습니다.

## 신규 RSS의 안전성과 승인

등록된 미국 IR은 `nvidia-ir-press`, `broadcom-ir-news`, `palo-alto-networks-ir-news`이며 국내 추가 목록은 `hankyung-finance-rss` 하나입니다. [정확한 URL·공식 근거·보류 사유](NEWS_PROVIDER_COMPARISON.md#p2p3-공식-rss-조사)를 확인합니다. 프로필의 정확한 HTTPS URL·allowedHosts·source kind·rights policy·enabled 값을 함께 검증합니다. env에 주소를 넣는 것만으로 비활성 프로필의 요청을 허용하지 않습니다.

기존 bounded parser와 DNS 검사·IP 고정·redirect 거절을 사용합니다. XML entity/DTD, XML 구조 복잡도, feed 크기·항목 수·제목·설명 길이, malformed XML을 제한합니다. RSS 응답의 content-type을 확인하고 압축은 identity만 요청·허용하므로 예상하지 않은 압축 응답을 거절합니다. 내부 IP·localhost·DNS 변경·host 변경을 우회하지 않습니다. RSS 2.0 description과 Atom summary만 권리에 따라 처리하고 content:encoded 또는 기사 HTML을 대체 수집하지 않습니다.

MSFT·AMZN·Alphabet·ETN은 조사 범위에서 `NO_OFFICIAL_RSS_FOUND`로 기록했고 임의 URL을 만들지 않았습니다. GlobeNewswire·Business Wire·한국경제TV는 공식 feed 및 권리 미확인 사항을 문서로 남겼습니다. HTML scraping·인증 우회·robots 우회·범용 RSS proxy를 추가하지 않습니다.
