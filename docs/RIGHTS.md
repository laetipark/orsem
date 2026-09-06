# 데이터 이용 권리 정책

모든 소스 항목은 `rightsMode`를 갖습니다. API와 화면은 이용 권리를 실제로 적용해야 하며, 문서에만 적어 두어서는 안 됩니다.

| 모드                   | 의미                                                        | 기본 용도                                    |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| `OFFICIAL_PUBLIC_DATA` | 해당 약관에 따라 보관할 수 있는 공식 데이터                 | OpenDART·SEC의 사실과 원문 참조              |
| `PRIVATE_DISPLAY_ONLY` | 개인용 비상업 표시만 허용하며 외부 제공용 데이터 API는 금지 | 토스 가격·기업 정보와 Alpaca 자산 메타데이터 |
| `STORE_METADATA_ONLY`  | 허용된 제목·출처 URL·해시 저장, 요약은 별도 권리 필요       | 권리가 확인된 RSS·GDELT 항목                 |
| `LINK_ONLY`            | 사용자가 제공하거나 승인된 공개 링크와 내부 분류만 저장     | 링크로만 처리하도록 승인된 소스              |
| `NO_REDISTRIBUTION`    | 승인된 처리 범위 밖으로 콘텐츠를 노출하지 않음              | 제한이 있는 라이선스·제휴 콘텐츠             |

`APP_MODE=PRIVATE`, `PUBLIC_MARKET_DATA_API=false`, `PUBLIC_ARTICLE_BODY=false`는 운영 정책 표시 값이며, 관련 라이선스를 검토하기 전에는 제한적인 상태를 유지해야 합니다. 현재 MVP는 이를 실행 시점의 기능 허용 조건으로 읽지 않습니다. 실제 통제는 인증된 경로, 범위가 제한된 봇 경로, 문서 접근 권한, 각 레코드의 `rightsMode`로 이루어집니다. 환경 변수 문자열 하나를 바꿨다고 데이터 공개 권한이 생기는 것으로 해석하면 안 됩니다.

인증된 기업 타임라인은 모든 가격 봉의 `source`와 `rightsMode`를 유지합니다. 토스 봉과 실시간 시세는 `PRIVATE_DISPLAY_ONLY`를 사용합니다. 이는 애플리케이션의 이용 제한이며, 공급자가 무제한 저장이나 재배포 권한을 부여했다는 뜻이 아닙니다. 애플리케이션은 공개 시세 경로나 주문 실행 연동을 제공하지 않습니다. 화면은 토스 비수정 봉과 국내 통합 실시간 시세를 구분해 표시합니다. KRX와 Alpaca 가격은 사용을 종료하여 차트 응답에서 제외합니다. 서로 다른 공급자의 기록이 덮어써지지 않도록 소스 메타데이터는 스키마에 유지합니다.

뉴스 건수는 증거의 강도를 뜻하지 않습니다. 이벤트 묶음은 공식 소스, 최초 보도, 발견 경로, 독립적으로 검증된 출처를 각각 기록합니다.

뉴스 기사 본문은 요청·추출·저장·번역하지 않습니다. 자동 번역은 승인된 `NEWS_RSS`·`IR`의 제목과 제공 요약에만 적용합니다. 소스의 `rightsMode`가 기록된 정책과 일치하고 `metadataStorageAllowed`, `displayAllowed`, `aiAllowed`가 모두 `true`인 `OFFICIAL_PUBLIC_DATA`·`PRIVATE_DISPLAY_ONLY` 항목만 처리합니다. `fullTextStorageAllowed`는 메타데이터 번역 조건이 아니며 `UNKNOWN`, `STORE_METADATA_ONLY`, `LINK_ONLY`, `NO_REDISTRIBUTION`의 번역은 허용하지 않습니다. 제목·제공 요약·출처·시각·해시를 보존하고 번역은 별도로 저장해 **자동 번역**으로 표시합니다. 모든 뉴스는 원문으로 연결하며 공시 분류나 증거 등급은 바꾸지 않습니다. [번역 범위와 보존](NEWS_TRANSLATION.md#처리-범위와-보존)을 참고하세요.

기존 기사 본문과 본문 번역·수동 편집 사본은 마이그레이션으로 운영 DB에서 제거합니다. 수동 제목·요약과 감사 이력은 메타데이터 v2로 보존하며 앱의 이전 본문 편집 초안도 삭제합니다. 과거 백업과 공시 원본은 이 정리 대상에 포함하지 않습니다.

기업 로고는 토스 가격 데이터와 별개로 AllInvestView CDN에서 표시합니다. 눈에 보이는 출처 링크, 요청 한도, 대량 다운로드·로고 변형 금지 조건을 유지합니다. 현재 검증 범위와 근거는 [기업 아이콘 출처](SOURCES.md#기업-아이콘-출처)를 참고하세요.

주기 뉴스는 검토된 콘텐츠 프로필의 `sourcePolicyJson`으로 표시·메타데이터 저장·AI·전문 저장·재배포·알림 권한을 구분합니다. 저장 뉴스는 Samsung Global, Federal Reserve, BLS, EIA의 승인된 메타데이터를 표시합니다. 시장 공통 범위는 Federal Reserve·BLS와 네이버의 증시·금리·환율 검색 결과로 구성합니다. 새 RSS와 IR은 프로필이 없으면 등록·수집하지 않습니다. NAVER 검색 응답은 회사·시장·자산 주제 모두 동일한 제한된 메모리에서 표시하고 만료 시 제거합니다. DB·로그·AI·알림에는 저장하지 않으며 원제목·링크·제공 순서를 유지합니다. [뉴스 수집 정책](NEWS_COLLECTION.md)을 따릅니다.

## SEC ownership·메타데이터 뉴스 추가 정책

SEC ownership은 공식 공시의 구조화 관측이며 접수·거래 날짜와 원문 코드·숫자·각주를 보존한다. 공개시장 거래라는 추정, 투자 추천, 자동 매매를 생성하지 않는다. raw XML은 이번 경로에서 파일/DB에 저장하지 않는다.

GDELT는 publisher별 저장·표시 승인을 요구한다. `APPROVED_GDELT_SOURCE_POLICIES`는 비어 있고 `GDELT_ENABLED=true`만으로 수집을 허용하지 않는다. ALPACA_NEWS는 공식 공시가 아닌 제3자 언론 metadata다. 공급자의 응답 가능성, 무료 entitlement, 저장·공유·AI 권리는 각각 확인한다. 승인 레지스트리는 기본 null이다. 두 메타데이터 어댑터는 aiAllowed/fullTextStorageAllowed/notifyAllowed=false를 강제한다.

장기 저장·캐시·공유 계약이 미확인인 후보는 UNKNOWN 또는 REQUIRES_CONTRACT_REVIEW로 둔다. 승인 철회 시 수집 설정을 끄고 해당 SourceItem 정책의 displayAllowed를 false로 갱신해 기존 표시를 차단한다. 보존 대상인 메타데이터 이력·제목·요약 번역을 삭제해 처리하지 않는다. [공식 근거와 비교](NEWS_PROVIDER_COMPARISON.md)를 참고한다.
