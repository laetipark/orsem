# 소스 어댑터

| 어댑터                          | 범위                                                                    | 저장 내용                                                                                         | 검증에서의 역할                        |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| OpenDART                        | D001~D005, 기업 코드, 원문, 기업별·일별 요약                            | 공식 목록 필드, ZIP 해시·경로, 파싱한 사실과 경고                                                 | 한국 공시의 1차 증거                   |
| Toss Securities                 | 한국·미국 비수정 일봉·분봉, 실시간 체결가, 제한된 범위의 공식 기업 이름 | 소스별 봉, 원본 필드, 출처, 거래일·관측 시각, 캐시된 실시간 시세, 원본 기업 정보와 이름 적용 이력 | 유일한 차트 공급자, 개인용 표시만 허용 |
| SEC EDGAR                       | P1/P2 제출 문서와 공식 공시 링크                                        | 공식 공시 메타데이터와 허용된 사실                                                                | 미국 공시의 1차 증거                   |
| Samsung Global                  | 코드에 검토된 정확한 Global Newsroom RSS                                | 제목·제공 요약·원문 링크·원시 발행 문자열·권리 스냅샷·허용된 번역                                 | 기존 정책에 따른 기업 직접 발표        |
| NAVER 뉴스 API                  | 정기 대상 순환·종목별 자동 조회                                         | 개인 화면용 메타데이터 DB 저장, 전문·로그·AI 저장 없음                                            | 원출처 링크 검색                       |
| 공식 뉴스 RSS                   | Federal Reserve 2종·BLS·EIA 2종, 15분마다 전체 피드                     | 제목·제공 요약·원문 링크·발행 시각·권리 스냅샷·허용된 번역                                        | 미국 공식 기관 발표                    |
| Alpaca                          | 미국 자산 마스터만 사용, 가격 수집 종료                                 | 자산 식별 메타데이터와 소스 이용 권리                                                             | 미국 종목 코드와 거래소 식별           |
| Marketaux·Alpha Vantage·Finnhub | 기존 MARKET_NEWS worker의 조건부 API 어댑터                             | 승인 시 허용 metadata와 출처·시각·회사 연결·권리 스냅샷; 현재 요청·저장 차단                      | 관리자 개인 관측의 뉴스 후보 발견      |
| 신규 등록 RSS                   | NVDA·AVGO·PANW 공식 IR, 한국경제 증권                                   | 비활성 프로필·UNKNOWN 정책만 등록; 권리 확인 전 수집 없음                                         | 기업 직접 발표와 국내 언론을 구분      |

활성 소스는 상태 점검 결과를 제공합니다. 키가 없으면 해당 소스만 비활성 상태가 되며 다른 소스는 중단하지 않습니다. 출처, 시의성, 이용 권리가 다르므로 커넥터가 다른 소스로 조용히 대체해서는 안 됩니다.

