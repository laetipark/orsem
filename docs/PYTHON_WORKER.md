# Python 워커

Python 3.12 워커의 설치·검증·운영 명령입니다. 현재 전환 상태와 날짜별 기록은 [배포 문서](DEPLOYMENT.md#python-워커-전환-상태)를 기준으로 확인합니다.

## 실행 환경

API·웹·Discord·공통 계약과 마이그레이션은 Node.js 24/npm workspace를 유지합니다. 워커는 `apps/worker/python/orsem_worker`의 Python 코드로 실행하며 JavaScript 작업 실행 브리지를 사용하지 않습니다.

저장소 루트에서 개발 환경을 준비합니다.

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r apps/worker/python/requirements-dev.lock
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
python3 scripts/worker.py start
```

`scripts/worker.py`는 `ORSEM_WORKER_PYTHON`이 지정되면 해당 실행 파일을 사용합니다. 생략하면 루트 `.venv/bin/python`, `apps/worker/python/.venv/bin/python`, 호출한 Python 순서로 선택합니다. Python 버전과 의존성을 갖춘 환경을 선택해야 하며 이 실행기가 패키지를 자동 설치하지는 않습니다.

워커는 공용 루트 `.env`와 기존 외부 자격 증명 파일을 사용합니다. `ORSEM_REPO_ROOT`는 환경 설정을 찾을 저장소 루트입니다. API 키, 연결 비밀번호, 원문, 로그와 감사 산출물은 저장소 밖에 보관합니다. 자격 증명이 없으면 해당 커넥터만 비활성화하며 운영 환경에 fixture를 자동으로 넣지 않습니다.

운영 의존성은 SHA256이 포함된 `requirements.lock`으로 고정합니다. 배포용 별도 환경에서 다음 형태로 설치하고, 검증한 wheel은 `--no-deps`로 설치합니다. 설치할 wheel과 의존성 파일의 해시는 배포 명세에 기록합니다.

```bash
/path/to/release/bin/python -m pip install --require-hashes -r apps/worker/python/requirements.lock
/path/to/release/bin/python -m pip install --no-deps /path/to/verified/orsem_worker-0.2.0-py3-none-any.whl
```

`/path/to/...`는 배포 명세의 실제 절대 경로로 바꿉니다. 실행 중인 `worker/current` 환경을 직접 수정하지 않고 새 버전 환경을 설치·검증한 뒤 연결을 전환합니다. PM2는 `/home/laeti/orsem-data/worker/current/bin/python`에 `-m orsem_worker`를 전달하며 `interpreter: none`, 단일 fork 인스턴스, `kill_timeout: 660000`을 사용합니다. 변경한 `ORSEM_DATA_DIR`을 사용하면 해당 데이터 디렉터리 아래의 `worker/current`가 기준입니다.

## 검증

운영 프로세스가 사용하는 `apps/*/dist`, `packages/*/dist`에 빌드 결과를 덮어쓰지 않습니다. 설치한 개발 Python을 명시한 뒤 격리 검증기를 실행합니다.

```bash
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
python3 scripts/verify-in-isolation.py
```

검증기는 현재 추적 파일과 새 소스 파일을 임시 복사본으로 옮기고 `npm run check`, `npm run build`를 실행합니다. 루트 비밀 환경 파일은 복사하지 않습니다. TypeScript workspace 링크는 검증 복사본을 가리키며 Python은 지정한 개발 환경을 사용합니다. 이 명령은 배포·마이그레이션·운영 프로세스 재시작을 수행하지 않습니다.

Python 범위만 점검할 때는 다음 명령을 사용합니다.

```bash
python3 scripts/worker.py lint
python3 scripts/worker.py typecheck
python3 scripts/worker.py test
```

`build` 명령은 Python wheel을 생성하므로 격리 복사본에서 실행합니다. MySQL·Redis 통합 검사는 `ORSEM_TEST_DATABASE_URL`과 `ORSEM_TEST_REDIS_URL`로 폐기 가능한 인스턴스를 명시한 경우에만 실행합니다. 테스트별 조건을 확인하고 운영 DB·Redis URL을 넣지 않습니다. 실제 공급자 연결 성공은 합성 테스트 통과와 별도로 확인합니다.

## 코드와 저장 계약

| 위치                                     | 책임                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `disclosures/`                           | OpenDART 목록·법인 동기화, ZIP/XML 처리, D001–D005 추출, 검토·AI 감사, 조회용 데이터 반영, SEC ownership |
| `connectors/`                            | SEC·뉴스 수집, 권리·예산·체크포인트, AI 클라이언트, 뉴스 제목·요약 번역                                  |
| `market/`                                | 토스 가격·실시간 시세·기업 정보, 시장 선정, 식별 정보                                                    |
| `core.py`, `storage.py`, `schema.json`   | 기존 MySQL 테이블과 트랜잭션, JSON·날짜·정밀 수치 변환                                                   |
| `jobs.py`, `runtime.py`, `scheduling.py` | 기존 JSON 작업 검증, BullMQ 큐 실행, 정기 JobScheduler                                                   |
| `outbox.py`, `push.py`, `alert_gate.py`  | DB outbox, 전달 재시도, 현재 공시·계정·종목별 알림 설정 확인                                             |
| `cli.py`, `admin_cli/`                   | 명시적 일회성 운영·감사 명령                                                                             |

DDL은 `packages/database`의 마이그레이션이 관리합니다. Python 워커는 스키마를 자동 생성하거나 TypeORM `synchronize`를 활성화하지 않습니다. 기존 큐 이름·접두사·작업 ID 규칙·DB 식별자·체크포인트를 보존합니다. 정기 스케줄 전환은 배포 명세의 관리 대상만 바꾸며 일반 대기·실행·지연 작업을 일괄 삭제하지 않습니다.

BullMQ Python은 `2.26.0`으로 고정합니다. 이 버전의 워커는 JobScheduler의 다음 회차를 자동 등록하지 않으므로 작업 처리 전에 기존 Lua의 producer ID 검사를 통해 다음 회차를 등록합니다. 응답 유실·재시도에도 동일 회차가 중복 생성되지 않는지 실제 Redis 테스트로 확인합니다. `runtime.Worker`는 같은 버전의 실행 루프를 보완해 종료 시 모든 처리 작업이 끝날 때까지 잠금 갱신을 유지합니다. 라이브러리 버전을 바꿀 때는 일반 작업·재시도·지연 전환·반복 실행·동시 작업 종료 통합 검사를 함께 실행해야 합니다.

D001·D002·D005의 사실을 합치지 않고 양수 수량만으로 장내매수를 추론하지 않습니다. 원본 필드·문서 해시·출처·이용 권리·거래일·게시일·최초 관측 시각을 보존합니다. 날짜만 있는 값은 `DATE`, 시각은 UTC로 저장하며 화면은 KST로 표시합니다. D003·D004의 활성화에는 정확한 파싱 결과와 원문 해시에 연결된 관리자 원문 확인이 필요합니다. AI 제안은 결정적 분류를 덮어쓰지 않습니다.

## 운영 CLI

다음 명령은 저장소 루트에서 실행합니다. 운영 환경을 선택하려면 먼저 `ORSEM_WORKER_PYTHON=/home/laeti/orsem-data/worker/current/bin/python`을 설정합니다. 명령 실행기는 별도 정기 워커를 시작하지 않습니다.

| 명령                                                              | 범위                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `python3 scripts/worker.py cli backfill-news-relevance --dry-run` | 기존 소스와 회사의 관련성 후보를 읽어 집계. `--apply`는 관련성 관계를 변경       |
| `python3 scripts/worker.py cli sync-korean-etfs --dry-run`        | 토스 ETF 목록 요청·검증. `--apply`는 기업 식별 정보를 반영                       |
| `python3 scripts/worker.py cli preview-market-leaders`            | 토스에서 국내·미국 선정 후보를 조회. 월간 목록 게시 없음                         |
| `python3 scripts/worker.py cli collect-sec --status`              | 저장된 SEC 상태·대기 정보를 조회                                                 |
| `python3 scripts/worker.py cli collect-sec --verify`              | 실행 중인 Python 워커의 기존 큐로 CIK 동기화와 알림 없는 수집·재수집 검증을 요청 |

`backfill-news-relevance`와 `sync-korean-etfs`는 `--apply`를 생략하면 dry run입니다. 공급자를 사용하는 미리보기는 네트워크 요청과 기존 인증 캐시를 사용할 수 있습니다. `collect-sec`에서 `--status`를 생략하면 실제 수집 작업이 등록됩니다. `--collect-only`는 선행 CIK 동기화를 생략하고, `--verify`는 재수집 후 최초 관측 시각·알림 억제를 추가 검사합니다. SEC 사용 식별 정보와 기존 JobScheduler가 필요하며 임시 작업 정리는 이 명령이 생성한 종료 작업으로 한정합니다.

파서 관리 명령은 아래 Python 스크립트로 실행합니다. 직접 스크립트를 실행할 때는 개발 `.venv/bin/python` 또는 운영 환경의 Python 절대 경로를 사용합니다. 출력 디렉터리는 저장소 밖이어야 합니다.

| 스크립트                                         | 필수 옵션 및 쓰기 범위                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/parser-corpus-audit.py`                 | `--snapshot`, `--old-results`, `--output-dir`. 보관 원문을 오프라인 재해석하고 감사 파일 생성                                                       |
| `scripts/stage-parser-corpus.py`                 | `--snapshot`, `--corpus`, `--output-dir`. 기본은 계획 생성. `--apply`는 명시한 `ORSEM_STAGE_DATABASE_URL`에 분류 메타데이터와 비활성 검토 후보 저장 |
| `scripts/export-parser-review-audit.py`          | `--output-dir`. `ORSEM_AUDIT_DATABASE_URL` 또는 `DATABASE_URL`의 검토 자료를 읽어 감사 파일 생성                                                    |
| `scripts/parser-rollout-backup.py backup`        | `--env-file`, `--output-dir`. 일관 스냅샷과 해시 명세를 외부 디렉터리에 저장                                                                        |
| `scripts/parser-rollout-backup.py restore-check` | `--socket-path`, `--database`, `--backup-dir`, `--output-dir`. `/tmp` 아래 독립 MySQL 소켓과 `orsem_*_test` 이름의 새 DB에서 복원 검증              |

예를 들어 `.venv/bin/python scripts/parser-corpus-audit.py --help`로 각 명령의 인자를 확인합니다. staging은 활성 결과나 알림을 자동 교체하지 않으며 별도 원문 확인·반영 절차를 유지합니다. `restore-check`는 운영 DB 전체 복원 명령이 아닙니다. 백업·감사 파일에는 원문이나 비공개 데이터가 들어갈 수 있으므로 기존 외부 데이터 디렉터리 권한과 보존 기준을 적용합니다.

## 전환과 복구

전환 전 큐 정지 상태와 실행 파일·설정·데이터 백업을 기록하고 활성 작업이 끝난 뒤 워커를 중지합니다. 후보 환경과 API·웹을 명세대로 적용하고 준비 상태, 큐 처리, 제공자별 실제 수집 결과, 전달 설정을 확인합니다. 정기 작업 변환 외의 일반 큐 작업과 DB outbox는 보존합니다.

이번 TypeScript 복구 후보는 `/home/laeti/orsem-data/backups/python-worker-20260910/rollback`입니다. 뉴스 메타데이터 전용 동작과 새 종목별 알림 설정을 지원하는 후보를 사용합니다. 과거 본문 수집기를 다시 활성화하거나 DB 전체를 자동 복원하지 않습니다. Python 전환 뒤 30분 관측을 통과한 다음 기존 워커 TypeScript·기존 파서 패키지·중복 스크립트를 정리하며, 외부 복구 환경과 데이터는 유지합니다.
