# SEC 요청 통제와 데이터 복구 검증 — 2026-09-09

이 장애는 Orsem 데이터 인프라 장애다. 대상 기업의 악재나 거래 신호로 분류하지 않는다. 상태는 **접속 설정 보완 완료, SEC 수집 복구 미완료**다. 이 문서는 [07:37 KST 진단 기록](SEC_ACCESS_RECONFIGURATION_2026-09-09.md)에 대한 후속 점검이다.

## 요청 통제 범위

현재 운영 소스와 worker 산출물에서 확인한 SEC 데이터 요청은 `worker.module.ts`의 `HTTP_FETCH = createSecFetch(dataSource, transport.fetch)`를 사용한다.

| 경로                            | 실제 요청 경로                                       |
| ------------------------------- | ---------------------------------------------------- |
| ticker 마스터                   | `SecCikSyncService` → `SecTickerMasterClient`        |
| submissions 최근 목록·과거 파일 | `NewsDiscoveryService` → `SecSubmissionsConnector`   |
| companyfacts                    | `SecCompanyInformationService`, 시작 시·15분마다     |
| Archives Form 3/4/5 XML         | `ingestPendingSecOwnership`                          |
| API 회사정보 조회·갱신 요구     | DB 요청 표지만 생성, 실제 조회는 companyfacts worker |
| 수동 초기 수집 CLI              | `collect-sec.cjs` → worker 큐                        |
| SEC 상태 조회                   | 저장 상태만 조회하며 HTTP probe 없음                 |
| 이번 Node·Python 진단           | Node wrapper의 `createSecFetch`를 거쳐 전송          |

통제 범위는 같은 DB를 사용하는 이 애플리케이션의 `sec.gov`·`www.sec.gov`·`data.sec.gov` GET 요청이다. 다른 프로그램·브라우저·같은 송신망의 다른 장비·다른 SEC 호스트·비GET 요청까지 통제한다는 의미가 아니다.

현재 우회 호출은 발견하지 못했지만, `createLinkDiscoveryAdapters`의 기본 `globalThis.fetch`와 Python 보조파일의 단독 실행은 잠재적인 누락 지점이다. 새 운영 호출자는 공통 fetch를 명시적으로 주입하고, Python 보조파일은 Node 정책 wrapper를 통해서만 실행해야 한다.

## 발견한 문제와 보완

### 대기 종료 시 여러 worker의 요청 중첩

기존 코드는 1초 슬롯을 공유하지만, 대기 종료 후 첫 요청의 응답이 오기 전에 다른 worker가 다음 요청을 보낼 수 있었다. 외부 네트워크 없는 회귀 테스트로 수정 전 실패를 재현했다.

과거 거부 기록이 있는 경우에는 요청 직전 DB 행잠금으로 30초 동안 복구 요청 권한을 한 worker에 부여한다. 다른 worker는 HTTP 요청을 보내지 않는다. 요청 제한 시간과 권한 만료는 같은 절대 시각을 사용하며, 소유자만 해제한다. 프로세스가 중단돼도 권한이 만료된다. 늦게 도착한 응답은 실패 기록을 초기화하지 못한다.

이는 복구 확인 요청을 동시에 한 건으로 제한하는 조치다. 2xx 헤더만으로 데이터 복구를 선언하지 않는다. 정상 상태의 슬롯 예약도 분산 환경의 모든 실제 전송 간격을 정확히 1초로 보장한다는 의미는 아니다. 공통 정책을 사용하지 않는 구형 프로세스나 외부 프로그램까지 제어할 수 없다.

### 공시 목록 성공이 원문 처리 대기를 가리는 상태 판정

기존에는 원문 처리 실패 후 재시도 대기 중인 문서가 다음 회차의 처리 대상에서 빠지면, 이번 실패 수가 0이라는 이유로 전체 SEC 상태가 정상으로 바뀔 수 있었다.

원문 처리 이후 재시도 대기·회차 상한으로 제외된 문서까지 잔여 수를 확인한다. 활성화된 원문 처리 경로의 잔여가 있으면 전체 `DEGRADED`를 유지하고 전체 마지막 성공 시각을 전진시키지 않는다. 목록의 실제 HTTP 200은 유지하면서 `submissionsStatus`, `submissionsHttpStatus`, `submissionsLastSuccessAt`로 분리한다. 목록 저장과 발행인별 복구 커서는 보존한다.

원문은 `ownershipPending`, `ownershipWaiting`, `ownershipIncomplete`와 실제 시도·생략·요청 여부 불명 건수를 구분한다. 요청 없이 잔여만 없는 회차는 `NO_PENDING`, 의도적으로 비활성화한 기능은 `DISABLED`다. DB 정책 오류가 HTTP 전후 어느 단계에서 발생했는지 알 수 없는 경우 요청 여부를 `false`로 단정하지 않는다.

## 데이터별 현재 상태와 완료 기준

07:52 KST 운영 DB를 읽기 전용으로 확인한 결과다. 0건은 기업에 공시가 없다는 뜻이 아니다.

| 경로             | 현재 결과                                | 복구 완료를 확인할 증거                                                                   |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| 공시 목록        | SEC source item 0건, 발행인 baseline 0건 | 유효한 submissions 검증 → accession 저장·재조회 → 장애 구간 커서·중복·최초 관측 보존 확인 |
| 내부자 거래 원문 | 대상 receipt 0건, XML 완료 0건           | Form 3/4/5 XML 검증 → 처리 결과 저장·재조회 → 대기·미처리 잔여 확인                       |
| 재무 수치        | SEC company information snapshot 0건     | CIK·JSON·기간·단위 검증 → snapshot 저장·재조회                                            |

