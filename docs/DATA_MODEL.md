# 데이터 구조와 보존

MySQL의 스키마는 마이그레이션으로 관리하며 TypeORM `synchronize=false`를 유지합니다. 실제 API 키·공시 원문·운영 백업은 저장소 밖에 둡니다. 운영은 테스트 데이터를 자동 생성하지 않습니다.

| 영역            | 저장 구조                                                                  | 기준                                                                         |
| --------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 기업 식별       | `companies`, `company_aliases`, `alpaca_assets`                            | UUID를 내부 키로 사용, 원출처 심볼·거래소·과거 공급자 ID 보존                |
| 공시와 분석     | `filings`, 이벤트·거래 및 근거 테이블                                      | D001–D005를 각각 구분, 원본 사실·정정 관계·파서 버전 보존                    |
| 시세            | `price_bars`, 실시간 Redis 캐시                                            | 공급자·통화·봉 주기·거래일·관측 시각·권리 유지                               |
| 시장 선정       | `market_cap_snapshots`, `market_cap_memberships`, `market_selection_state` | 검증된 스냅샷만 활성화, 실패 시 마지막 정상 목록 유지                        |
| 기업정보        | `company_information_snapshots`                                            | 필드별 값·단위·보고기간·출처·관측 시각 보존                                  |
| 개인·공유 그룹  | `watchlist_groups`, `watchlist_group_items`, 공유방·멤버십                 | 개인 owner와 room 범위를 분리, 수정 revision 검사                            |
| 뉴스 메타데이터 | `source_items`, `news_items`, `news_articles`, `news_source_companies`     | 제목·허용된 제공 요약·번역·권리·발행일·최초 관측 시각을 구분; 본문 없음      |
| 네이버 뉴스     | 기존 `source_items`·`news_items`·`news_articles`와 임시 조회 메모리        | 원응답 필드·발행/관측 시각을 보존해 개인 화면에 표시; AI·번역·자동 알림 제외 |

날짜만 제공되는 거래일·접수일은 date로 보존하며 임의의 자정 시각으로 바꾸지 않습니다. 실제 instant는 UTC로 저장하고 화면에서 KST로 표시합니다.

국내 기업 목록은 OpenDART 고유번호 자료를 매주 일요일 03:30 KST에 동기화합니다. 법인 코드와 국내 종목 코드로 기존 기업을 갱신하며 UUID와 공시·관심그룹 연결을 유지합니다. 국내 주식과 미국 ADR은 거래소·종목 식별자가 다른 별도 항목입니다.

종목 목록 시세는 일괄 조회합니다. 동일 거래일의 여러 일봉은 관측된 최신 봉 하나를 선택하고 진행 중인 거래일은 종가 비교에서 제외합니다. 시총은 가격 유무와 독립적으로 확인된 값만 반환합니다. 52주 범위는 충분한 실제 거래일 이력이 확보된 경우에만 제공합니다.

국내·미국 각각 20개 대표 종목은 토스증권의 전체 활성 종목·발행주식수·최종 거래가를 검증해 매월 선정합니다. ETF·우선주·ADR을 제외하며 같은 기업의 확인된 보통주 클래스는 합산합니다. 원본 자료·정밀 계산·제외 근거·클래스의 확인된 회사 ID를 스냅샷에 보존합니다. 계산과 갱신 조건은 [월간 시장 목록](MONTHLY_MARKET_LEADERS.md)을 따릅니다.

`market_leader_watchlist`는 활성 월간 목록의 대표 40개를 읽는 뷰입니다. `market_leader_company_links`는 뉴스·알림 범위를 검증된 주식 클래스까지 연결하며, 같은 시점의 대표 ID·종목 코드·지역·상장 상태를 검사합니다. 기존 `watchlist_items`의 수동 P1/P2 행은 이력으로 보존하지만 수집·알림에는 사용하지 않고 편집 API는 종료합니다. 개인·공유 그룹의 내용과 권한은 유지합니다.

중복 뉴스는 URL 기준으로 표시를 합쳐도 원본 출처·권리를 덮어쓰지 않습니다. 네이버의 임시 조회 메모리는 만료되지만 허용된 저장 메타데이터의 보존과 DB 커서는 별도로 관리합니다. 개인 뉴스·공시 조회는 로그인 세션의 개인 그룹 합집합만 읽습니다. 공급자 장애·인증 누락은 해당 연결만 중단시킵니다.

## 조건부 뉴스 metadata v2

신규 provider는 기존 `source_items`/`news_items`에 저장한다. 공급자 article ID가 없으면 canonical URL 해시를 내부 외부키로 사용하되 `providerArticleId: null`을 보존한다. 원출판사, provider 심볼, UTC `publishedAt`, 공급자 원래 시각 문자열, `providerUpdatedAt`, 최초 `firstObservedAt`, 매 수집 `collectedAt`을 구별한다. updated 시각을 published 시각으로 대체하지 않는다. 원문 HTML·본문·이미지를 저장할 새 경로는 없다.

`sourcePolicyJson`에는 version 2 정책 ID·권리 상태·독자 범위와 저장 당시 권리 사본을 남긴다. `rawMetadataJson`의 공급자·publisher 정책 사본은 provenance이며 현재 승인 상태를 대체하지 못한다. 요약은 명시적 저장 허용이 있을 때만 `news_items.description`에 쓴다. 금액·sentiment 등 제공 metadata를 공식 공시의 수치로 복사하지 않는다.

`AddNewsTitleHash1788413000000`은 `source_items.normalized_title_hash CHAR(64) NULL`와 발행 시각 복합 비고유 인덱스를 추가한다. canonical URL을 먼저 재사용하며 URL이 다른 신규 행은 정규화된 제목이 정확히 같고 같은 원출처·회사·24시간 범위일 때만 기존 기사에 연결한다. 숫자·부호가 다른 제목과 단순 유사 제목은 자동 병합하지 않는다. 기존 그룹은 이동/삭제하지 않고 다음 수집 때 제목 해시만 채운다. 회사 행 잠금으로 동시 수집을 직렬화한다.

기업은 기존 UUID를 사용한다. 공급자의 `NVDA`는 기존 미국 상장 company ID와 진단용 `US:NVDA`로, `005930.KS`는 기존 KOSPI 회사와 `KR:005930`으로 해석한다. 새 company master를 만들지 않는다. 미등록·모호·시장 상충 심볼은 `unresolvedEntities`와 `reviews`의 `SOURCE_ITEM/NEWS_ENTITY`로 남긴다. 관리자의 `manualCompanyIds`와 `MANUAL_REVIEW` 관계는 재수집으로 지우지 않는다.

공식 교차확인은 기존 filings·공식 source_items에 대한 `officialReferences` JSON으로 저장한다. `EXPLICIT_ID | EXPLICIT_URL | COMPANY_TIME` 방식, 원본/대상 해시, `RELATED | CONFIRMED | REJECTED`, 관리자·검토 시각을 보존한다. 자동 후보는 ±3일/최대 10개이며 DART 날짜는 KST로 비교한다. `reviews`의 `SOURCE_ITEM/NEWS_OFFICIAL_LINK`에서 관련성을 수동 확인하고 원본/대상 변경 시 확인을 해제한다. 새로운 EventCluster·분류 등급·투자 신호는 만들지 않는다.

예산·cursor·회복 구간은 기존 `source_checkpoints`, 요청 수는 `api_usage_counters`, 상태는 `connector_health`에 저장한다. 새 provider 전용 테이블은 없다.
