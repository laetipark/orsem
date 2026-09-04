# 주식시장 뉴스 API·RSS 조사

- 조사 기준: 2026-09-04 KST. 국내 주식 중심, 미국·글로벌 시장 보완.
- 확인 방식: 공급자 공식 문서·약관, 일부 공개 RSS의 일회성 HTTP/XML 확인, Orsem 기존 코드 점검.
- 이 문서는 최초 조사와 설계 제안이다. 이후 실제 정기 수집·미국 종목 한글명 반영 내용은 [운영 구성](NEWS_COLLECTION_AND_KOREAN_NAMES.md)을 참고한다. 아래 후보 전체를 운영에 등록한 것은 아니다.

## 1. 권장 방향

**국내 뉴스는 언론사 공식 RSS와 직접 공급 계약을 중심으로 검토하고, 네이버는 독립적인 검색결과 표시 기능으로 분리하는 것이 적합하다.**
RSS가 열려 있다는 사실은 영구 저장·본문 수집·상업 재배포·AI 처리 권리를 뜻하지 않는다. 연결 가능성과 이용 권리를 따로 확인해야 한다.

| 목적                              | 우선 검토                                     | 판단                                                          |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| 국내 시장 헤드라인 확인           | 매일경제 증권, 이투데이 마켓, 뉴시스 금융 RSS | 실제 XML 응답 확인. 운영·공개 이용 범위는 각 매체 조건 확인   |
| 국내 전문 뉴스의 상업 서비스 제공 | 연합인포맥스 등 직접 데이터피드 계약          | 본문·메타데이터·보관·재배포·AI 이용 권한을 계약에 명시        |
| 네이버 관련 기사 검색             | NAVER API HUB의 독립 검색 표시                | 9월 개정 약관상 통합 뉴스 DB·AI 요약 수집원으로 추천하지 않음 |
| 미국 주식 개인 실험               | Finnhub, Alpha Vantage                        | 무료 범위가 있으나 개인용 약관과 호출량 제한 적용             |
| 미국 전문 뉴스 상용 제공          | Benzinga 직접 계약 또는 Massive Business      | 실시간 전문 뉴스·종목 태깅·본문 권한을 계약별 확인            |

## 2. 네이버: 기술적 연결과 이용 목적을 함께 구분

### 신규 연결은 NAVER API HUB

