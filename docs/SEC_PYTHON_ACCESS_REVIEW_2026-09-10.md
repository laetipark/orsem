# SEC Python 접근 검토 — 2026-09-10

Python 전환에는 SEC 공식 API와 연락처를 포함한 User-Agent, 모든 SEC 요청이 공유하는 1초 간격 및 영속 cooldown이 반영되어 있다. 운영 User-Agent의 연락처 형식과 환경 파일 일치는 확인됐지만, **SEC 403 해소는 확인되지 않았다**. 이번 검토에서는 운영 서버에서 추가 SEC HTTP 요청을 보내지 않았다.

사용자가 제시한 [SEC EDGAR Python 참고 글](https://ology.tistory.com/478)의 핵심은 연락처 User-Agent, 티커–CIK 매핑, 10자리 CIK, `companyfacts` 및 `submissions` 사용이다. 기술 기준은 [SEC 공식 API 설명](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [EDGAR 접근 지침](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data), [개발자 공정 접근 지침](https://www.sec.gov/about/developer-resources)과 대조했다. SEC 공식 데이터 API에는 별도 API 키가 필요하지 않으며, 연락처를 식별하는 User-Agent와 전체 요청량 제한을 준수해야 한다.

| 비교 항목                  | Python 적용 상태                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 연락처 User-Agent          | `config.py`에서 `SEC_USER_AGENT` 형식을 검증한다. 종목 마스터, 재무 데이터, 공시 목록, ownership 원문 호출 모두 동일 설정값을 전달한다. 실제 연락처와 헤더 값은 기록하지 않는다.                                                                |
| 티커–CIK 매핑              | `market/masters.py`에서 SEC 공식 `company_tickers_exchange.json`을 사용한다. 참고 글의 `company_tickers.json`과 달리 거래소 정보도 제공하는 공식 매핑이며, 기존 운영 동작을 보존한다.                                                           |
| 10자리 CIK·공식 엔드포인트 | `market/fundamentals.py`의 `companyfacts`와 `connectors/providers.py`의 `submissions`에서 `zfill(10)`을 적용한다. 응답의 CIK도 대상 회사와 대조한다.                                                                                            |
| 공유 요청 간격             | `connectors/sec_access.py`가 DB checkpoint와 요청 슬롯을 공유하고 요청 시작 간격을 최소 1초로 유지한다. SEC 공식 상한인 사용자 전체 초당 10회보다 보수적이다. 여러 워커나 서로 다른 SEC 수집 작업이 같은 제한을 사용한다.                       |
| 403·429와 복구             | 같은 모듈이 403/429 응답 헤더를 받은 시점에 cooldown을 먼저 저장한다. 기본 10분에서 연속 실패에 따라 최대 6시간까지 늘리며, 더 긴 `Retry-After`도 존중한다. 저장 실패 시 추가 요청을 차단한다. cooldown 이후 복구 요청도 공유 lease로 제한한다. |
| 기존 운영 보존             | 현재 배포 JS의 공통 1초 슬롯, `ACCESS_COOLDOWN`, 실제 활성화 플래그를 기준으로 옮겼다. SEC 설정이 없으면 해당 커넥터만 비활성화한다.                                                                                                            |

운영의 읽기 전용 점검 결과는 다음과 같다. 타임스탬프는 저장된 UTC와 사용자 표시용 KST를 함께 적었다.

| 항목                                | 확인 결과                                              |
| ----------------------------------- | ------------------------------------------------------ |
| 연락처 형식 유효 / 환경 파일과 일치 | `true` / `true`                                        |
| 최근 상태                           | HTTP `403`, 분류 `SEC_UNDECLARED_AUTOMATION`           |
| 최근 실패                           | `2026-09-10T09:40:00.675Z` — 9월 10일 18:40:00.675 KST |
| 기록된 다음 시도 가능 시각          | `2026-09-10T15:40:00.675Z` — 9월 11일 00:40:00.675 KST |
| 연속 실패 수                        | `11`                                                   |

User-Agent의 로컬 형식 검증은 실제 요청 승인이나 연락처 소유권을 증명하지 않는다. SEC는 IP 및 자동화 정책에 따른 접근 제한도 명시한다. 따라서 위 값만으로 원인을 헤더 누락으로 단정하거나 복구됐다고 표시할 수 없다. 기존 cooldown을 유지하고, 이후 정상 수집의 실제 성공 응답으로 복구 여부를 판단한다.

2026-09-11 운영 전환 후 배포된 Python CLI의 `collect-sec --status`로 저장 상태를 다시 조회했다. 새 HTTP 요청은 보내지 않았다. 당시 최근 점검 시각은 `2026-09-10T16:10:00.690Z`였고, 상태는 여전히 `DEGRADED`/HTTP `403`, 다음 시도 가능 시각은 **2026-09-11 06:41:09.768 KST**였다. 성공 이력은 없었으며 기존 영속 cooldown을 보존했다.

관련 네이티브 코드: [SEC 공유 접근 정책](../apps/worker/python/orsem_worker/connectors/sec_access.py), [공시 목록](../apps/worker/python/orsem_worker/connectors/providers.py), [재무 데이터](../apps/worker/python/orsem_worker/market/fundamentals.py), [종목 매핑](../apps/worker/python/orsem_worker/market/masters.py), [ownership 원문](../apps/worker/python/orsem_worker/disclosures/sec.py). 오프라인 회귀 검증에는 403 헤더 후 cooldown 저장, 진단 본문 읽기 실패, DB 저장 실패 시 차단이 포함된다. 이 검증은 운영 HTTP 성공을 대신하지 않는다.
