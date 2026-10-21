# 데이터 이용 권리 정책

## 비로그인 표시 범위

공개 화면은 회원용 데이터의 권리를 확장하지 않습니다. 시장 카탈로그와 관측값 모두 `OFFICIAL_PUBLIC_DATA`인 미국 국채 2년·10년과 WTI만 서버에서 제공합니다. 종목 검색은 OpenDART·SEC로 확인된 식별 정보를 사용하며 토스·Alpaca 전용 정보와 회원용 가격은 반환하지 않습니다.

공개 뉴스는 `fed-press`, `fed-speeches`, `bls-latest`, `eia-today`, `eia-press`로 제한합니다. 저장 당시 정책과 현재 등록 정책의 메타데이터 저장·표시·공개 재배포 허용 및 소스·권리 모드가 모두 일치해야 합니다. 원문 본문은 제공하지 않습니다. NAVER·Samsung 및 미승인 뉴스는 공개 응답에 포함하지 않습니다.

미국 주식 차트는 TradingView의 공식 삽입 위젯을 브라우저에서 직접 표시합니다. 위젯 시세는 수집·프록시·저장하지 않으며 출처와 지연 표시를 유지합니다. 국내 주식과 미지원 심볼은 외부 원문 링크 및 로그인 안내를 제공하고 비공개 가격으로 대체하지 않습니다. [위젯 지원 시장](https://www.tradingview.com/widget-docs/markets/north-america/)과 [데이터 제한](https://www.tradingview.com/widget-docs/faq/data/)을 따릅니다.

## 조건부 뉴스 소스의 승인과 독자 범위 (2026-09-07)

Marketaux·Alpha Vantage·Finnhub와 신규 기업 IR·한국경제 RSS는 **구현되어 있어도 기본 비활성, 권리는 UNKNOWN**이다. 공식 endpoint/무료 플랜 확인은 장기 저장·AI 처리·번역·재배포 허가를 뜻하지 않는다. 원문 HTML·본문·이미지는 요청하거나 저장하지 않는다. 실제 계정 응답과 권리를 확인하기 전 자동 활성화하지 않는다.

기존 `NewsSourcePolicy`를 `policyVersion: 2`로 최소 확장한다. `rightsStatus`는 `APPROVED | METADATA_ONLY | LINK_ONLY | REQUIRES_CONTRACT_REVIEW | UNKNOWN | BLOCKED`이며 저장 모드인 `rightsMode`와 별개다. `metadataStorageAllowed`, `summaryStorageAllowed`, `fullTextStorageAllowed`, `aiAllowed`, `translationAllowed`, `publicRedistributionAllowed`를 독립적으로 기록한다. **null은 미확인, false는 명시적으로 허용하지 않음**이다. 기존 레코드의 `'UNKNOWN'` 값도 호환한다. 근거는 `policyUrl`, 검토일은 `checkedAt`, 정책 식별자는 `policyId`로 보존한다.

| 신규 정책         | metadata / summary | full text | AI / translation | redistribution | 현재 상태 |
| ----------------- | ------------------ | --------- | ---------------- | -------------- | --------- |
| Marketaux         | null / null        | false     | null / null      | null           | UNKNOWN   |
| Alpha Vantage     | null / null        | false     | null / null      | null           | UNKNOWN   |
| Finnhub           | null / null        | false     | null / null      | false          | UNKNOWN   |
| NVDA·AVGO·PANW IR | null / null        | false     | null / null      | null           | UNKNOWN   |
| 한국경제 증권 RSS | null / null        | false     | null / null      | null           | UNKNOWN   |

정책 근거와 무료 운영 판단은 [공급자 비교](NEWS_PROVIDER_COMPARISON.md)에 기록한다. API는 공급자 정책과 정확한 원출판사 domain/name의 승인 정책을 모두 요구한다. publisher를 추정하거나 API 자체를 원출판사로 대체하지 않는다. 제공 요약도 두 정책에서 명시적으로 허용될 때만 저장한다. 승인 레지스트리는 코드 검토 대상이며 환경변수나 API 키로 우회할 수 없다.

신규 승인의 초기 독자는 `ADMIN_UI`다. 개인용 관리자 화면은 회원 화면(`MEMBER_UI`), 관심방(`SHARED_ROOM`), 봇(`BOT`)과 구별한다. 인증된 세션에서 독자 범위를 정하고 클라이언트 query로 바꾸지 않는다. 뉴스 목록·검색·상세·대시보드의 대표 기사, 관련 종목, 정렬, provenance와 개수도 허용된 행만 사용한다. 공유 화면이나 봇을 허용하려면 별도의 권리를 확인해야 한다.

저장 당시 `sourcePolicyJson`은 재수집으로 넓히지 않는다. 현재 코드 정책도 승인 상태여야 수집·표시·번역할 수 있으므로 저장된 승인 사본만으로 철회된 소스를 다시 열 수 없다. publisher의 권리를 철회할 때에는 공급자 기본 정책도 먼저 BLOCKED로 바꿔 기존 사본의 노출을 차단하고, 영향 레코드·정책을 검토한 뒤 승인 범위를 다시 배포한다. 요약·AI·번역은 원래 승인과 현재 승인의 교집합만 사용한다. 신규 API는 기존 자동 번역 소스 목록에도 추가하지 않는다.

기업 IR·보도자료는 독립 검증 출처로 세지 않는다. `providerCount`는 발견 경로 수이고 `independentSourceCount`는 확인된 독립 원출처 수다. 동일 원문을 세 API에서 발견했다고 독립 근거 세 건으로 승격하지 않는다. 공식 자료 연결의 `CONFIRMED`는 관리자가 관련성을 확인했다는 뜻이며 수치·실적·계약 금액이나 투자 판단을 자동 검증했다는 의미가 아니다.

모든 소스 항목은 `rightsMode`를 갖습니다. API와 화면은 이용 권리를 실제로 적용해야 하며, 문서에만 적어 두어서는 안 됩니다.

| 모드                   | 의미                                                        | 기본 용도                                    |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `OFFICIAL_PUBLIC_DATA` | 해당 약관에 따라 보관할 수 있는 공식 데이터                 | OpenDART·SEC의 사실과 원문 참조              |
| `PRIVATE_DISPLAY_ONLY` | 개인용 비상업 표시만 허용하며 외부 제공용 데이터 API는 금지 | 토스 가격·기업 정보와 Alpaca 자산 메타데이터 |
| `STORE_METADATA_ONLY`  | 허용된 제목·출처 URL·해시 저장, 요약은 별도 권리 필요       | 권리가 확인된 RSS·GDELT 항목                 |
| `LINK_ONLY`            | 사용자가 제공하거나 승인된 공개 링크와 내부 분류만 저장     | 링크로만 처리하도록 승인된 소스              |
| `NO_REDISTRIBUTION`    | 승인된 처리 범위 밖으로 콘텐츠를 노출하지 않음              | 제한이 있는 라이선스·제휴 콘텐츠             |

`APP_MODE=PRIVATE`, `PUBLIC_MARKET_DATA_API=false`, `PUBLIC_ARTICLE_BODY=false`는 운영 정책 표시 값이며, 관련 라이선스를 검토하기 전에는 제한적인 상태를 유지해야 합니다. 현재 MVP는 이를 실행 시점의 기능 허용 조건으로 읽지 않습니다. 실제 통제는 인증된 경로, 범위가 제한된 봇 경로, 문서 접근 권한, 각 레코드의 `rightsMode`로 이루어집니다. 환경 변수 문자열 하나를 바꿨다고 데이터 공개 권한이 생기는 것으로 해석하면 안 됩니다.

인증된 기업 타임라인은 모든 가격 봉의 `source`와 `rightsMode`를 유지합니다. 토스 봉과 실시간 시세는 `PRIVATE_DISPLAY_ONLY`를 사용합니다. 이는 애플리케이션의 이용 제한이며, 공급자가 무제한 저장이나 재배포 권한을 부여했다는 뜻이 아닙니다. 애플리케이션은 토스 시세를 공개하는 경로나 주문 실행 연동을 제공하지 않습니다. 화면은 토스 비수정 봉과 국내 통합 실시간 시세를 구분해 표시합니다. KRX와 Alpaca 가격은 사용을 종료하여 차트 응답에서 제외합니다. 서로 다른 공급자의 기록이 덮어써지지 않도록 소스 메타데이터는 스키마에 유지합니다.

뉴스 건수는 증거의 강도를 뜻하지 않습니다. 이벤트 묶음은 공식 소스, 최초 보도, 발견 경로, 독립적으로 검증된 출처를 각각 기록합니다.

뉴스 기사 본문은 요청·추출·저장·번역하지 않습니다. 자동 번역은 승인된 `NEWS_RSS`·`IR`의 제목과 제공 요약에만 적용합니다. 소스의 `rightsMode`가 기록된 정책과 일치하고 `metadataStorageAllowed`, `displayAllowed`, `aiAllowed`가 모두 `true`인 `OFFICIAL_PUBLIC_DATA`·`PRIVATE_DISPLAY_ONLY` 항목만 처리합니다. `fullTextStorageAllowed`는 메타데이터 번역 조건이 아니며 `UNKNOWN`, `STORE_METADATA_ONLY`, `LINK_ONLY`, `NO_REDISTRIBUTION`의 번역은 허용하지 않습니다. 제목·제공 요약·출처·시각·해시를 보존하고 번역은 별도로 저장해 **자동 번역**으로 표시합니다. 모든 뉴스는 원문으로 연결하며 공시 분류나 증거 등급은 바꾸지 않습니다. [번역 범위와 보존](NEWS_TRANSLATION.md#입력과-권리)을 참고하세요.

기존 기사 본문과 본문 번역·수동 편집 사본은 마이그레이션으로 운영 DB에서 제거합니다. 수동 제목·요약과 감사 이력은 메타데이터 v2로 보존하며 앱의 이전 본문 편집 초안도 삭제합니다. 과거 백업과 공시 원본은 이 정리 대상에 포함하지 않습니다.

기업 로고는 토스 가격 데이터와 별개로 검수된 로컬 이미지와 Logo.dev·Brandfetch 후보를 사용합니다. 외부 요청에는 공급자별 이용 조건과 공유 예산을 적용하고 공개 `/logo-sources` 페이지에 출처를 표시합니다. 기업·ETF 매핑 검수와 이미지 로드 성공은 구분하며, 현재 정책·검증 범위·근거는 [종목 로고 문서](STOCK_LOGOS.md)를 참고하세요.

주기 뉴스는 검토된 콘텐츠 프로필의 `sourcePolicyJson`으로 표시·메타데이터 저장·AI·전문 저장·재배포·알림 권한을 구분합니다. 저장 뉴스는 Samsung Global, Federal Reserve, BLS, EIA의 승인된 메타데이터를 표시합니다. 시장 공통 범위는 Federal Reserve·BLS와 네이버의 증시·금리·환율 검색 결과로 구성합니다. 새 RSS와 IR은 프로필이 없으면 등록·수집하지 않습니다. NAVER 검색 메타데이터는 사용자가 요청한 기존 뉴스 테이블 저장 경로로 관리합니다. 원제목·제공 요약·원문/네이버 링크·발행 문자열을 보존하며 `LINK_ONLY` 권리 모드를 유지합니다. 신규 `naver-news-metadata-v1` 정책은 ADMIN_UI·MEMBER_UI에만 저장 메타데이터와 제공 요약 표시를 허용하고 전문·AI·번역·알림·저장 기사 공유방/봇 배포는 허용하지 않습니다. 다른 소스와 과거 정책 없는 행의 권한은 확장하지 않습니다. 모든 뉴스 목록은 동일한 권한 필터와 DB 커서로 최신순 정렬하고 기사 중복을 제거합니다. [뉴스 수집 정책](NEWS_COLLECTION.md)을 따릅니다.

## SEC ownership·메타데이터 뉴스 추가 정책

SEC ownership은 공식 공시의 구조화 관측이며 접수·거래 날짜와 원문 코드·숫자·각주를 보존한다. 공개시장 거래라는 추정, 투자 추천, 자동 매매를 생성하지 않는다. raw XML은 이번 경로에서 파일/DB에 저장하지 않는다.

GDELT는 publisher별 저장·표시 승인을 요구한다. `APPROVED_GDELT_SOURCE_POLICIES`는 비어 있고 `GDELT_ENABLED=true`만으로 수집을 허용하지 않는다. ALPACA_NEWS는 공식 공시가 아닌 제3자 언론 metadata다. 공급자의 응답 가능성, 무료 entitlement, 저장·공유·AI 권리는 각각 확인한다. 승인 레지스트리는 기본 null이다. 두 메타데이터 어댑터는 aiAllowed/fullTextStorageAllowed/notifyAllowed=false를 강제한다.

장기 저장·캐시·공유 계약이 미확인인 후보는 UNKNOWN 또는 REQUIRES_CONTRACT_REVIEW로 둔다. 승인 철회 시 수집 설정을 끄고 해당 SourceItem 정책의 displayAllowed를 false로 갱신해 기존 표시를 차단한다. 보존 대상인 메타데이터 이력·제목·요약 번역을 삭제해 처리하지 않는다. [공식 근거와 비교](NEWS_PROVIDER_COMPARISON.md)를 참고한다.
