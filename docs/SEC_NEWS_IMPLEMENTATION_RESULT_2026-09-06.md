# SEC·GDELT 수집 보강 및 미국 뉴스 공급자 구현 결과

검증 기준: 2026-09-06. 변경 전 분석은 [SEC_NEWS_IMPLEMENTATION_ANALYSIS](SEC_NEWS_IMPLEMENTATION_ANALYSIS.md), 운영 설정은 [OPERATIONS](OPERATIONS.md)를 참조한다.

## 1. 한 줄 결론

SEC accession 복구·Form 3/4/5 구조화 관측, GDELT 구간 복구, 기본 비활성 Alpaca News 어댑터를 기존 저장·큐 구조에 증분 구현했다. 운영 배포와 외부 연결 성공 검증은 아직 하지 않았다.

## 2. 기존 구현에서 확인한 문제

- SEC: 최근 20건 선택과 baseline 표시만으로 장기 중단·다량 공시를 복구할 수 없었다. 내부자 XML 사실은 없고 회사별 접수 이벤트만 있었다. 프로세스별 요청 간격만으로 여러 worker의 총량을 제한하기 어려웠다.
- GDELT: 실제 시작 코드는 요청서의 1시간이 아닌 24시간 조회였다. 250건 포화 구간 분할이나 지속 커서가 없고 뒤쪽 요청 실패 시 앞쪽 결과도 저장되지 않았다. 일반 데이터셋 정책이 개별 publisher 승인과 분리되지 않았다.
- 뉴스 공급자: Alpaca 자산 식별 키의 존재와 News 이용 권한·기사 공유 권리를 구분하는 별도 어댑터가 없었다.

## 3. 실제 변경

아래는 작업 시작 스냅샷에 대한 이번 변경 범위다. 기존 번역 편집·관심종목 기능 전체를 이번 구현으로 계산하지 않는다.

### Worker 구현

| 파일                                                     | 변경 내용과 이유                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/src/connectors/discovery-recovery.ts`       | 배치 계약, SourceCheckpoint revision·DB 잠금 확정. 항목 저장보다 커서가 먼저 진행되는 것을 방지한다.                  |
| `apps/worker/src/connectors/connector-adapters.ts`       | SEC recent 전체·과거 파일 복구, 필드·CIK·경로 검증. GDELT 명시 구간·정확한 publisher 승인·메타데이터 후보를 연결한다. |
| `apps/worker/src/connectors/gdelt-window-recovery.ts`    | 초기 계획·pendingWindows·overlap·250건 분할·최소 구간·요청 예산·불완전 상태를 구현한다.                               |
| `apps/worker/src/connectors/sec-access-policy.ts`        | 같은 DB를 사용하는 worker 전체의 250ms 요청 슬롯과 기존 403/429 대기를 결합한다.                                      |
| `apps/worker/src/sec/ownership-parser.ts`                | 안전 XML 검사, 원문 숫자·거래 코드·각주·파생 거래 행과 SHA-256을 보존한다. 분기 대조 인터페이스도 정의한다.           |
| `apps/worker/src/sec/ownership-ingestion.ts`             | 접수 후 독립 재시도, accession당 관측 하나, 사실·이벤트의 원자적 저장. 여러 share class의 중복 관측을 방지한다.       |
| `apps/worker/src/connectors/alpaca-news.connector.ts`    | 별도 뉴스 어댑터, 계정·무료 사용·publisher 승인 게이트, symbols·페이지 커서·429 대기. 본문/요약을 저장하지 않는다.    |
| `apps/worker/src/connectors/news-discovery.service.ts`   | 배치 저장 후 커서 확정, SEC 무알림 복구, ownership 후처리, 부분 진행 및 오류 보고를 연결한다.                         |
| `apps/worker/src/connectors/connector-health.service.ts` | SEC/Alpaca News 상태를 저장된 수집 결과에서 읽어 불필요한 probe를 피한다.                                             |
| `apps/worker/src/config/worker-config.ts`                | SEC 요청 예산, ownership 활성화, GDELT overlap·깊이, Alpaca News 비활성 기본값을 검증한다.                            |
| `apps/worker/src/queues/job-data.ts`                     | 기존 발견 작업에 별도 ALPACA_NEWS connector를 허용한다.                                                               |
| `apps/worker/src/processors/market-news.processor.ts`    | 기존 뉴스 큐에서 Alpaca News 작업을 처리한다.                                                                         |
| `apps/worker/src/scheduling/schedule-definitions.ts`     | 별도 30분 뉴스 일정과 활성화 조건을 추가한다.                                                                         |
| `apps/worker/src/scheduling/worker-scheduler.service.ts` | 기존 스케줄 등록·정리 흐름에 별도 공급자를 포함한다.                                                                  |

### API·설정

| 파일                                                | 변경 내용과 이유                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/resources/connector-public-status.ts` | 공개 가능한 상태·구간·관측 시각만 추출하고 원본 오류·키·쿼리를 노출하지 않는다.                                                       |
| `apps/api/src/resources/orsem-data.service.ts`      | 승인된 메타데이터 목록과 source 상태, GDELT 정책 차단 및 Alpaca News 표시를 연결한다. 일반 freshness에서 관리자 진단 문구도 제거한다. |
| `apps/api/src/resources/news-query.ts`              | GDELT/Alpaca의 publisher 승인 조건과 공식 본문 우선 URL 중복 처리를 적용한다.                                                         |
| `apps/api/src/resources/resource-mappers.ts`        | 메타데이터 기사를 EXTERNAL_LINK로 반환하고 가짜 본문·번역을 만들지 않는다.                                                            |
| `apps/api/src/resources/resource.controllers.ts`    | 기존 뉴스 source 필터에 ALPACA_NEWS 한 값을 추가한다. 다른 동시 작업의 controller 변경은 검증 복사본에 포함하지 않았다.               |
| `apps/api/src/search/search.service.ts`             | 검색에도 동일한 publisher 승인 조건을 적용한다.                                                                                       |
| `.env.example`                                      | 새 환경변수와 안전한 기본값을 문서화한다. 실제 `.env`는 수정하지 않았다.                                                              |
| `ecosystem.config.cjs`                              | 추후 배포 시 새 환경변수가 API/worker 실행 환경에 전달되도록 한다. PM2를 재시작하지 않았다.                                           |

