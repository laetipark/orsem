# 미국 종목 뉴스 공급자 비교 — 2026-09-06

Orsem은 SEC 공식 공시 + 승인된 GDELT publisher의 글로벌 메타데이터를 유지한다. 미국 종목 뉴스 보완 후보는 **Alpaca News 우선 기술 검증, Marketaux 차선, GNews 범용 검색 보완**이다. 어느 공급자도 실제 계정의 무료 자격·기사 권리·공유 계약까지 이번에 확인한 것은 아니다. 유료 구독이나 실제 뉴스 요청을 새로 실행하지 않았다.

## API 기능

| 항목          | Alpaca News                                                            | Marketaux                                                | GNews                                                             |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| Endpoint      | `GET https://data.alpaca.markets/v1beta1/news`                         | `GET https://api.marketaux.com/v1/news/all`              | `GET https://gnews.io/api/v4/search`, `/top-headlines`            |
| 인증          | APCA-API-KEY-ID / APCA-API-SECRET-KEY 헤더                             | api_token 쿼리                                           | apikey 쿼리                                                       |
| 종목 연결     | symbols, 응답 symbols 배열                                             | symbols·entity·exchange·industry 필터와 entities 배열    | q 키워드 검색; 종목 마스터 기반 ticker/entity API는 확인되지 않음 |
| 시간 범위     | start/end RFC3339; asc/desc는 updated date 기준                        | published_after/before/on, UTC                           | from/to, publishedAt 정렬                                         |
| 페이징        | limit 1–50, next_page_token → page_token                               | page/limit, 요금제별 반환 수                             | page/max, 요금제별 반환 수                                        |
| 제목·URL·출처 | headline, url, source                                                  | title, url, source                                       | title, url, source                                                |
| 시각          | created_at, updated_at. publisher가 별도로 발표한 시각과 혼동하지 않음 | published_at, 명시 update 시각은 미확인                  | publishedAt, 명시 update 시각은 미확인                            |
| 요약·본문     | summary 및 선택 content(HTML 가능)                                     | description/snippet; 전문 미제공                         | description/content; 유료 요금제 full content 안내                |
| 실시간성      | 계정 feed 권한에 따라 실시간 또는 15분 지연                            | 가격표 instant access; 완전성/SLA 보장으로 해석하지 않음 | 무료 12시간 지연, 유료 실시간 제공 안내                           |
| 과거 범위     | 문서상 2015년부터; 계정 실제 범위 미검증                               | 실제 계정·계약 확인 필요                                 | 무료 30일, 유료 2020년부터                                        |
| WebSocket     | `/v1beta1/news` 공식 지원; 이번에는 REST만 연결                        | 공식 조사 범위에서 미확인                                | 공식 조사 범위에서 미확인                                         |

