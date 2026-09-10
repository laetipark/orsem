# SEC 공시 수집 운영

이 문서는 Python 워커의 SEC 기업 식별자(CIK) 연결과 공시 접수 수집을 설명한다. 전체 미국 상장종목의 CIK 연결과 실제 공시 수집 범위는 서로 다르다. 공시 수집은 관심기업 중심이며, 과거 전체 공시를 내려받는 작업이 아니다. 날짜가 붙은 실행 기록은 당시 결과이며 현재 상태는 운영 CLI와 [배포 문서](DEPLOYMENT.md)로 확인한다.

## 공식 출처와 정기 작업

| 작업             | 출처 / 범위                                                                                                              | 실행 시각                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| CIK 마스터 연결  | [SEC ticker/exchange 마스터](https://www.sec.gov/files/company_tickers_exchange.json), 등록된 상장 NASDAQ·NYSE·AMEX 기업 | 매일 07:25 KST, `sec-cik-master-daily`        |
| 최근 공시 수집   | `https://data.sec.gov/submissions/CIK{10자리 CIK}.json`, P1·P2 관심기업                                                  | 10분마다, `sec-submissions-p1-p2-ten-minutes` |
| 명시적 초기 수집 | `BACKFILL` 작업에 지정한 기업 ID                                                                                         | 운영자가 실행할 때                            |

정기 작업은 `Asia/Seoul` 시간대를 사용한다. SEC submissions 요청은 발행인 CIK별로 묶고 최근 목록 전체를 검증한다. 같은 CIK를 공유하는 주식 종류 때문에 같은 발행인을 반복 요청하지 않는다. 최초 기준선 구축이나 누락 복구 시 과거 submissions 파일을 요청 예산 안에서 순회하며, 자세한 커서·알림 규칙은 [SEC_GAP_RECOVERY.md](SEC_GAP_RECOVERY.md)를 따른다.

기업 재무정보의 `companyfacts` 조회는 worker 시작 시와 이후 15분마다 최대 4개 회사를 처리한다. 이 조회도 아래 공유 접근 정책을 사용하므로, submissions 큐만 중지해도 모든 SEC 요청이 중지되는 것은 아니다.

`SEC_USER_AGENT`가 없으면 SEC 커넥터만 비활성화한다. 실제 설정값, 자격증명, 원본 응답은 이 문서나 저장소에 기록하지 않는다.

## CIK 연결과 보존 규칙

`market.masters.SecCikMaster.sync()`는 공식 마스터를 한 번 가져와 대상 기업에 적용한다. payload의 `companyIds`를 생략하면 현재 등록된 미국 상장기업이 대상이다.

- 거래소와 티커가 정확히 일치하는 행을 우선한다. 거래소까지 일치할 때에만 티커의 점과 하이픈을 동등하게 취급한다. 주식 종류 접미사는 제거하지 않는다.
- 후보가 서로 다른 CIK를 가리키면 모호한 연결로 건너뛴다. 기존 CIK 또는 기존 적용 이력과 충돌하면 덮어쓰지 않는다.
- 회사명 `nameKo`·`nameEn`, 티커, 상장 상태를 변경하지 않는다.
- 여러 주식 종류가 한 발행인의 CIK를 공유할 수 있다. `AllowSharedCompanyCik1788398000000` 마이그레이션은 CIK의 고유 인덱스를 일반 인덱스로 바꾼다. 롤백 시 중복 CIK가 있으면 데이터를 삭제하지 않고 고유 인덱스 복원을 거절한다.

마스터 원본 필드, 출처 URL, SHA-256, 수집 방식, 원본 수정 시각, 최초 관측 시각과 적용 결과는 DB 체크포인트에 보존한다. 시각은 UTC로 저장하며 날짜만 있는 필드는 날짜로 유지한다.

| 체크포인트                              | 의미                                                    |
| --------------------------------------- | ------------------------------------------------------- |
| `SEC_EDGAR / CIK_TICKER_MASTER`         | 공식 HTTP 응답으로 취득한 마스터                        |
| `SEC_EDGAR / CIK_SEARCH_CACHE:{sha256}` | 명시적으로 가져온 검색 캐시 추출물                      |
| `SEC_EDGAR / CIK_MAPPING:{companyId}`   | 기업별 원본 후보, 일치 규칙, 적용/충돌 결과와 취득 근거 |
| `SEC / SUBMISSIONS:CIK:{cik}`           | 발행인별 초기 기준선 완료와 최근 성공 시각              |
| `SEC / ACCESS_COOLDOWN`                 | SEC 접근 제한 상태와 재시도 가능 시각                   |

## 검색 캐시를 통한 제한적 초기 연결

공식 마스터에 직접 접근하지 못할 때 확보한 검색 캐시 추출물은 직접 HTTP 응답과 구분한다. 자동 정기 작업의 출처는 계속 공식 마스터 URL이며, 캐시 가져오기는 별도 명시적 작업이다.

2026-09-05 초기 연결에 사용한 추출물은 BE·MSFT·NVDA의 완전한 행 3개만 포함했다. 전체 마스터가 아니며 캐시 나이는 알 수 없었다. 당시 3개 기업의 운영 CIK 연결은 완료했으나 실시간 submissions 교차 검증과 실제 공시 수집은 미완료였다. 이 기록을 현재 수집 상태로 사용하지 않는다.

| 티커 | 거래소 | 캐시에 기록된 CIK |
| ---- | ------ | ----------------- |
| BE   | NYSE   | `0001664703`      |
| MSFT | Nasdaq | `0000789019`      |
| NVDA | Nasdaq | `0001045810`      |

추출물은 저장소 밖에서 관리한다. 당시 작업 파일은 `/tmp/orsem-sec-cached-master.json`이며 현재 파일의 존재나 운영 반영 상태를 보장하지 않는다. 취득 메타데이터는 `method: SEARCH_CACHE_EXTRACT`, `coverage: SELECTED_ROWS_ONLY`, `cacheAge: UNKNOWN`, `sourceLastModified: null`, `liveIssuerValidation: NOT_COMPLETED`를 보존한다. `extractedAt`은 캐시 생성 시각이 아닌 추출 시각이다. SHA-256도 HTTP 원문이 아닌 추출 JSON 기준이다.

명시적 Python 진입점은 `SecCikMaster.sync({"companyIds": [...]}, cache=cache)`다. 비어 있지 않은 기업 ID 목록을 요구하며, 캐시가 선택한 모든 대상에 모호함 없이 대응하지 않으면 적용을 거절한다. 부분 캐시에 없는 다른 기업을 미매칭으로 기록하지 않는다. 이 메서드는 네트워크 요청을 하지 않고, 원본 HTTP 응답을 흉내 내는 방식으로 가져오지 않는다. 직접 취득한 응답은 별도로 `DIRECT_HTTP / HTTP_RESPONSE_TEXT`로 기록한다.

## 공시 이벤트와 알림

SEC accession number를 기준으로 공시 출처 항목을 중복 제거하고, 같은 CIK의 관련 기업마다 공시 접수 이벤트를 연결한다. 이벤트의 의미는 `FILING_RECEIPT`, 유형은 `OTHER`이며 요약은 `SEC {form} 공시 접수 · {filingDate}`다. Form 4를 발견했다는 사실만으로 내부자 매수·매도나 시장 매수를 추론하지 않는다.

`filingDate`·`reportDate`, `acceptanceDateTime`, `primaryDocument`, accession number와 제공된 원본 행 필드를 보존한다. 원본 필드 보존에 크기 제한이 적용되면 `originalFilingTruncated`로 표시한다. 명시적 시간대가 있는 접수 시각만 `publishedAt`으로 사용하고, 날짜만으로 발생 시각을 만들지 않는다. 이벤트의 `occurredAt`은 `null`이며 출처의 최초 관측 시각은 재수집해도 유지한다. 권리 모드는 `OFFICIAL_PUBLIC_DATA`다.

발행인의 첫 성공 수집은 기준선으로 처리해 알림을 보내지 않는다. 기준선 완료는 `SUBMISSIONS:CIK:{cik}`에 기록한다. 모든 `BACKFILL`도 알림을 억제한다. 작업 스키마는 SEC 단독 커넥터, 비어 있지 않은 기업 ID 최대 100개, 빈 우선순위 목록, `suppressAlerts: true`를 요구한다. 이후 정기 수집에서 새로 관측한 항목은 기존 알림 조건을 적용한다.

## 접근 제한과 상태 판정

모든 SEC GET 요청은 DB에서 1초 간격의 요청 슬롯을 예약하며, 같은 DB를 쓰는 worker·수집 경로가 이 제한을 공유한다. 403·429 응답을 받으면 `ACCESS_COOLDOWN`에 대기 상태와 연속 거부 횟수(`consecutiveFailures`)를 저장한다. 대기 시간은 10·20·40·80·160·320분으로 늘어나며 이후 최대 6시간이다. 유효한 `Retry-After`나 기존 대기 시각이 더 늦으면 이를 유지한다. 프로세스 재시작 뒤에도 횟수와 대기가 보존되며, 횟수가 없는 기존 거부 기록은 1회로 해석한다.

실제 SEC 2xx 응답이 오면 연속 거부 횟수를 초기화하되, 해당 요청 뒤에 발생한 새 거부 기록과 기존 대기 시각은 덮어쓰지 않는다. 대기 중 생략한 요청·타임아웃·그 외 오류는 횟수를 초기화하지 않는다. 대기 중에는 SEC 요청을 보내지 않으며, 체크포인트 조회·저장 실패도 요청을 계속하는 근거로 삼지 않는다.

거부 이후 대기가 끝나면 DB의 30초 복구 요청 권한을 한 worker가 획득한다. 응답 대기 중 다른 worker는 요청하지 않으며, 권한 만료 시각에 요청도 중단한다. 소유자만 권한을 해제하고, 프로세스 중단 시에도 권한은 만료된다. 이 2xx 확인은 접근 통제 단계이며 데이터 저장·재조회 검증을 대신하지 않는다.

공시 목록과 내부자 거래 원문 처리는 별도 상태로 보존한다. 원문의 재시도 대기·회차 상한으로 남은 문서가 있으면 SEC 전체 `DEGRADED`를 유지하고 마지막 전체 성공 시각을 전진시키지 않는다. 자세한 요청 통제 범위와 복구 기준은 [SEC_RECOVERY_AUDIT_2026-09-09.md](SEC_RECOVERY_AUDIT_2026-09-09.md)에 기록했다.

프록시, User-Agent 회전, 우회 요청으로 제한을 피하지 않는다. 오류 응답 본문은 보존하거나 출력하지 않는다. 운영자는 기록된 재시도 시각 이후 실제 worker 경로의 결과를 확인한다. 독립 HTTP 점검 결과와 worker의 실제 수집 결과는 구분해서 기록한다.

SEC 상태는 실제 수집 결과를 사용한다. 이전의 단일 기업 상태 점검이나 빈 수집 범위가 `HEALTHY`를 만들던 판정을 수정했다. 첫 수집 결과가 없으면 `DEGRADED`이며, 범위가 비었거나 유효한 CIK가 누락된 경우도 `DEGRADED`로 표시한다. 요청 없이 끝난 실행은 성공 시각을 새로 기록하지 않는다. 상태 점검은 SEC에 별도 probe를 보내거나 더 최근 수집 상태를 덮어쓰지 않는다.

## 운영 명령

운영에서는 설치된 Python worker wheel과 기존 외부 환경 설정을 사용한다. 수집 명령은 기존 worker 큐로 작업을 보내므로 Python worker와 Redis, 대응하는 스키마·JobScheduler가 준비되어 있어야 한다. CLI 자체는 정기 워커나 스케줄러를 시작하지 않는다.

```sh
export ORSEM_REPO_ROOT=/home/laeti/orsem
/home/laeti/orsem-data/worker/current/bin/python -I -B -m orsem_worker.cli collect-sec --status
/home/laeti/orsem-data/worker/current/bin/python -I -B -m orsem_worker.cli collect-sec --verify
```

| 옵션             | 동작                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `--status`       | DB 집계만 읽고 종료한다. 큐 작업과 SEC 요청을 만들지 않는다.                               |
| 옵션 없음        | 전체 미국 상장기업의 공식 CIK 연결 후, 아래 명시적 범위에 최근 공시 `BACKFILL`을 실행한다. |
| `--verify`       | 수집을 한 번 더 실행해 기존 최초 관측 시각과 알림 억제 불변식을 확인한다.                  |
| `--collect-only` | CIK 마스터 연결을 생략하고 이미 연결된 대상만 수집한다. 캐시를 자동으로 가져오지는 않는다. |

`--collect-only --verify`를 함께 사용할 수 있다. 개발·격리 후보는 `python3 scripts/worker.py cli collect-sec ...`로 실행한다. 이 wrapper는 저장소 소스를 사용하며 운영 wheel 실행과 구분한다. [전체 Python CLI 안내](PYTHON_WORKER.md#운영-cli)를 참고한다.

수동 명령의 공시 범위는 현재 상장된 미국 기업 중 P1·P2 관심기업, 활성 IR 등록기업, 최근 24시간 이내 TOSS `PRICE_BARS` 성공 체크포인트가 있는 기업의 합집합이다. 이 중 CIK가 있는 기업만 최대 100개씩 순차 `BACKFILL`한다. 전체 등록기업을 대상으로 공시를 일괄 수집하지 않는다.

CLI는 실행 전 두 SEC 정기 작업이 각각 한 개씩 등록되어 있는지 검사한다. 제출 작업은 자동 재시도 없이 실행하며, 최대 10분 기다리고 15초 간격으로 진행 상태를 출력한다. DB 직접 연결은 읽기 전용이고 변경은 기존 worker 작업으로 수행한다. 종료 시 자신이 만든 종료 상태의 작업을 정리하고 DB·큐 연결을 닫는다.

출력은 등록기업 수, 연결기업 수, 발행인 수, SEC 공시 출처 항목 수, 이벤트 수, 관련 push delivery 수, 마지막 관측 UTC 시각과 범위별 티커를 포함한다. `--status` 또는 실행 실패 시 저장된 수집 상태와 별도 접근 제한 체크포인트, UTC·KST 재시도 가능 시각도 출력한다. 자격증명과 원문 공시를 출력하지 않으며 오류는 정제된 코드로 반환한다. `filings` 집계는 `source_items`의 SEC 항목 수이며 OpenDART `filings` 테이블 수가 아니다.

`--verify`의 성공 조건은 기존 `firstObservedAt` 변경 0건과 SEC push delivery 증가 0건이다. 실제로 새 공시가 게시될 수 있으므로 재수집 중 항목 증가 자체를 실패로 간주하지 않는다. 실제 수집 결과가 `HEALTHY`가 아니거나 공시·이벤트가 모두 준비되지 않으면 CLI는 실패를 보고한다. 동시 정기 작업이 실행되는 환경에서는 알림 수 변화 등 집계의 출처도 함께 확인한다.

## 과거 실행 기록 — 2026-09-05 00:06 KST

기업번호 연결과 수집 기능 배포는 완료했으나 SEC 서버의 요청 거부로 실제 공시 수집은 미완료다. 아래 수치는 마지막 수집 시도 후 `--status`로 운영 DB를 확인한 결과다.

| 항목                             | 확인 결과                                                                   |
| -------------------------------- | --------------------------------------------------------------------------- |
| 등록 미국 기업                   | 8,766개                                                                     |
| CIK 연결                         | BE·MSFT·NVDA 3개, 나머지 8,763개 미연결                                     |
| 연결 출처                        | 공식 마스터의 검색 캐시 행 3개, 부분 목록·캐시 나이 불명·실시간 검증 미완료 |
| SEC 공시 출처 항목 / 접수 이벤트 | 각각 0건                                                                    |
| SEC push delivery                | 0건                                                                         |
| 실제 수집 상태                   | `DEGRADED`, HTTP 403, 성공 시각 없음                                        |
| 운영 재수집 불변식 검증          | 첫 수집 실패로 실행하지 못함. 관련 자동 테스트는 통과                       |
| 정기 작업                        | CIK 마스터 매일 07:25 KST, P1·P2 공시 10분마다. 각각 1개 등록 확인          |

2026-09-05 00:00 KST 정기 수집은 기존 대기 상태에 따라 실제 HTTP 요청 없이 `DEGRADED`로 기록되었다. 최소 10분 대기가 종료된 뒤 `--collect-only --verify`를 실행했으며, 00:05:55 KST(2026-09-04 15:05:55 UTC) 실제 요청도 HTTP 403으로 거부되었다. 추가 연속 요청은 하지 않았다. 접근 제한 체크포인트의 다음 재시도 가능 시각은 00:15:55 KST(2026-09-04 15:15:55 UTC)이며, 이후 정기 작업도 이 시각을 준수한다. 이 시각은 접근 복구를 보장하지 않는다.

공식 전체 마스터도 직접 접근이 거부되어 전체 CIK 연결을 완료하지 못했다. 정기 마스터 연결과 관심기업 수집은 배포된 worker가 계속 수행한다. 수동 범위에만 포함된 기업의 첫 수집은 접근이 복구된 뒤 `--collect-only --verify`로 다시 확인해야 한다.

마이그레이션 적용과 API·worker·web 빌드를 완료했고, SEC 관련 집중 테스트 77개와 타입·ESLint 검사를 통과했다. 운영 화면에서 SEC 필터 0건, SEC 상태 지연·마지막 성공 기록 없음도 확인했다. 테스트 통과는 실제 SEC 수집 성공을 뜻하지 않는다.

## 구현 위치

- `apps/worker/python/orsem_worker/market/masters.py`: 공식 마스터·캐시 검증과 CIK 연결.
- `apps/worker/python/orsem_worker/connectors/discovery.py`, `providers.py`, `projections.py`: submissions 수집, 기준선·알림 억제, 접수 이벤트 연결.
- `apps/worker/python/orsem_worker/connectors/sec_access.py`, `health.py`: 공유 대기 정책과 실제 수집 기반 상태.
- `apps/worker/python/orsem_worker/disclosures/sec.py`: Form 3/4/5 원문 해석과 ownership 저장.
- `apps/worker/python/orsem_worker/scheduling.py`, `jobs.py`: 실행 주기와 명시적 수집 범위 검증.
- `packages/database/src/migrations/1788398000000-AllowSharedCompanyCik.ts`: CIK 공유 지원 마이그레이션.
- `apps/worker/python/orsem_worker/cli.py`: 운영 수집과 집계 검증 명령.
