# 소스 어댑터

| 어댑터          | 범위                                                                    | 저장 내용                                                                                         | 검증에서의 역할                         |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| OpenDART        | D001, D002, D005, 기업 코드, 원문, 기업별·일별 요약                     | 공식 목록 필드, ZIP 해시·경로, 파싱한 사실과 경고                                                 | 한국 공시의 1차 증거                    |
| Toss Securities | 한국·미국 비수정 일봉·분봉, 실시간 체결가, 제한된 범위의 공식 기업 이름 | 소스별 봉, 원본 필드, 출처, 거래일·관측 시각, 캐시된 실시간 시세, 원본 기업 정보와 이름 적용 이력 | 유일한 차트 공급자, 개인용 표시만 허용  |
| SEC EDGAR       | P1/P2 제출 문서와 공식 공시 링크                                        | 공식 공시 메타데이터와 허용된 사실                                                                | 미국 공시의 1차 증거                    |
| 기업 IR         | 관리자가 명시적으로 등록한 RSS/Atom·공식 URL                            | 피드 메타데이터, 링크, 허용되는 경우 가져온 내용의 해시                                           | 기업 발표의 1차 증거                    |
| NAVER 뉴스 API  | P1은 20분마다, P2는 매시간, P3는 트리거 발생 시                         | 제목, 요약, 원본 URL, 출처, 시각                                                                  | 발견용이며 중요한 수치는 공식 검증 필요 |
| Alpaca          | 미국 자산 마스터만 사용, 가격 수집 종료                                 | 자산 식별 메타데이터와 소스 이용 권리                                                             | 미국 종목 코드와 거래소 식별            |
| GDELT           | 어댑터·상태 점검 제공, 기본 일정·트리거 없음                            | 명시적으로 호출할 때 메타데이터와 기사 URL                                                        | 잡음이 많은 발견용 소스                 |

활성 소스는 상태 점검 결과를 제공합니다. 키가 없으면 해당 소스만 비활성 상태가 되며 다른 소스는 중단하지 않습니다. 출처, 시의성, 이용 권리가 다르므로 커넥터가 다른 소스로 조용히 대체해서는 안 됩니다.