근거: [Alpaca REST](https://docs.alpaca.markets/us/reference/news-3), [역사 데이터](https://docs.alpaca.markets/us/docs/historical-news-data), [뉴스 스트림](https://docs.alpaca.markets/us/docs/streaming-real-time-news), [Marketaux 문서](https://www.marketaux.com/documentation), [Marketaux FAQ](https://www.marketaux.com/faq), [GNews 검색](https://docs.gnews.io/endpoints/search-endpoint).

## 비용·권리

| 항목                  | Alpaca News                                                                                             | Marketaux                                                                      | GNews                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 무료/유료             | 현재 계정 News entitlement·무료량·추가 과금 조건 UNKNOWN. 자산 API 키가 있다는 사실만으로 승인하지 않음 | Free $0, 일 100요청·요청당 3기사. Basic 월 $29·일 2,500요청·20기사             | Free 일 100요청·10기사. Essential 월 €49.99·일 1,000요청·25기사                |
| Rate limit            | API 429 및 X-RateLimit 헤더; 계정 News 고유 상한 미검증                                                 | 일 요청 한도는 요금제 기준; 초당 상한 미확인                                   | 일 한도 소진 403, UTC 자정 리셋; 분당 상한은 계정 확인                         |
| DB 장기 저장          | UNKNOWN / REQUIRES CONTRACT REVIEW                                                                      | API UUID 재조회 안내는 있으나 장기 기사 메타데이터 저장 권리 범위 UNKNOWN      | 합리적 캐시는 허용, 대량 DB로 재배포·경쟁 서비스·제한 회피 목적은 금지         |
| 캐시                  | 보관 기간·허용 범위 UNKNOWN                                                                             | 보관 기간·허용 범위 UNKNOWN                                                    | 성능용 합리적 캐시 허용, 고정 TTL 계약값은 미확인                              |
| AI 요약·학습          | 문서의 감성 분석·학습 활용 예시는 존재. 실제 계정·publisher 계약 권리는 별도 검토                       | UNKNOWN                                                                        | UNKNOWN; API 접근 권리가 publisher의 AI 이용권을 대신하지 않음                 |
| 승인 회원 공유·재배포 | 일반 지원 FAQ는 재배포 불가. Broker 사용 사례 안내와 계정 계약을 구분해야 함                            | 일반 약관 개인 비상업 이용·승인된 상업 이용 외 제한. API별 권리 계약 확인 필요 | 요금제에 따른 상업 API 데이터 사용 허용. 제3자 권리 존중, API 접근 재판매 금지 |
| 상업 서비스           | REQUIRES CONTRACT REVIEW                                                                                | REQUIRES CONTRACT REVIEW                                                       | 유료 요금제 지원, publisher 권리는 별도                                        |
| Orsem 결정            | 어댑터 구현, 기본 비활성·승인 레지스트리 null                                                           | 비교 문서만; 구현·활성화 보류                                                  | 비교 문서만; ticker 정밀성·무료 지연 때문에 후순위                             |

가격은 USD/EUR 월 결제 기준, 세금 제외다. [Marketaux 가격](https://www.marketaux.com/pricing), [GNews 가격](https://gnews.io/pricing)을 확인했다. GNews 무료 요금제 설명과 FAQ는 개발·시험 및 비상업 용도를 언급하지만 Orsem 공유 서비스의 모든 이용 범위를 승인한 것으로 해석하지 않는다.

권리 근거: [Alpaca 재배포 FAQ](https://alpaca.markets/support/redistribute-alpaca-api), [Marketaux 약관](https://www.marketaux.com/tos), [GNews 약관](https://gnews.io/legal/terms-of-service). GNews는 서비스 종료 시 다운로드 자료 폐기 조건도 명시한다. 웹사이트 일반 약관과 API 계약이 다를 수 있어 실제 계약 확인 없이 보관·공유·AI 권리를 TRUE로 바꾸지 않는다.

## 구현한 Alpaca 경계

`ALPACA_NEWS_ENABLED=false`가 기본이다. 기존 `ALPACA_API_KEY/ALPACA_API_SECRET`을 재사용하되 `APPROVED_ALPACA_NEWS`에 News entitlement, 무료 사용 확인 기한, 정확한 publisher source/domain별 권리 근거가 모두 있어야 요청한다. 레지스트리는 null이며 실제 publisher 승인을 만들어 넣지 않았다. 토스 가격과 Alpaca 자산 식별 경로는 변경하지 않았다.

허용된 경우 관심 미국 종목의 symbols로 30분마다 조회한다. 현재 구현은 16분 지연 horizon, 초기 24시간, 이후 10분 overlap, 한 실행 최대 4페이지다. 페이지별 항목 저장 후 token/window 체크포인트를 확정한다. include_content=false이며 응답에 content·summary가 와도 저장하지 않는다. publisher 미승인·URL host 불일치 결과는 버린다. 공시로 위장하지 않고 INDEPENDENT_MEDIA/STORE_METADATA_ONLY로 분류하며 AI·알림은 끈다.

401/403/429·페이지 오류는 기존 운영 실패 경로로 보고하며 다른 공급자로 전환하지 않는다. 호출·과금 권한이 확인되지 않아 실서버 테스트는 하지 않았다. News API 제공 가능성이 확인된 것과 현재 계정으로 무료 운영이 검증된 것은 구분한다.