가격 공급자는 토스만 사용합니다. REST 봉은 `adjusted=false`로 요청하며 원본 십진 필드를 보존합니다. 현재가는 REST 스냅샷으로 시작하고 서버가 소유한 WebSocket 연결 하나에서 갱신을 받습니다. 스트림에는 유실 가능성이 있고 누적 거래량이 없으므로, 수신 틱을 재구성하지 않고 REST로 봉과 거래량을 갱신합니다. 국내 실시간 틱은 KRX+NXT를 포함합니다. REST 봉의 거래소 범위는 문서에 명시되지 않아 통합 시세로 표시하지 않습니다. API 자격 증명과 토큰은 브라우저에 전달하지 않습니다. [토스 설정](OPERATIONS.md#toss-securities-chart-setup)을 참고하세요.

토스 공식 기업 정보의 `name`·`englishName`으로 해외 기업의 한글 표시 이름을 보완합니다. 관심 목록과 최근 조회 범위만 최대 100개로 제한하고, 정상 응답은 24시간 재사용합니다. 기존 한국어 이름과 영문 원문은 보존하며 종목·시장·통화·ISIN을 검증합니다. 토스가 지원하지 않거나 식별 정보가 맞지 않으면 기존 이름을 유지합니다. 원본 응답과 이용 권리·관측 이력을 보관하며, [기업명 운영 절차](OPERATIONS.md#해외-기업의-한글명-보완)를 참고하세요.

KRX와 Alpaca EOD 가격 수집은 종료되었습니다. 이전 가격 작업이 큐에 남아 있어도 거절합니다. Alpaca 자산 마스터 동기화는 별도의 기업 식별 소스로 유지하며 차트 가격을 제공하지 않습니다.

NAVER는 공식 기사와 함께 원문 링크로 표시하며, 정기·종목별 자동 조회와 임시 보존은 [뉴스 수집](NEWS_COLLECTION.md) 정책을 따릅니다. `NAVER_API_PROVIDER`로 호출할 서비스를 명시합니다. 기본값은 기존 배포와의 호환성을 위한 `developers`이며, NAVER Cloud API HUB에서 발급한 키는 `ncloud`를 선택해야 합니다. 두 서비스는 자동으로 대체되지 않으며 인증 실패 시 다른 주소로 키를 다시 전송하지 않습니다.

네이버 검색 메타데이터는 기존 통합 뉴스 DB에 저장합니다. 원응답·제공 요약·원문/네이버 링크·발행 문자열·최초 관측 시각을 보존하고 기존 호출 한도를 유지합니다. 저장 기사는 관리자·회원 개인 화면에서 현재 등록 정책과 행별 권한에 따라 조회하며 전문·AI·번역·자동 알림에는 사용하지 않습니다. [뉴스 수집 정책](NEWS_COLLECTION.md)을 따릅니다.

| `NAVER_API_PROVIDER` | 뉴스 검색 주소                                        | Client ID / Secret 요청 헤더                     | 응답 형식     |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------- |
| `developers`         | `https://openapi.naver.com/v1/search/news.json`       | `X-Naver-Client-Id` / `X-Naver-Client-Secret`    | JSON          |
| `ncloud`             | `https://naverapihub.apigw.ntruss.com/search/v1/news` | `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` | `format=json` |

주소·인증 헤더 전환은 [HUB 이관 안내](https://guide.ncloud-docs.com/docs/apihub-migration), Cloud 요청 형식은 [HUB 뉴스 검색 API 안내](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)를 따릅니다. 인증 정보·이용 한도와 요금은 선택한 서비스의 [개발자센터 뉴스 API 안내](https://developers.naver.com/docs/serviceapi/search/news/news.md) 또는 [HUB 준비 안내](https://guide.ncloud-docs.com/docs/apihub-spec)를 확인하세요. 어느 서비스를 선택하든 뉴스 원본 필드, 출처, 이용 권리, 발행 시각과 최초 관측 시각을 보존하는 정책은 같습니다.

## NAVER 인증 오류

`NAVER_CLIENT_ID`와 `NAVER_CLIENT_SECRET`이 설정되어 있다는 것은 인증 성공을 뜻하지 않습니다. `HTTP 401`에서는 먼저 `NAVER_API_PROVIDER`와 키의 발급처가 일치하는지 확인한 뒤, 같은 Application의 키 쌍과 뉴스 검색 사용 권한을 확인합니다. HUB는 API Gateway 기반이므로 개발자센터와 오류 응답 형식·상태 코드가 다를 수 있습니다. [HUB 이관·오류 처리 안내](https://guide.ncloud-docs.com/docs/apihub-migration)

- `ncloud`: **NAVER Cloud 콘솔 → NAVER API HUB → Application → 해당 Application → 인증 정보**의 Client ID·Client Secret을 사용합니다. Application에 **NAVER 검색 → 뉴스**가 선택되어 있어야 합니다. 클라우드 계정의 일반 Access Key·Secret Key와 구분합니다.
- `developers`: **Application → 내 애플리케이션 → 해당 앱 → 개요**에서 키를 확인하고 **API 설정 → 검색** 사용 여부를 확인합니다. 검색 권한이 없으면 `HTTP 403`도 발생할 수 있습니다. [공식 앱 설정 절차](https://developers.naver.com/docs/serviceapi/search/blog/blog.md), [공통 오류 안내](https://developers.naver.com/docs/common/openapiguide/errorcode.md)

공급자 선택이나 키를 변경한 뒤에는 API에 환경을 다시 주입하고 실제 뉴스 요청 성공을 확인합니다. [Orsem 운영 절차](OPERATIONS.md#naver-news-authentication)를 참고하세요.

## 기업 아이콘 출처

종목 로고는 **Logo.dev**를 기본 외부 공급자, **Brandfetch Logo API**를 선택적 보조 공급자로 사용합니다. 두 공급자 모두 기본 비활성 상태이며 공개용 키/Client ID와 무료 한도 설정이 충족되어야 요청합니다. 키가 없거나 로고가 실패하면 검수된 로컬 파일 또는 자체 텍스트·도형 아이콘으로 표시합니다. 과거 이미지 로드 기록을 기업 매핑 검수로 승인하거나 외부 이미지를 서버에서 다운로드하지 않습니다. 뉴스·시세 연결 설정은 별개입니다.

2026-09-10 확인한 [Logo.dev 가격표](https://www.logo.dev/pricing)는 무료 월 500,000 요청, [Brandfetch 가격표](https://brandfetch.com/developers/pricing)는 표의 월 1,000,000과 FAQ의 월 500,000이 불일치합니다. Brandfetch는 대시보드 확인 전 월 500,000 이하를 내부 상한으로 적용하고, 캐시 안내의 불일치도 더 제한적인 직접 브라우저 표시 조건을 따릅니다. 유료 구독·카드·자동 충전·초과 과금을 활성화하지 않습니다.

Logo.dev의 무료 상업용 [출처 표시 조건](https://www.logo.dev/docs/platform/attribution)은 로그인 기반 앱의 공개 안내 페이지 배치를 허용합니다. `/sources` 본문에서 `/logo-sources`로 연결하며 footer의 로고 출처 링크는 제거했습니다. `/logo-sources` 공개 페이지 본문에 Logo.dev 직접 출처 링크를 제공합니다. Simple Icons와 Wikimedia Commons는 파일별 이용 조건·기업 매핑을 검수한 항목만 로컬 소스로 등록할 수 있습니다. URL 생성, 이미지 로드, 올바른 기업/상품 로고 검수는 별개로 기록합니다. 공급자 조건, 매핑, ETF 역할, OpenDART 홈페이지 후보 재사용, 실패 처리, 실제 표시 확인 표본과 남은 검수는 [종목 로고 운영 문서](STOCK_LOGOS.md)를 참고하세요.

## 공식 링크 규칙

- OpenDART 뷰어: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rceptNo}`.
- OpenDART 목록의 `rcept_dt`는 날짜로 저장하며 임의의 자정 시각을 만들지 않습니다.
- SEC 요청은 `SEC_USER_AGENT`로 애플리케이션을 식별하며, 로컬 요청 한도는 공급자의 공정 접근 상한보다 낮게 설정합니다.
- 사용자에게 보이는 시각은 Asia/Seoul로 표시하고 소스 시각은 UTC로 유지합니다.

## 뉴스 정규화

정규 URL을 먼저 확인하고, 원출판사·기업·발행 시각이 일치하는 정규화 제목 해시를 기존 뉴스 그룹 연결에서 사용합니다. 제목 유사성만으로 서로 다른 사건을 자동 병합하지 않습니다. 소스·시각·기업·핵심 사실의 확인은 기존 공식 자료 연결과 검토함을 이용합니다. 같은 보도를 여러 aggregator가 반환해도 발견 경로 수와 독립 출처 수를 분리하므로 증거 등급이 높아지지 않습니다. 기사 내용은 신뢰할 수 없는 외부 데이터이며 이용 권리나 도구 동작을 바꾸는 지시가 아닙니다.

선택적인 [뉴스 한국어 번역](NEWS_TRANSLATION.md)은 현재 수집 경로의 제목과 허용된 제공 요약에 적용합니다. 신규 뉴스는 기사 원문 HTML·본문·이미지를 요청하지 않으며, AI·번역 권리가 명시적으로 허용되지 않으면 queue에 넣지 않습니다. 원문·해시·출처·현재 권리와 일치하는 완료 결과만 표시하고 번역을 공식 검증이나 새 증거로 취급하지 않습니다.

## 2026-09-06 SEC·GDELT·Alpaca 추가 경계

이 절은 위의 기존 최근 건수·GDELT 일반 활성화 안내보다 우선한다. SEC 공식 API는 계속 1차 원본이며 최근 20건 선택은 정기 복구 경로에서 제거했다. [SEC 복구](SEC_GAP_RECOVERY.md)와 [Form 3/4/5](SEC_OWNERSHIP.md)를 따른다. 민간 SEC-API.io는 문서상 대안으로만 남긴다.

GDELT는 정확한 publisher 정책 승인 전 비활성이다. 단순 무료 데이터 검색 가능 여부로 본문·재배포·AI 권리를 승인하지 않는다. 시간 구간 복구와 incomplete 표시는 기존 GDELT recovery 경로를 유지한다. Alpaca News 어댑터의 비활성 경계도 유지한다. 2026-09-07 추가 후보의 당시 판단은 [국내·미국 뉴스 공급자 비교](NEWS_PROVIDER_COMPARISON.md)에 보존한다. 현재 승인 조건은 [이용 권리](RIGHTS.md)와 코드의 정책 레지스트리를 확인한다.

## 2026-09-07 확장 전 repository audit

README, AGENTS, SOURCES, NEWS_COLLECTION, NEWS_PROVIDER_COMPARISON, RIGHTS, ARCHITECTURE, DATA_MODEL, API, OPERATIONS, `.env.example`을 worker·API·database·contracts 코드와 대조한 뒤 확장을 시작했습니다. 아래 상태와 TypeScript 경로는 2026-09-07 코드 수정 전 기준이며 현재 구현 경로나 운영 환경변수의 활성 상태를 뜻하지 않습니다. 현재 Python 코드 위치는 [워커 구조](PYTHON_WORKER.md#코드와-저장-계약)를 참고합니다. 문서의 과거 본문 수집 설명과 실제 metadata 수집 경로의 차이도 정리했습니다.

| Provider·기능                                       | 확장 전 상태                          | 실제 코드 위치                                                                          | 주요 문서                           | enabled 기본값·조건                             | 기존 권리 상태                         | 이번 변경                                                 |
| --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| OpenDART D001~D005·기업 코드·검색·ZIP/XML·지분 파서 | 구현됨                                | `apps/worker/src/opendart/`, `packages/opendart-parser/src/`                            | README, SOURCES, DATA_MODEL         | 키가 있어야 동작                                | 공식 공시 정책                         | 재구현 없음; 공식 근거 연결에서 기존 저장 자료 사용       |
| SEC EDGAR                                           | 구현됨                                | `apps/worker/src/connectors/connector-adapters.ts`의 SecSubmissionsConnector            | SOURCES, SEC_GAP_RECOVERY           | SEC_USER_AGENT 필요                             | 공식 공시 정책                         | 수집기 유지                                               |
| SEC Form 3/4/5                                      | 구현됨                                | `apps/worker/src/sec/ownership-parser.ts`, `apps/worker/src/sec/ownership-ingestion.ts` | SEC_OWNERSHIP                       | Form 처리 플래그 기본 true; SEC 접근 설정 필요  | 공식 ownership 자료                    | 변경 없음                                                 |
| NAVER developers/ncloud                             | 구현됨                                | `apps/api/src/news-search/`, 기존 NaverNewsConnector                                    | NEWS_COLLECTION, RIGHTS, OPERATIONS | 키·선택 provider·무료 이용 확인 필요            | 메타데이터 DB 저장; 전문·로그·AI 금지  | 변경 없음                                                 |
| Samsung Global RSS                                  | 구현됨, 기업 IR 처리에 전용 제약 존재 | RegisteredIrFeedConnector, `packages/contracts/src/news-sources.ts`                     | SOURCES, NEWS_COLLECTION            | IR_FEED_URLS 등록 필요                          | PRIVATE_DISPLAY_ONLY, 기존 승인 프로필 | 프로필 조회를 일반화하고 기존 동작 유지                   |
| Fed·BLS·EIA RSS                                     | 구현됨                                | PublisherNewsRssConnector, NEWS_RSS_FEEDS                                               | SOURCES, NEWS_COLLECTION            | NEWS_RSS_FEEDS 설정 필요; config 기본 빈 목록   | 공식 기관 정책                         | 기존 안전 parser 재사용                                   |
| 토스 국내·미국 가격·차트·기업명                     | 구현됨                                | `apps/worker/src/market-data/toss-*.ts`                                                 | SOURCES, OPERATIONS                 | 토스 자격 증명 필요                             | 개인용 표시 정책                       | 가격 공급자 추가 없음                                     |
| GDELT                                               | 비활성 구현·publisher 승인 경계 존재  | GdeltMetadataConnector, `gdelt-window-recovery.ts`                                      | NEWS_PROVIDER_COMPARISON, RIGHTS    | GDELT_ENABLED=false; 정확한 publisher 승인 필요 | provider metadata와 원출판사 권리 분리 | 새 어댑터 없음                                            |
| Alpaca 자산 master                                  | 구현됨                                | `apps/worker/src/market-data/alpaca-asset-master.client.ts`                             | SOURCES, OPERATIONS                 | 키 쌍 필요                                      | 자산 식별 metadata                     | 변경 없음                                                 |
| Alpaca News                                         | 비활성 구현 존재                      | `apps/worker/src/connectors/alpaca-news.connector.ts`                                   | NEWS_PROVIDER_COMPARISON            | ALPACA_NEWS_ENABLED=false; 승인 registry null   | entitlement·publisher 검토 필요        | 기존 어댑터·checkpoint·overlap·include_content=false 유지 |
| Marketaux                                           | 비교 문서만, 어댑터 없음              | 신규 `free-news-api.connector.ts`                                                       | NEWS_PROVIDER_COMPARISON            | 이번 추가: false                                | 이번 추가: UNKNOWN                     | 조건부 어댑터 추가                                        |
| Alpha Vantage NEWS_SENTIMENT                        | 어댑터 없음                           | 신규 `free-news-api.connector.ts`                                                       | NEWS_PROVIDER_COMPARISON            | 이번 추가: false                                | 이번 추가: UNKNOWN                     | 저빈도 조건부 어댑터 추가                                 |
| Finnhub Company News                                | 어댑터 없음                           | 신규 `free-news-api.connector.ts`                                                       | NEWS_PROVIDER_COMPARISON            | 이번 추가: false                                | 이번 추가: UNKNOWN                     | 조건부 어댑터 추가; News Sentiment 제외                   |
| 미국 IR·한국경제 증권                               | 해당 개별 프로필 없음                 | 기존 NEWS_IR_SOURCE_PROFILES / NEWS_RSS_FEEDS                                           | NEWS_PROVIDER_COMPARISON            | 이번 추가 프로필 false                          | UNKNOWN                                | 정확한 feed와 host만 등록                                 |

신규 API는 `FreeNewsApiConnector` 계열로 기존 `LinkDiscoveryAdapter`, `DiscoveryCandidate`, `DiscoveryBatch`, `RecoveryStore`, `MARKET_NEWS/DISCOVER_LINKS`를 사용합니다. 예산은 기존 source_checkpoints와 api_usage_counters에 저장하며 별도 table·company master·범용 RSS proxy를 만들지 않습니다. 공개 공시·정부·기업 IR → 독립 언론 → aggregator → 후보 발견의 순서를 유지하고 뉴스만으로 투자 추천·자동 주문을 만들지 않습니다.