가격 공급자는 토스만 사용합니다. REST 봉은 `adjusted=false`로 요청하며 원본 십진 필드를 보존합니다. 현재가는 REST 스냅샷으로 시작하고 서버가 소유한 WebSocket 연결 하나에서 갱신을 받습니다. 스트림에는 유실 가능성이 있고 누적 거래량이 없으므로, 수신 틱을 재구성하지 않고 REST로 봉과 거래량을 갱신합니다. 국내 실시간 틱은 KRX+NXT를 포함합니다. REST 봉의 거래소 범위는 문서에 명시되지 않아 통합 시세로 표시하지 않습니다. API 자격 증명과 토큰은 브라우저에 전달하지 않습니다. [토스 설정](OPERATIONS.md#toss-securities-chart-setup)을 참고하세요.

토스 공식 기업 정보의 `name`·`englishName`으로 해외 기업의 한글 표시 이름을 보완합니다. 관심 목록과 최근 조회 범위만 최대 100개로 제한하고, 정상 응답은 24시간 재사용합니다. 기존 한국어 이름과 영문 원문은 보존하며 종목·시장·통화·ISIN을 검증합니다. 토스가 지원하지 않거나 식별 정보가 맞지 않으면 기존 이름을 유지합니다. 원본 응답과 이용 권리·관측 이력을 보관하며, [기업명 운영 절차](OPERATIONS.md#해외-기업의-한글명-보완)를 참고하세요.

KRX와 Alpaca EOD 가격 수집은 종료되었습니다. 이전 가격 작업이 큐에 남아 있어도 거절합니다. Alpaca 자산 마스터 동기화는 별도의 기업 식별 소스로 유지하며 차트 가격을 제공하지 않습니다.

NAVER는 뉴스를 발견하는 커넥터이며 차트 가격을 제공하지 않습니다. `NAVER_API_PROVIDER`로 호출할 서비스를 명시합니다. 기본값은 기존 배포와의 호환성을 위한 `developers`이며, NAVER Cloud API HUB에서 발급한 키는 `ncloud`를 선택해야 합니다. 두 서비스는 자동으로 대체되지 않으며 인증 실패 시 다른 주소로 키를 다시 전송하지 않습니다.

2026-09-04 조사에서 Developers 9월 7일·API HUB 9월 20일 시행 검색 특약 개정을 확인했습니다. 현재의 메타데이터 저장·통합 표시·번역 구현이 개정 조건에 적합하다는 뜻은 아닙니다. 저장 목적·기한과 표시·AI 활용 제한, 대체 뉴스 공급원은 [뉴스 API·RSS 조사](NEWS_SOURCES_RESEARCH_2026-09-04.md)를 참고하세요. 이번 조사는 운영 수집 동작을 변경하지 않았습니다.

| `NAVER_API_PROVIDER` | 뉴스 검색 주소                                        | Client ID / Secret 요청 헤더                     | 응답 형식     |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------- |
| `developers`         | `https://openapi.naver.com/v1/search/news.json`       | `X-Naver-Client-Id` / `X-Naver-Client-Secret`    | JSON          |
| `ncloud`             | `https://naverapihub.apigw.ntruss.com/search/v1/news` | `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` | `format=json` |

주소·인증 헤더 전환은 [HUB 이관 안내](https://guide.ncloud-docs.com/docs/apihub-migration), Cloud 요청 형식은 [HUB 뉴스 검색 API 안내](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)를 따릅니다. 인증 정보·이용 한도와 요금은 선택한 서비스의 [개발자센터 뉴스 API 안내](https://developers.naver.com/docs/serviceapi/search/news/news.md) 또는 [HUB 준비 안내](https://guide.ncloud-docs.com/docs/apihub-spec)를 확인하세요. 어느 서비스를 선택하든 뉴스 원본 필드, 출처, 이용 권리, 발행 시각과 최초 관측 시각을 보존하는 정책은 같습니다.

## NAVER 인증 오류

`NAVER_CLIENT_ID`와 `NAVER_CLIENT_SECRET`이 설정되어 있다는 것은 인증 성공을 뜻하지 않습니다. `HTTP 401`에서는 먼저 `NAVER_API_PROVIDER`와 키의 발급처가 일치하는지 확인한 뒤, 같은 Application의 키 쌍과 뉴스 검색 사용 권한을 확인합니다. HUB는 API Gateway 기반이므로 개발자센터와 오류 응답 형식·상태 코드가 다를 수 있습니다. [HUB 이관·오류 처리 안내](https://guide.ncloud-docs.com/docs/apihub-migration)

- `ncloud`: **NAVER Cloud 콘솔 → NAVER API HUB → Application → 해당 Application → 인증 정보**의 Client ID·Client Secret을 사용합니다. Application에 **NAVER 검색 → 뉴스**가 선택되어 있어야 합니다. 클라우드 계정의 일반 Access Key·Secret Key와 구분합니다.
- `developers`: **Application → 내 애플리케이션 → 해당 앱 → 개요**에서 키를 확인하고 **API 설정 → 검색** 사용 여부를 확인합니다. 검색 권한이 없으면 `HTTP 403`도 발생할 수 있습니다. [공식 앱 설정 절차](https://developers.naver.com/docs/serviceapi/search/blog/blog.md), [공통 오류 안내](https://developers.naver.com/docs/common/openapiguide/errorcode.md)

공급자 선택이나 키를 변경한 뒤에는 API·worker에 환경을 다시 주입하고 실제 뉴스 요청 성공을 확인합니다. [Orsem 운영 절차](OPERATIONS.md#naver-news-authentication)를 참고하세요.

## 기업 아이콘 출처

로고 공급자는 토스나 기업 공식 사이트가 아닌 **AllInvestView Ticker Logos CDN**입니다. 무료이며 API 키·가입이 필요하지 않습니다. 브라우저는 `https://cdn.tickerlogos.com/{domain}`을 직접 요청하고 참조 정보를 보내지 않습니다. [공급자 안내](https://www.allinvestview.com/tools/ticker-logos/)를 기준으로 사용합니다.

현재 검증한 정적 목록은 NVIDIA `US:NVDA` → `https://cdn.tickerlogos.com/nvidia.com`, 삼성전자 보통주 `KR:005930` → `https://cdn.tickerlogos.com/samsung.com` 두 기업입니다. 각각 실제 로고가 담긴 128px PNG 응답을 브라우저에서 확인했습니다. 이미지 주소·출처·확인 날짜를 기록하며, 미등록·로딩 실패 시 글자로 대체합니다. 전체 티커 자동 연결이나 실시간 로고 검색은 하지 않습니다. 제공자의 검색 API는 응답 검증을 완료하지 못해 사용하지 않습니다.

로고를 표시하는 페이지마다 사용자에게 보이는 dofollow 링크가 필요합니다. Orsem은 공통 `AppShell` 하단에 [Logos by AllInvestView](https://www.allinvestview.com/tools/ticker-logos/)를 표시하고 `nofollow`·`sponsored`·`ugc`를 붙이지 않습니다. CDN 한도는 IP당 하루 20,000회, 10초당 최대 30회입니다. 한도 우회와 자동화된 대량 다운로드를 하지 않으며, 로고를 변형하거나 소유 기업의 보증·제휴를 암시하지 않습니다. [서비스 이용 조건](https://www.allinvestview.com/tools/ticker-logos/terms/)을 따릅니다.

검토한 대안인 Logo.dev는 공개용 토큰이 필요하며 현재 연동하지 않습니다. [공식 티커 문서](https://www.logo.dev/docs/logo-images/ticker)는 한국 거래소 접미사 `.KQ`를 명시합니다. `.KS`를 포함한 개별 국내 종목 지원 여부와 응답은 별도 확인이 필요하며, 이를 검증된 운영 범위로 간주하지 않습니다.

## 공식 링크 규칙

- OpenDART 뷰어: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rceptNo}`.
- OpenDART 목록의 `rcept_dt`는 날짜로 저장하며 임의의 자정 시각을 만들지 않습니다.
- SEC 요청은 `SEC_USER_AGENT`로 애플리케이션을 식별하며, 로컬 요청 한도는 공급자의 공정 접근 상한보다 낮게 설정합니다.
- 사용자에게 보이는 시각은 Asia/Seoul로 표시하고 소스 시각은 UTC로 유지합니다.

## 뉴스 정규화

정규 URL, 정규화한 제목 해시, 소스·이벤트 시각·기업·핵심 사실, 유사도 순으로 적용합니다. 같은 보도가 여러 곳에 전재돼도 증거 등급이 높아지지 않습니다. 지시문처럼 보이는 내용은 신뢰할 수 없는 기사 본문으로 취급하며 분류기 정책, 이용 권리 제한, 도구 동작을 바꾸지 못합니다.

선택적인 [뉴스 한국어 번역](NEWS_TRANSLATION.md)은 정규화 이후 저장된 영문 제목·허용 요약에만 적용합니다. 원문과 출처를 바꾸지 않고 번역을 별도로 보관하며, 현재 원문 해시·출처·이용 권리가 일치하는 완료 결과만 표시합니다. 번역 문장은 공식 검증이나 새로운 증거로 취급하지 않습니다.
