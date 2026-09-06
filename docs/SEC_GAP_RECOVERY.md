# SEC Submissions 누락 복구

2026-09-06 구현. SEC 공식 Submissions가 1차 원본이다. [공식 API](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)는 키 없이 CIK별 최근 목록과 추가 JSON 파일을 제공한다. EDGAR Next 제출자 토큰은 공개 데이터 접근 403 해결용 키가 아니다.

## 저장 순서와 커서

`SUBMISSIONS:CIK:{10자리 CIK}` SourceCheckpoint를 재사용한다. 매 실행에서 recent 전체를 검증하고 accession을 SourceItem 외부 식별자로 쓴다. 최근 20건 제한을 복구 경로에 적용하지 않는다. 최초 baseline 또는 saved accession이 recent 밖으로 밀린 경우 `filings.files`를 순회한다. 파일명은 동일 CIK의 공식 submissions 이름만 허용한다.

한 issuer 실행의 기본 요청 예산은 recent를 포함한 4회다. `pendingFiles`와 `completedFiles`로 중단한 과거 파일부터 이어 간다. recent는 매번 다시 확인해 복구 중 신규 공시를 놓치지 않는다. `newestKnownAccession`, `lastFetchedAt`, `lastSourceFile`, `lastSuccessfulObservedAt`, `mode`, `incomplete`, `cursor`, `revision`을 저장한다. 파일 목록이 존재하는 최초 baseline은 마지막 파일까지 처리해야 완료된다. 기존 baselineComplete만 있는 체크포인트는 무알림 복구로 보강한다.

항목·뉴스 관계·FILING_RECEIPT 이벤트 저장 → 해당 배치 체크포인트 순서다. 항목별 트랜잭션 뒤 체크포인트를 확정하므로 중간 실패 시 이미 저장한 accession이 재등장할 수 있으나 유일 키로 중복 생성하지 않는다. DB revision 비교는 경쟁 worker의 오래된 커서 덮어쓰기를 차단한다. 정확히 한 번 HTTP 요청을 보장하지는 않는다.

최초·명시적 BACKFILL·과거 파일 배치는 알림을 억제한다. baseline 이후 scheduled recent의 새로 저장된 공시만 기존 알림 조건의 대상이다. XML ownership은 별도 재시도 단위이므로 receipt 커서와 분리한다.

## 전체 요청 제한

User-Agent는 실제 연락 가능한 애플리케이션 식별자+이메일이다. 모든 SEC GET은 기존 공통 transport를 거쳐 DB 잠금으로 250ms 요청 슬롯을 예약한다. 같은 DB를 쓰는 worker 간에도 공유한다. 슬롯 대기 후 cooldown을 재확인한다. 상태 DB가 없으면 호출하지 않는다. 여러 호스트 운영 시 시간 동기화가 필요하다.

403/429는 원인을 임의로 IP 차단 또는 속도 제한으로 단정하지 않는다. 최소 10분 또는 더 긴 Retry-After 동안 대기한다. HTTP 403, HTTP 429, 대기로 인한 미호출, 저장 실패를 구분한다. UA 변경·프록시 우회·대체 공급자 자동 전환을 하지 않는다.

## 운영 확인

- `SEC_BACKFILL_MAX_REQUESTS=4` (2–10), `SEC_FORM4_ENABLED=true`.
- `pendingFiles`가 줄고 `incomplete=false`가 되는지 확인한다. 마지막 성공은 완전한 해당 복구 단계가 끝난 뒤 갱신한다.
- 공식 응답 200, 실제 accession 저장, receipt 조회를 모두 확인하기 전 외부 연결 복구 완료로 표시하지 않는다.
- 이전 파일을 찾을 수 없거나 응답 배열 길이·CIK·경로 검증이 실패하면 커서를 진행하지 않는다. 운영자가 원인을 확인한 뒤 동일 커서를 재시도한다.
- 롤백은 worker를 중단하고 이전 산출물로 복원한다. 새 체크포인트 JSON과 기존 데이터는 삭제하지 않는다. 이전 worker는 새 복구 필드를 무시하므로 재배포 전 새 worker의 진행 상태를 검토한다.

## 민간 대안

[sec-api.io](https://sec-api.io/pricing)는 SEC와 별도 민간 서비스다. 기본 원본 교체나 자동 fallback은 구현하지 않았다. 추후 명시적 provider 선택과 별도 provenance를 가진 어댑터로만 추가한다. 계약·재배포 조건·비용·원본 대조가 선행되어야 한다. 이번 변경은 유료 키를 요구하지 않는다.