### 테스트·문서

| 파일                                                | 변경 내용과 이유                                                                                                                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker/test/discovery-recovery.spec.ts`       | SEC 20건 초과·과거 파일·재시작, GDELT 분할·실패·포화, Alpaca 권리·페이지·인증 오류를 검증한다.                                                 |
| `apps/worker/test/sec-ownership.spec.ts`            | 다중 거래·파생/비파생·코드·정밀 숫자·가격 누락·각주·악성 XML·URL을 검증한다.                                                                   |
| `apps/worker/test/sec-ownership-ingestion.spec.ts`  | share class와 CIK 표기 차이, 중복 방지, XML·이벤트 저장 실패 시 receipt 보존을 검증한다.                                                       |
| `apps/worker/test/sec-access-policy.spec.ts`        | DB 공유 요청 슬롯과 403/429 대기를 검증한다.                                                                                                   |
| `apps/worker/test/sec-discovery.spec.ts`            | 복구 체크포인트를 지원하는 테스트 저장소로 갱신한다.                                                                                           |
| `apps/worker/test/gdelt-approved-fixture.ts`        | 합성 테스트 도메인의 승인만 격리해 제공한다. 운영 승인을 추가하지 않는다.                                                                      |
| `apps/worker/test/gdelt-metadata.spec.ts`           | 메타데이터 검증을 명시적인 시험용 승인 아래 실행한다.                                                                                          |
| `apps/worker/test/gdelt-rate-limit.spec.ts`         | 승인 전제 아래 기존 최소 간격과 429 회귀 검증을 유지한다.                                                                                      |
| `apps/worker/test/gdelt-http-transport.spec.ts`     | 합성 승인과 실제 factory 경로에서 연결·전체 응답 제한을 검증한다.                                                                              |
| `apps/worker/test/market-news-boundaries.spec.ts`   | 메타데이터·콘텐츠 경계 시험에 publisher 승인 전제를 반영한다.                                                                                  |
| `apps/worker/test/connectors.spec.ts`               | GDELT 네트워크 시험을 승인된 합성 구성으로 제한한다.                                                                                           |
| `apps/worker/test/schedules.spec.ts`                | 기존 GDELT와 새 Alpaca News 일정·비활성 동작을 반영한다.                                                                                       |
| `apps/api/src/config/app-config.spec.ts`            | 도메인 형식 검증과 수집 권리 승인이 다른 단계임을 검증한다.                                                                                    |
| `apps/api/src/resources/ir-source-policy.spec.ts`   | 미승인 GDELT 상태와 갱신한 사용자 문구를 반영한다.                                                                                             |
| `apps/api/src/resources/news-relevance.spec.ts`     | 승인 메타데이터의 다중 공급자 SQL과 공식 본문 우선 처리를 검증한다.                                                                            |
| `packages/database/src/transformers.spec.ts`        | 누락된 기존 그룹·뉴스 관계 마이그레이션을 역사 목록에 반영한다. 기존 목록 보존·추가 마이그레이션의 시간순·유일성·synchronize=false를 검사한다. |
| `docs/SEC_NEWS_IMPLEMENTATION_ANALYSIS.md`          | 구현 전에 실제 코드와 요청서의 차이를 기록했다.                                                                                                |
| `docs/SEC_GAP_RECOVERY.md`                          | 복구 커서·공유 제한·무알림·운영 확인을 설명한다.                                                                                               |
| `docs/SEC_OWNERSHIP.md`                             | 사실/파생 분류·안전성·재시도·분기 대조의 구현 경계를 설명한다.                                                                                 |
| `docs/NEWS_PROVIDER_COMPARISON.md`                  | 공식 문서로 API 기능·비용·권리를 비교하고 UNKNOWN을 구분한다.                                                                                  |
| `docs/NEWS_COLLECTION.md`                           | 승인 publisher 메타데이터와 구간 복구를 기존 수집 정책에 추가한다.                                                                             |
| `docs/SOURCES.md`                                   | 실제 구현한 공급자와 승인 조건을 갱신한다.                                                                                                     |
| `docs/RIGHTS.md`                                    | 계정 권한과 publisher 권리를 분리하고 기본 차단 조건을 설명한다.                                                                               |
| `docs/OPERATIONS.md`                                | 새 설정·배포 순서·상태 확인·복구 절차를 추가한다.                                                                                              |
| `README.md`                                         | 상세 구현·운영 문서로 연결한다.                                                                                                                |
| `docs/SEC_NEWS_IMPLEMENTATION_RESULT_2026-09-06.md` | 이번 결과, 검증 범위와 배포 전 확인 항목을 기록한다.                                                                                           |

## 4. SEC 개선 결과

- `SUBMISSIONS:CIK:{CIK}`에서 recent 전체를 확인하고 미저장 accession을 처리한다. 저장했던 최신 accession이 recent에 없거나 초기/명시적 BACKFILL이면 같은 CIK의 `filings.files`로 복구한다. 파일 목록이 복구 중 늘어나는 경우도 반영한다.
- 최초·과거 파일은 무알림이며 기본 issuer당 4요청으로 나누어 진행한다. 중단 시 남은 파일부터 재개한다. 완료된 정상 POLL에서는 기존 accession을 일괄 조회해 불필요한 재저장을 줄인다.
- Form 3/4/5 및 정정 XML을 구조화한다. 접수 이벤트를 유지하고 `OTHER` 유형의 `SEC_INSIDER_TRANSACTION` 관측을 accession당 하나 생성한다. 거래 행과 원문 코드·수량·가격·각주는 별도 사실로 보존한다.
- 요청 슬롯·403/429 대기는 DB에서 공유한다. receipt·관계 저장 후 커서를 확정하고 ownership은 자체 상태로 재시도한다.
- 실 SEC 서버의 200 응답·실제 DB 저장·운영 화면 확인은 이번 개발에서 실행하지 않았다. 기존 403이 해결됐다고 주장하지 않는다.

## 5. GDELT 개선 결과

- UTC `startdatetime/enddatetime`, 초기 24시간, 기본 10분 overlap이다. 최초 계획 저장은 성공 커서를 진행시키지 않는다.
- 원 응답이 정확히 250건이면 분할한다. 기본 깊이 4, 최소 15분, 실행당 12요청으로 제한한다. 끝까지 포화된 구간은 저장 가능한 항목을 저장하되 pending으로 유지한다.
- 성공 leaf만 커서를 진행한다. 뒤쪽 실패·429·저장 실패 후 재개하며, 약 3개월보다 오래된 미처리 구간은 건너뛰지 않고 별도 대조 필요로 보고한다.
- incomplete/truncated와 구간·커서를 저장하고 정상 완료로 숨기지 않는다. seendate는 공급자 관측 시각이며 publishedAt을 만들어 넣지 않는다.
- 현재 승인 레지스트리는 비어 있다. `GDELT_ENABLED=true`만으로는 요청하지 않는다. 실 HTTP 성공은 검증하지 않았다.

## 6. 뉴스 API 비교

| Provider    | 장점                                        | 단점                                    | 비용                                        | 권리                                      | Orsem 판단               |
| ----------- | ------------------------------------------- | --------------------------------------- | ------------------------------------------- | ----------------------------------------- | ------------------------ |
| Alpaca News | symbols·REST 페이지·과거 데이터·뉴스 스트림 | 계정 News 권한 별도, 제3자 기사 계약    | News 전용 무료량·최소 유료 요금 미확정      | 저장·공유·AI는 계약 검토 필요             | 어댑터 구현, 기본 비활성 |
| Marketaux   | 금융 entity·ticker 검색                     | 무료 반환 수 적음, 전문 미제공          | 무료 일 100요청/3기사, Basic 월 $29         | API별 장기 저장·공유 권리 확인 필요       | 차선 후보, 문서만        |
| GNews       | 범용 뉴스 검색·기간 조회                    | 무료 12시간 지연, ticker 전용 모델 부재 | 무료 일 100요청/10기사, Essential 월 €49.99 | 캐시·상업 이용 조건과 publisher 권리 별도 | 보완 후보, 문서만        |

월 결제·세금 제외. [Alpaca News 문서](https://docs.alpaca.markets/us/docs/historical-news-data), [재배포 FAQ](https://alpaca.markets/support/redistribute-alpaca-api), [Marketaux 가격](https://www.marketaux.com/pricing), [GNews 가격](https://gnews.io/pricing)을 기준으로 한다. 저장·캐시·AI·재배포·상업 이용·기간·페이지별 상세 근거는 [공급자 비교](NEWS_PROVIDER_COMPARISON.md)에 분리했다. 실제 계정 가입·구독·유료 호출은 하지 않았다.

## 7. 테스트 결과

검증 범위는 **작업 시작 스냅샷 + 이번 변경**이다. 운영 dist를 덮어쓰지 않도록 `../../../tmp/orsem-recovery-final`에서 실행했다. 수정이 계속 유입되는 현재 작업 트리 전체의 통합 성공이나 운영 검증을 뜻하지 않는다.

| 명령                             | 결과                                           |
| -------------------------------- | ---------------------------------------------- |
| `npm run format:check`           | 통과. 아래 기존 파일의 복사본 포맷 정규화 포함 |
| `npm run lint`                   | 통과                                           |
| `npm run typecheck`              | 통과                                           |
| `npm test`                       | 통과, 전체 1,468개                             |
| `npm run build`                  | 통과                                           |
| `npm run check:messenger-script` | 통과                                           |

전체 테스트 구성: scripts 33, API 264, Discord 4, 웹 259, worker 736, contracts 23, database 34, OpenDART parser 115개다. 마지막 XML 수신 바이트 해시·GDELT 설정 상태 보강 뒤에는 영향받는 worker의 typecheck/build와 전체 736개 테스트를 다시 실행해 통과했다. 복구·ownership 저장 집중 검증도 2개 suite/21개를 통과했다.

검증 로그는 `../../../tmp/orsem-recovery-final-*.log`, 집중 검증은 `../../../tmp/orsem-recovery-focused-final.log`에 있다. 이번 변경의 시작 스냅샷 기준 검토용 패치는 `../../../tmp/orsem-sec-news-recovery-2026-09-06.patch`다. 이 패치를 현재 작업 트리에 다시 적용하면 안 되며, 별도 배포 기반에 맞춰 검토해야 한다.

기존 포맷 문제 6파일은 검증 복사본에서만 정규화했다: `apps/worker/README.md`, `docs/CONNECTOR-SETUP-PLAN-2026-09-06.md`, `docs/CONNECTOR-VERIFICATION-2026-09-06.md`, `docs/DEPLOYMENT-2026-09-06-WATCHLIST-NEWS.md`, `packages/contracts/src/news-sources.ts`, `packages/contracts/src/schemas.ts`. 별도 작업의 진행 중인 room 구현을 이번 검증에 추가하지 않았다.

네트워크 응답·저장 실패는 합성 fixture와 테스트 저장소로 검증했다. 실제 MySQL 장애·다중 운영 worker 부하·실제 공급자 접속 시험을 대체하지 않는다.

## 8. DB migration

이번 기능을 위한 새 마이그레이션은 없다. 기존 SourceCheckpoint, SourceItem, EventCluster의 JSON 필드와 유일 키를 재사용한다. synchronize=false를 유지했고 운영 DB를 수정하지 않았다. 작업 트리에 있는 번역 편집·관심종목·room 마이그레이션은 이번에 새로 만든 것이 아니며 배포 대상 여부를 따로 판단해야 한다.

## 9. 운영 환경변수 변경

```dotenv
# 기존 SEC_USER_AGENT는 실제 연락 가능한 값이어야 한다.
SEC_BACKFILL_MAX_REQUESTS=4
SEC_FORM4_ENABLED=true