일반적인 10-K·8-K HTML 원문 전체를 다운로드·분석하는 경로는 현재 worker에 구현돼 있지 않다. 그 범위는 접근 복구와 별도의 구현 범위다. `companyfacts` 성공은 공시 원문 복구를 뜻하지 않으며, 해당 서비스는 전체 SEC 공시 health를 갱신하지 않는다.

`retryAt`/`nextRetryAt` 필드 이름은 기존 저장·API 호환성을 위해 유지한다. 의미는 다음 요청 또는 진단이 허용되는 가장 이른 시각이며, SEC의 접근 허용·해제 약속이 아니다. HTTP 날짜와 초 단위 `Retry-After`를 모두 처리하며, 더 긴 공급자 대기는 자체 6시간 상한보다 우선한다.

## SEC 문의 증거

[SEC Webmaster FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)는 접근 거부 시 오류 화면 또는 오류 원문과 IP 주소를 포함한 문의를 안내한다. 문의 목적은 차단 여부와 시정 조치 확인이다.

문의 초안은 저장소 밖 `/tmp/orsem-sec-webmaster-draft.txt`에 권한 `0600`으로 보관한다. UTC·KST, GET URL, 실제 직렬화 시 확인한 User-Agent, 허용 목록의 응답 헤더, 요청 통제 범위와 그 한계를 포함한다. 송신 공인 IP는 같은 서버의 별도 HTTPS 반사 서비스에서 관측한 값이며 SEC가 확인한 송신 주소로 단정하지 않는다.

07:37 응답의 전체 본문·참조번호는 당시 보존하지 않았으므로 복원하거나 없었다고 주장할 수 없다. 이후 허용된 진단 요청에서는 오류 본문을 최대 64KiB·1초 한도로 별도 비공개 자료에 보존하고, 참조번호 유무와 본문 잘림 여부를 구분하도록 진단 스크립트를 보완했다. 공개 로그·DB 진단 필드에는 본문이나 참조번호를 추가하지 않는다. 문의 메일은 발송하지 않았다.

## 공식 ZIP 검토 범위

[SEC 공식 API 문서](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)의 `submissions.zip`과 `companyfacts.zip`은 각각 제출 이력과 XBRL 데이터의 야간 배포본이다. 공시 원문 전체 ZIP은 아니다. 이번에는 내려받지 않았다. 필요 시 기존 통제 정책과 출처를 유지한 별도 초기 적재 경로로 검토하며, 접근 거부를 피하기 위해 URL을 바꿔가며 요청하지 않는다.

## 배포와 07:57 이후 확인

- SEC 집중 검사 10개 묶음 134개 테스트가 통과했다. 마지막 CIK 범위 보완 후 해당 수집 테스트 24개를 다시 통과했다. 서로 겹치는 검사이므로 두 수를 합산하지 않는다.
- worker 타입 검사·최종 빌드, 변경 TypeScript의 ESLint·Prettier, diff 검증을 통과했다.
- 기존 배포 산출물을 비공개 임시 디렉터리에 백업한 뒤 07:57 KST worker를 재시작했다. PID `227686`, PM2 `online`, 실제 환경의 User-Agent는 기존 환경 파일과 일치했다. API PID `187188`은 유지했다.
- 배포 산출물 SHA-256: 접근 정책 `eeb3887de162b699d005ac516daedb466ade48dcc9f5c0bbf3ef71dee0732d46`, 공시 수집 `f62ed2e6b2ae917e62c3ff12a5b6a4511315a151cd5f07b735cd07c57db55d30`, 원문 수집 `e30e3a8c259db8c546c4520467083f74a420b312fc5b440d6694c6e44a04cf74`.

07:57:41 KST (`2026-09-08T22:57:41.534Z`) 새 정책을 사용하는 단일 NVIDIA companyfacts 진단은 다시 HTTP 403 / `SEC_UNDECLARED_AUTOMATION`이었다. User-Agent 직렬화 일치, TLS 1.3 인증서 검증 정상, `AkamaiGHost`, 응답 헤더 도착 99ms, `Retry-After` 없음이었다. 오류 본문 전체와 참조번호 1개를 이번에는 확보했다. 비공개 진단 이력과 `/tmp/orsem-sec-error-response.txt`에 권한 `0600`으로 저장하고 문의 초안을 갱신했다. 이전 07:37 기록도 별도 파일로 보존했다.

연속 거부는 3회로 저장됐고 다음 요청 가능 시각은 `2026-09-08T23:37:41.634Z` (08:37:41 KST), 40분 뒤다. 07:58 DB 재조회에서도 목록·XML 처리·재무 snapshot은 모두 0건이었다. 이 진단으로 실제 수집 성공 상태를 기록하지 않았다. 원인 확인과 데이터 복구는 계속 미완료이며, 문의 메일도 아직 발송하지 않았다.

추가 UI 개선 여지는 남아 있다. 재무 API의 현재 안내는 실패 체크포인트를 읽지 않아 '접근 대기'와 '확인된 자료 없음'을 명확히 구분하지 못한다. 이번에는 API·화면을 변경하지 않았다. 재무 실패 체크포인트의 `lastSuccessAt`는 기존 구현에서 실패 후 24시간 대기의 기준 시각으로 재사용되므로 재무 데이터의 마지막 성공으로 집계하면 안 된다.
