# SEC 접근 정책 재설정 — 2026-09-09

## 변경과 배포

기존 애플리케이션 식별자·연락처 User-Agent는 형식 검증과 실행 중인 worker 환경 대조를 통과했다. 환경 파일의 실제 값은 변경하지 않았다. SEC 접근 정책을 보수적으로 조정하고 worker를 다시 빌드·재시작했다.

- 같은 DB를 사용하는 모든 SEC GET 경로의 요청 슬롯 간격: 250ms → 1초. 현재 운영은 단일 worker다. 여러 worker에서는 예약 뒤 DB 조회 지연에 따라 실제 전송 시작 간격이 달라질 수 있다.
- 연속 403/429 대기: 10·20·40·80·160·320분, 이후 최대 6시간. 더 긴 `Retry-After`와 기존 대기 시각을 보존한다.
- 연속 실패 횟수와 실패 식별자를 DB에 보존한다. 횟수가 없는 기존 거부 기록은 1회로 해석한다. 대기 중 생략된 요청은 횟수를 늘리지 않는다.
- 실제 SEC 2xx 응답으로만 횟수를 초기화하며, 먼저 시작한 성공 요청이 더 최근 실패 기록을 초기화하지 않도록 행 잠금과 실패 식별자를 확인한다.

2026-09-09 07:32 KST worker 재시작 후 PID는 `221103`이다. API 프로세스는 유지했다. 재시작 전후 모두 SEC 대기 시각 `2026-09-08T22:35:00.276Z` (07:35:00 KST)가 유지됐고, 실행 중인 worker의 User-Agent는 기존 환경 파일과 일치했다.

배포 전 환경과 worker 산출물을 저장소 밖의 비공개 임시 디렉터리에 백업했다. 실제 연락처, 공인 IP, 자격증명, SEC 원문은 이 문서에 포함하지 않는다. 배포한 `dist/connectors/sec-access-policy.js`의 SHA-256은 `b15037c695c2690c1c2851afbef3cabf32c7e3015f35b51ae93d283b8fd89c83`이다.

## 검증

- SEC 접근 정책·오류 판별·실제 직렬화 User-Agent·공시 수집·CIK 연결·재무정보·ownership 수집 관련 테스트 8개 묶음, 95개 테스트 통과.
- worker TypeScript 타입 검사·빌드 통과.
- 변경한 TypeScript 파일의 ESLint·Prettier 검사 및 `git diff --check` 통과.
- 독립 코드 리뷰에서 이번 변경으로 발생한 결함은 발견하지 못했다. 요청 슬롯과 실제 전송 간격의 차이는 위에 명시했다.

테스트 통과와 배포 완료는 SEC 접근 복구를 뜻하지 않는다. 공식 응답 200과 실제 수집 저장까지 확인해야 수집 복구로 판정한다.

## 재설정 후 실제 요청 결과

2026-09-09 07:37:20 KST (`2026-09-08T22:37:20.645Z`) 기존 대기 종료 후 배포 산출물의 공유 접근 정책으로 NVIDIA `https://data.sec.gov/api/xbrl/companyfacts/CIK0001045810.json`에 한 번 요청했다.

| 항목                | 결과                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| HTTP / 응답 분류    | 403 / `SEC_UNDECLARED_AUTOMATION`                                         |
| 서버 / Content-Type | `AkamaiGHost` / `text/html`                                               |
| 전송된 User-Agent   | 설정값과 일치함을 Undici 요청 직렬화 시점에서 확인                        |
| TLS                 | 인증서 검증 통과, TLS 1.3, SEC 도메인 인증서, DigiCert/GeoTrust 발급 체인 |
| 응답 헤더 도착      | 82ms                                                                      |
| `Retry-After`       | 없음                                                                      |
| 연속 거부 횟수      | 기존 거부 1회 + 이번 요청 1회 = 2회, DB 저장 확인                         |
| 다음 요청 가능 시각 | `2026-09-08T22:57:20.727Z` = 07:57:20 KST, 20분 대기 적용                 |

재설정과 대기 확대는 운영에 적용됐지만 접근 거부는 계속된다. HTTP 200·재무정보 취득·공시 저장은 확인하지 못했다. 공시 출처 항목은 0건이며 SEC 상태는 `DEGRADED`다. 이 점검은 HTTP 진단이므로 기존 공시 수집의 성공 상태를 변경하지 않았다. 점검 후 worker는 PID `221103`, PM2 `online` 상태를 유지했다.

실제 연락처·송신 공인 IP를 포함한 비공개 진단 자료는 `/tmp/orsem-sec-access-private.json`, SEC 문의 초안은 `/tmp/orsem-sec-webmaster-draft.txt`에 권한 `0600`으로 저장했다. 이메일은 발송하지 않았다. 기존 shared cooldown을 지우거나 우회하는 추가 요청은 하지 않았다.

## 사전 실측

2026-09-09 06:59:41 KST 같은 호스트의 Python `requests`와 기존 연락처 User-Agent로 NVIDIA `companyfacts`에 접근했으나 HTTP 403 / `SEC_UNDECLARED_AUTOMATION`이었다. 07:25 KST 정기 ticker 마스터 요청은 HTTP 403 / `SEC_RATE_LIMIT`으로 기록됐다. 이 코드는 응답 본문의 고정 분류이며, HTTP 429나 IP 차단 원인을 확정한 것은 아니다.

환경·실행 프로세스에서 HTTP 프록시 설정이나 TLS 검증 해제는 발견하지 못했다. SEC 목적지의 IPv4 경로는 일반 Ethernet 인터페이스이며 WireGuard를 통하지 않았다. IPv6 경로는 없었다. 이러한 진단만으로 SEC가 거부한 내부 원인을 확정할 수 없다.

공개 조회 API는 [SEC EDGAR API 문서](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)를 사용한다. [접근 지침](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)에 맞는 식별 정보를 사용해도 접근이 복구되지 않으면, [SEC Webmaster 안내](https://www.sec.gov/about/webmaster-frequently-asked-questions)에 따라 응답 시각·오류·IP를 포함한 문의로 확인할 수 있다.