# 현재 publisher 승인 없음: 운영 활성화 전에 권리 근거 등록 필요
GDELT_ENABLED=false
GDELT_NEWS_DOMAINS=
GDELT_OVERLAP_MINUTES=10
GDELT_MAX_SPLIT_DEPTH=4

# 기존 자산 식별용 키만으로 News 권한을 인정하지 않는다.
ALPACA_NEWS_ENABLED=false
```

비밀값은 기존 저장소 외부 설정에서 관리한다. GDELT는 정확한 도메인과 `APPROVED_GDELT_SOURCE_POLICIES`의 승인 근거를 함께 요구한다. Alpaca는 `APPROVED_ALPACA_NEWS`의 계정 News 권한·무료 사용 확인 기한·publisher별 승인도 필요하다. 이 레지스트리는 현재 null이다. 실제 운영 `.env`는 바꾸지 않았다.

## 10. 아직 하지 않은 것 / 미검증 항목

- SEC 실제 접속 200·공시 저장·화면 확인, GDELT 실제 구간 조회와 429 해소.
- Alpaca 현재 계정의 News entitlement·무료 사용량·장기 저장·승인 회원 공유 계약 확인. 실제 기사를 수집하거나 요약/번역하지 않았다.
- ownership 거래 행 전용 상세 UI. 현재는 기존 이벤트 요약과 구조화 JSON 기반이다. 다중 share class 관측의 dedicated 종목별 상세 표시도 후속 범위다.
- 분기 데이터 자동 다운로드·ZIP importer·대조 실행. 인터페이스와 설계만 있다.
- sec-api.io·Marketaux·GNews 실연동. 문서 후보이며 자동 fallback은 없다.
- 운영 배포, PM2 재시작, 실제 DB migration, 운영 성능 시험.
- 커밋: 기존 미커밋 변경과 다른 진행 중 작업이 있어 이번에 혼합 커밋을 만들지 않았다. 배포할 기반 커밋 확정 후 이번 범위의 diff를 검토해야 한다.

## 11. 배포 전 체크리스트

1. 운영 커밋·현재 산출물·기존 미배포 기능의 차이를 대조하고 이번 변경만 포함할 기반을 확정한다. 그 기반으로 전체 검증 명령을 다시 실행한다.
2. DB와 실행 산출물을 백업한다. 이번 자체 마이그레이션은 없으므로 다른 작업의 마이그레이션을 묶어서 실행하지 않는다.
3. SEC 연락처와 공통 transport·DB 연결을 확인한다. 낮은 요청 예산으로 API/worker를 배포하고 200 응답·accession·접수 이벤트·ownership 재시도를 확인한다.
4. GDELT/Alpaca는 승인 근거가 확보될 때까지 끈다. 승인 후에도 한정된 대상에서 커서·중복·불완전 상태를 먼저 확인한다.
5. `/api/v1/sources`와 관리자 진단에서 성공·실패·미호출·다음 재시도·구간 진행을 대조한다. 공개 상태에 키나 원본 오류가 없는지 확인한다.
6. 오류가 나면 새 일정·worker를 중단하고 이전 산출물로 복원한다. 새 JSON 사실·접수·번역·관리자 수정본과 커서를 삭제하지 않는다.

## 12. 권장 다음 작업

첫째, 배포 기반을 분리한 뒤 SEC 공식 경로 하나의 실제 200 응답과 저장·조회까지 확인한다. 둘째, ownership 거래 행을 사람이 검수할 상세 화면과 분기 대조 importer를 추가한다. 셋째, Alpaca News 계정 권한과 publisher 계약이 확인되면 합성 테스트와 별도로 소량의 운영 수집을 검증한다. GDELT는 승인 가능한 publisher를 확보한 뒤 활성화한다.
