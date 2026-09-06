# SEC·뉴스 수집 변경 전 분석 — 2026-09-06

## 확인한 현재 동작

- SEC는 공식 data.sec.gov Submissions JSON을 사용한다. CIK별로 묶지만 최근 20건만 선택한다. `SUBMISSIONS:CIK:*` 체크포인트에는 baselineComplete만 저장한다. 과거 `filings.files`를 따라가지 않으므로 장기 중단·20건 초과 유입을 복구할 수 없다.
- SEC 403/429는 `SEC/ACCESS_COOLDOWN`에 저장하고 최소 10분간 미호출한다. 요청 간격은 프로세스 내부 250ms라 여러 worker의 전체 호출량을 제한하지 못한다. User-Agent는 서버 요청에 전달한다.
- SEC SourceItem을 저장한 트랜잭션에서 회사별 FILING_RECEIPT EventCluster를 만든다. ownership 거래 사실은 아직 없다. 기존 receipt는 유지하고 accession별 ownership 관측 하나와 거래 행들을 별도로 저장할 수 있다.
- GDELT는 DOC 2.0 artlist를 사용한다. 요청서와 달리 현재 코드는 1시간이 아닌 최근 **24시간**, 쿼리당 250건이다. 여러 쿼리가 모두 끝나야 저장을 시작한다. 체크포인트·포화 구간 분할이 없어 일부 성공 후 429가 나면 해당 실행 결과가 저장되지 않는다.
- GDELT 도메인은 선택 필터이며 승인 정책 레지스트리는 비어 있다. 현재 일반 메타데이터 정책만 적용하므로 이번 요청의 publisher별 승인 조건을 충족하지 못한다. 승인 없는 네트워크 호출부터 차단해야 한다.
- publishedAt은 GDELT에서 null, seendate는 observedBySourceAt, Orsem 저장 관측은 firstObservedAt이다. 이 구분을 유지한다.
- RSS/IR은 본문 권리 프로필과 안전 XML/SSRF 제한을 거친다. 모든 항목 저장 뒤 HTTP validator를 확정한다. 새 복구 구조도 이 순서를 따른다.
- SourceItem의 공급자별 externalId/rawHash, NewsArticle의 canonical URL, NewsCompanyRelevance를 재사용한다. 다른 공급자 발견 기록을 하나의 SourceItem으로 합치지 않는다.
- Alpaca는 자산 식별에만 사용하며 가격은 Toss다. optional News API를 별도 이름과 권리 게이트로 추가할 수 있다. 키 존재만으로 News 사용 권한을 인정하지 않는다.

## 구현 경계

1. adapter가 복구 가능한 작은 배치를 생성하고 서비스가 항목·관계·receipt 저장 후 체크포인트를 확정한다. 실패 시 해당 배치를 다시 읽는다. DB revision 비교로 경쟁 worker의 오래된 진행 상태 덮어쓰기를 차단한다.
2. SEC는 recent 전체와 과거 제출 파일을 순회한다. 최초/명시적 BACKFILL은 무알림이다. 요청 예산에 걸리면 파일 커서를 보존한다. 기존 accession은 DB에서 중복 제거한다.
3. ownership XML은 receipt와 별도 재시도 단위로 처리한다. 원문 XML 자체를 DB/저장소에 보관하지 않고 해시·출처·구조화 사실을 기록한다. 실패해도 receipt는 유지한다.
4. GDELT는 UTC 명시 구간, 겹침, 250건 포화 분할과 진행 중 구간을 기록한다. 최소 15분 구간에서도 포화되면 완전 수집으로 표시하지 않는다. 승인 레지스트리에 실제 근거 없는 도메인을 추가하지 않는다.
5. Alpaca는 기본 비활성·권리 미승인 차단 어댑터로 제공한다. 계약 검토 없이 실제 유료 호출·공유·AI 사용을 활성화하지 않는다.
6. 기존 SourceCheckpoint/EventCluster JSON을 재사용한다. 필요 없는 스키마 변경은 하지 않는다. 원문 날짜, provenance, 권리, 번역 및 관리자 수정본을 보존한다.

## 검증·운영 분리

현재 작업 트리에는 이전 미배포 번역 편집 기능을 포함한 변경이 많다. `/tmp/orsem-recovery-baseline`에 비밀 파일을 제외한 시작 상태를 보존했다. 운영 프로세스가 저장소 dist를 사용하므로 `/tmp/orsem-recovery-check`에서 빌드·테스트한다. 운영 .env, PM2, DB 마이그레이션은 이번 개발 중 변경하지 않는다. 실제 SEC 403/GDELT 429 해소는 합성 응답 테스트 성공과 별개로 보고한다.

검증 중 별도 관심종목 작업의 수정이 계속 유입되어 최종 검증은 시작 스냅샷에 이번 파일만 적용한 `/tmp/orsem-recovery-final`로 옮겼다. 기존 포맷 문제는 이 복사본에서만 정규화했다. 최종 결과 문서의 검증 범위를 따른다.