기존 Developers는 이관 대상 API의 신규 신청을 2026-07-31부터 중단했다. 기존 이용자 유예는 2027-06-30까지이며 2027-07-01 종료된다. [공식 이관 공지](https://developers.naver.com/notice/article/32973), [현행 약관 부칙](https://developers.naver.com/products/intro/terms/terms.md)
API HUB로 이전할 때는 새 Application의 Client ID/Secret이 필요하다. 기존 Developers 인증정보를 그대로 사용할 수 없다. [공식 이관 가이드](https://guide.ncloud-docs.com/docs/apihub-migration)

| 항목          | NAVER API HUB                                             | 기존 Developers                                     |
| ------------- | --------------------------------------------------------- | --------------------------------------------------- |
| 뉴스 endpoint | `GET https://naverapihub.apigw.ntruss.com/search/v1/news` | `GET https://openapi.naver.com/v1/search/news.json` |
| ID 헤더       | `X-NCP-APIGW-API-KEY-ID`                                  | `X-Naver-Client-Id`                                 |
| Secret 헤더   | `X-NCP-APIGW-API-KEY`                                     | `X-Naver-Client-Secret`                             |
| 응답 선택     | `format=json` 또는 `xml`                                  | URL의 `.json` 또는 `.xml`                           |

근거: [API HUB 공통 인증](https://api.ncloud-docs.com/docs/naver-api-hub-overview), [API HUB 뉴스 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-news), [Developers 뉴스 명세](https://developers.naver.com/docs/serviceapi/search/news/news.md).

검색어 `query`는 필수이며 UTF-8로 인코딩한다. `display`는 1~~100, `start`는 1~~1000, `sort=date`는 날짜 내림차순이다. 날짜 구간이나 종목코드 전용 필터는 명세에 없다. [뉴스 API 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)
응답은 `title`, `originallink`, `link`, `description`, `pubDate`를 포함한다. `description`은 공급자가 제공하는 패시지이며 기사 전문이 아니다. `pubDate`는 네이버 제공 시각일 수 있어 원언론사 최초 발행일과 동일하다고 가정하지 않는다. `lastBuildDate`는 검색결과 생성 시각이다. [필드 정의](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)

### 호출량·요금 문서 사이에 차이가 있음

- API HUB 상위 가이드: 검색 카테고리 통합 **월 775,000건**, API Key당 **50 RPS**, 한시적 무료 기간에는 한도 증설 불가. [개요·FAQ](https://guide.ncloud-docs.com/docs/apihub-overview)
- API HUB 뉴스 개별 명세: 검색 API **하루 25,000회**라고 기재. [뉴스 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)
- 이를 월·일 단위로 임의 환산하거나 한쪽만 적용된다고 단정하지 않는다. 도입 시 콘솔의 실제 적용 한도와 공급자 설명을 확인한다.
- API HUB는 종량제 구조이나 현재 한시적 무료로 안내되며, 유료 전환은 사전 공지 예정이다. 확정되지 않은 향후 단가를 예산에 넣지 않는다. [서비스 개요](https://guide.ncloud-docs.com/docs/apihub-overview), [사용 준비](https://guide.ncloud-docs.com/docs/apihub-spec)

### 2026년 9월 약관 개정이 설계의 핵심

| 구분                     | 시행일         | 공식 근거                                                        |
| ------------------------ | -------------- | ---------------------------------------------------------------- |
| Developers 검색 API 특약 | **2026-09-07** | [개정 공지](https://developers.naver.com/notice/article/33400)   |
| API HUB 검색 API 특약    | **2026-09-20** | [개정 공지 2243](https://www.ncloud.com/support/notice/all/2243) |

두 공지의 검색 특약 2.1~2.4는 같은 핵심 제한을 담고 있다. API HUB 공지는 8월 20일 등록, 9월 1일 갱신됐으며 실제 브라우저 DOM으로 본문까지 확인했다.
개정 내용은 검색결과 제공 목적, 네이버 BI 표시, 독립적이고 가공 없는 표시, 원본 출처·이동 링크를 요구한다. 순위·내용 수정이나 다른 내용 삽입도 제한한다. [Developers 공지](https://developers.naver.com/notice/article/33400), [API HUB 공지](https://www.ncloud.com/support/notice/all/2243)
결과와 가공·파생물의 복사·저장·캐싱, 제3자 제공·판매, AI 입력·학습·개선·평가·노출 활용, 결과 페이지 광고 및 API를 통한 수익 창출을 금지하며 제한된 임시 보관만 예외로 둔다. [API HUB 공지](https://www.ncloud.com/support/notice/all/2243)

| 임시 보관 위치·목적         | 허용된 최대 기간                         |
| --------------------------- | ---------------------------------------- |
| 기기: 장애 대응 또는 개인화 | 24시간 또는 새 질의 시점 중 더 짧은 기간 |
| 서버: 이력 조회             | 최대 21일                                |
| 서버: 개인화                | 기기와 동일하며 목적별 분리 보관         |

기간이 지나면 지체 없이 삭제해야 한다. **21일은 모든 목적의 자유 저장 기간이 아니다.** 네이버를 영구 통합 뉴스 DB나 본문 요약 파이프라인의 기반으로 채택하는 제안은 배제한다. [API HUB 공지](https://www.ncloud.com/support/notice/all/2243)
공지의 개정 전 열에서도 독립 노출·왜곡 금지·URL 등 임의 수정 금지를 확인했다. API HUB 현행 약관 전문 전체는 별도로 확보하지 않아 일반 조항까지 Developers와 동일하다고 단정하지 않는다.
최초 조사에서는 네이버 실호출을 검증하지 않았다. 후속 운영 점검에서 기존 NAVER Cloud 커넥터의 자격 증명 설정과 실제 정기 수집 성공 기록을 확인했다. 키의 값은 조사 문서나 출력에 포함하지 않았다.

## 3. 국내 공식 RSS·직접 공급 후보

아래 주소는 공식 안내와 실제 응답 확인 여부를 구분한 목록이다. RSS 전문이 응답되더라도 본문 저장이나 재사용을 자동 허용한 것으로 보지 않는다.

| 공급자·분야       | 공식 안내 / 피드                                                                                         | 기술 확인                         | 이용 판단                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| 매일경제 증권     | [안내](https://www.mk.co.kr/rss/) / [증권 RSS](https://www.mk.co.kr/rss/50200011/)                       | HTTP 200, XML 50건                | 국내 증권 후보. 상업 표시·보관 권한 별도 확인             |
| 이투데이 마켓     | [안내](https://www.etoday.co.kr/rss/) / [마켓 RSS](https://rss.etoday.co.kr/eto/market_news.xml)         | HTTP 200, XML 8건                 | 공식 RSS의 비상업 용도 조건 확인. 상용 도입은 별도 협의   |
| 뉴시스 금융       | [안내](https://www.newsis.com/RSS/) / [금융 RSS](https://www.newsis.com/RSS/bank.xml)                    | HTTP 200, XML 100건               | 금융·시장 전반 보완. 저장·공개 표시 권한 확인             |
| 한국경제 증권     | [안내](https://www.hankyung.com/feed) / [증권 피드](https://www.hankyung.com/feed/finance)               | 로컬 요청 HTTP 403                | 공식 피드는 있으나 자동화·재사용 사전 동의 조항 검토 필요 |
| 연합인포맥스 증권 | [안내](https://news.einfomax.co.kr/rssIndex.html) / [증권 RSS](https://news.einfomax.co.kr/rss/S1N2.xml) | 안내 확인, 실제 XML 미검증(403)   | 전문 시장 뉴스 후보. 직접 공급 계약 우선 검토             |
| 이데일리 전체     | [전체 RSS](https://rss.edaily.co.kr/edaily_news.xml)                                                     | 공식 홈페이지 링크 확인, 요청 502 | 가용성·재사용 권한 확인 전 도입 보류                      |
| 매일경제TV 증권   | [증권 RSS](https://mmoney.mk.co.kr/rss/news/stock)                                                       | 인증서 이름 불일치                | 인증서 검증을 끄지 않고 정상 주소/인증서 확인까지 보류    |

한국경제 이용약관 19조는 자동화 수단 등을 통한 추출·수집과 AI 분석에 사전 허가/동의를 요구하며, 22조는 영리 재사용을 제한한다. 공식 RSS 존재만으로 이를 면제한다고 해석하지 않는다. [한국경제 정책](https://www.hankyung.com/help/policy)
이데일리는 비영리 이용에도 사전 서면 허가를 요구하는 정책을 안내한다. `stock_news.xml` 주소는 이번 조사에서 공식 검증하지 않아 추천 목록에 넣지 않았다. [이데일리 정책](https://www.edaily.co.kr/info/E04_04.html)
연합인포맥스는 증권 외에도 정책금융 `S1N15.xml`, 채권외환 `S1N16.xml`, 해외주식 `S1N21.xml`을 공식 RSS 안내에서 확인했다. 각 XML의 실제 응답은 미검증이다. [RSS 안내](https://news.einfomax.co.kr/rssIndex.html)
연합인포맥스의 계약형 데이터피드는 별도 제품으로 존재한다. 공개 페이지에서 상세 인증 규격·가격은 확정할 수 없었다. [데이터피드 상품](https://yonhap.einfomax.co.kr/newinfomax/yonhapinfomax/datafeed.html)
연합뉴스 자체 RSS는 이번 조사에서 현재 유효한 공식 주소를 검증하지 못했다. 연합인포맥스 RSS와 연합뉴스 RSS를 같은 것으로 취급하지 않는다.

## 4. 이번에 실제 가져온 범위

관측 시각은 **2026-09-04 22:55:47 KST**이며 UTC로는 `2026-09-04T13:55:47.751Z`이다.
매일경제·이투데이·뉴시스의 피드를 각각 파싱했으며, 각 2개의 제목·원문 링크·출처 시각만 검토용으로 남겼다.
기사 본문을 저장하지 않았고 데이터베이스에 적재하지 않았다. 샘플 기사 데이터는 이 저장소에 복사하지 않는다.

- [외부 검증 결과 JSON](/tmp/orsem-news-research-20260904/probe-results.json)
- [외부 제목·링크 샘플](/tmp/orsem-news-research-20260904/samples.md)

50·8·100건은 관측 당시 피드 안의 항목 수이며 매일 공급량·전체 기사 수·라이선스 범위를 뜻하지 않는다.
매일경제TV 실패 코드는 `ERR_TLS_CERT_ALTNAME_INVALID`였다. 403·502·인증서 오류는 이번 환경의 관측 결과이며 서비스가 영구 중단됐다는 결론이 아니다.
성공한 RSS도 발행 지연이나 공급 SLA를 보증하지 않는다. 피드의 실제 최종 발행일·첫 관측일·응답 시각을 구분해 관리한다.

## 5. 미국·글로벌 전문 뉴스 API

### Finnhub — 북미 회사 뉴스의 개인 실험 후보

- `GET https://finnhub.io/api/v1/company-news?symbol=AAPL&from=2026-09-01&to=2026-09-04`; 시장 전체는 `/api/v1/news?category=general&minId=...`.
- 인증: `X-Finnhub-Token` 헤더 또는 `token` 쿼리. `id`, Unix `datetime`, 제목, 요약, 출처, 원문 URL, 관련 종목 제공.
- 회사 뉴스는 북미 기업만 지원하며 무료 구간은 최근 1년 이력과 신규 업데이트를 제공한다. 확정 뉴스 지연 SLA는 미확인. [공식 API](https://finnhub.io/docs/api/quote)
- 웹사이트 개인 플랜은 기업 내부 이용도 별도 서면 승인이 필요하다. 데이터·파생 결과 공유와 구독 종료 후 보관에도 제한이 있다. [약관](https://finnhub.io/terms-of-service)
- 무료 60회/분은 현재 공식 가격 본문으로 재확인하지 못해 확정 수치로 쓰지 않는다. 전체 플랜 공통 초당 30회 상한은 공식 문서에 있다.

### Alpha Vantage — 뉴스·주제·감성 보조 조회

- `GET https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=AAPL&apikey=KEY`.
- 종목·주제·UTC 기간으로 조회하며 `limit` 최대 1000, 최신·과거·관련도 순을 지원한다. 복수 `tickers`는 모두 함께 언급된 기사 조건이다. [API 문서](https://www.alphavantage.co/documentation/#news-sentiment)
- 기본 무료 서비스는 대부분 데이터셋 25회/일이다. 장중 종목별 빈번한 폴링에는 작다. 확정 뉴스 전용 지연·이력 시작일은 미확인. [무료 제한](https://www.alphavantage.co/support/)
- 기본 약관은 개인 비상업용이며 상업 이용은 서면 계약이 필요하다. [약관](https://www.alphavantage.co/terms_of_service/)
- 공개 demo 호출은 기사 대신 정식 키 발급 안내를 반환했다. 실제 뉴스 payload를 수집한 것으로 보고하지 않는다.

### Benzinga — 상용 미국 전문 뉴스 우선 협의

- `GET https://api.benzinga.com/api/v2/news?token=KEY&tickers=AAPL&updatedSince=...&displayOutput=full`.
- 종목·CUSIP·ISIN·채널·주제 필터, 기사 ID·생성/수정 시각·제목·teaser·본문·stocks를 제공한다. REST pull과 TCP push를 안내한다. [Quickstart](https://docs.benzinga.com/introduction/introduction), [뉴스 명세](https://docs.benzinga.com/api-reference/news-api/get-news-items)
- 증분은 `updatedSince`를 권장하며 삭제 기사는 `/api/v2/news-removed`로 반영할 수 있다. 본문 출력은 계약 범위를 확인한다. [공식 구현 안내](https://www.benzinga.com/apis/blog/mastering-the-benzinga-newsfeed-api/)
- 직접 API 계약의 확정 공개 가격은 미확인이다. 개인용 화면 구독 가격을 API 재배포 가격으로 대체하지 않는다.

### Massive — 기본 News와 Benzinga 확장을 구분

- 기본: `GET https://api.massive.com/v2/reference/news?ticker=AAPL&apiKey=KEY`. 제목·description·publisher·종목·UTC 발행일·감성 insights와 원문 링크를 제공한다.
- 모든 Stocks 플랜에 포함되지만 **매시간 갱신**이다. 무료 2년, 유료 전체 이력이며 원천 기록 시작은 2016-06-22이다. [기본 News 명세](https://massive.com/docs/rest/stocks/news)
- 전문 확장: `GET https://api.massive.com/benzinga/v2/news?tickers=AAPL&apiKey=KEY`. 실시간, 2009-04-27부터의 이력, 본문·수정 시각·태그·종목 제공. [Benzinga v2 명세](https://massive.com/docs/rest/partners/benzinga/news)
- Benzinga News는 **월 $99 개인용**, Business는 견적이다. 상용 공개 서비스에 개인 요금제를 그대로 적용하지 않는다. [공식 가격](https://www.massive.com/partners/benzinga)
- 기존 `/benzinga/v1/news`는 종료되어 신규 구현에는 v2를 사용한다. [종료 공지](https://www.massive.com/changelog)

### NewsAPI.org — 글로벌 거시·산업 보완 검색

- `GET https://newsapi.org/v2/everything?q=...`; `X-Api-Key` 헤더. 키워드·언론사·기간 검색이며 기본 응답에 주식 종목 태깅은 없다.
- 제목·description·URL·UTC 발행일을 제공하고 `content`는 최대 200자로 잘린다. 한국어 `ko`는 Everything 지원 언어 목록에 없다. [명세](https://newsapi.org/docs/endpoints/everything)
- 무료는 100회/일·24시간 지연·1개월 검색이며 개발/테스트 전용이다. 내부 운영과 스테이징도 무료 대상이 아니다.
- Business는 월 $449, 실시간 가용·최대 5년 검색·월 25만 요청. 어떤 플랜도 검색 결과로 기사 전문을 제공하지 않는다. [가격](https://newsapi.org/pricing)

### LSEG / Reuters MRN — 기관급 확장 후보

- Reuters와 제휴 뉴스의 제목·본문·기업/주제 태깅·선택적 분석을 제공한다. WebSocket/Enterprise Message API 및 아카이브 등 계약별 전달 방식이다. [상품](https://www.lseg.com/en/data-analytics/financial-news-service/machine-readable-news)
- 글로벌·한국어를 포함하며 일부 이력은 1996년부터다. 가격은 견적이고 일반 무료 API 키형 서비스와 다르다. [제공 범위](https://www.lseg.com/en/data-catalogue/news)
- 표준 뉴스피드는 내부 프로그램 이용 중심이며 외부 배포·파생 결과 배포는 별도 허가가 필요하다. Workspace 개인 API는 서버 사용·재배포가 허용되지 않는다. [뉴스피드 조건](https://developers.lseg.com/en/product/news), [Workspace 조건](https://developers.lseg.com/en/product/news/workspace_news)

## 6. Orsem 현행 코드와 적용 전 필요한 설계

코드 점검상 NAVER의 Developers/API HUB 전환과 회사별 최신 10건 검색은 이미 구현되어 있다. [커넥터](/home/laeti/orsem/apps/worker/src/connectors/connector-adapters.ts:742)
현재 정기 발견은 NAVER P1 20분·P2 1시간이며 P3는 새 실시간 공시 확정 트리거다. 이는 현재 구현 설명이며 개정 약관 적합성을 보장하지 않는다. [worker 설명](/home/laeti/orsem/apps/worker/README.md:29)
등록 IR RSS는 `OFFICIAL_PUBLIC_DATA` 계약을 전제로 한다. 일반 언론 RSS를 여기에 넣으면 공식 공개데이터/IR로 잘못 분류될 수 있으므로 별도의 뉴스 경로가 필요하다. [IR 검증](/home/laeti/orsem/apps/worker/src/connectors/news-discovery.service.ts:304)

제안하는 구현 순서는 다음과 같다.

1. **공급자별 사용 범위 등록:** 개인/상업, 공개 표시, 보관 TTL, 본문·이미지·AI 처리, 수정·삭제 조건과 확인일을 기록한다.
2. **독립 `NEWS_RSS` 경로:** 언론사 registry, 파서, 작업, 스케줄, 장애 상태와 권리 정보를 IR과 분리한다.
3. **네이버 전용 검색 표시:** 검색결과 순서·출처·원문 링크·BI·목적별 TTL을 적용하고 통합 뉴스 적재/번역 경로와 분리한다.
4. **미국 계약 커넥터:** Finnhub는 개인 실험 범위, 상용 뉴스는 Benzinga/Massive Business 계약 범위에 맞춰 붙인다.

다음 데이터 처리 원칙은 **저장·처리가 허용된 공급자에 한해** 적용한다.

- 공급자 ID와 원문 canonical URL로 중복 후보를 찾고, 매체·수정본·재송고 관계를 보존한다. 원래 URL을 덮어쓰지 않는다.
- 원본 시각 문자열, 발행/수정 시각, 최초 관측 시각을 분리한다. 순간은 UTC로 저장하고 화면은 KST로 표시한다.
- 원천 필드와 provenance는 허용된 범위에서 유지한다. 금지된 원문이나 검색결과의 영구 보관을 감사 목적이라는 이유로 정당화하지 않는다.
- 회사명·영문명·별칭과 시장/거래소를 함께 매칭한다. 동명이인·그룹사·ETF 혼동은 신뢰도와 근거를 남긴다.
- RSS는 ETag/Last-Modified 조건부 요청, 429 재시도 지연, 타임아웃, 외부 엔티티 차단, HTTPS 검증을 적용한다.
- RSS 5~15분 폴링은 공급자 조건에 맞춰 조정할 **초기 제안값**이다. 실제 공급 주기나 SLA로 표현하지 않는다.
- 기사 삭제·정정, 계약 종료 시 삭제 의무, 캐시 만료가 전체 저장·검색·표시·AI 경로에 반영되도록 설계한다.

## 7. 후속 의사결정

우선 실제 응답을 확인한 국내 RSS 3곳의 운영 이용 범위를 확인하고, 상용 본문/가공이 필요하면 직접 공급 계약을 비교한다.
네이버는 가까운 9월 시행일을 기준으로 현재 저장·번역·표시 흐름을 점검할 필요가 있다. 이번 조사는 기존 흐름을 변경하거나 중단하지 않았다.
공급자 계약 확인 전에는 무료·공개 endpoint라는 이유만으로 영구 수집을 활성화하지 않는다. 계약형 서비스의 미공개 가격과 미검증 가용성은 별도 확인 항목으로 남긴다.
