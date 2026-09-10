# 테스트 전략

기본 테스트 모음은 실행할 때마다 같은 결과를 내며 실제 데이터 공급자를 호출하지 않습니다. 실제 OpenDART 문서는 Git 밖의 비공개 문서 모음에 보관하고 SHA-256 목록으로 참조합니다.

## 필요한 검증 계층

- 계약 테스트: OpenDART 응답 검증, 페이지 순회, `013` 빈 결과, 요청 한도·점검 상태 처리, 비밀 값 가림.
- 파서 테스트: D001/D002/D003/D004/D005 표 변형, `rowspan`/`colspan`, 가격 누락, 여러 증권, 정정, 엄격한 `UNKNOWN` 처리.
- 악의적 입력 테스트: 경로 이탈, 중첩 ZIP, 항목·크기 초과, 잘못된 XML, DTD·엔티티 선언, 지원하지 않는 인코딩.
- worker 테스트: 겹치는 체크포인트 구간, 반복 조회, 과거 수집 알림 억제, 재시도 시각, 회로 차단 상태, 작업·알림 멱등성.
- 시장 데이터 테스트: 토스 응답 정규화, 경계 봉을 포함하는 페이지 순회, 최초 조회 이력 수집과 최신 페이지 갱신의 구분, 체크포인트 보존, 중복 조회 작업 합치기.
- AI 테스트: 잘못된 JSON, 결정적 규칙과의 불일치, 뉴스의 프롬프트 주입 문구, 비활성 경로, 증거 참조 검증.
- 뉴스 번역 테스트: 원문·해시·권리 보존, 허용되지 않은 소스와 요약 차단, 실패 시 원문 유지, 제목 번역 검색, 웹의 카드 번역 전용 표시·상세 번역/원문 전환·공시 번역 제외·링크 안 상호작용 요소 중첩 방지.
- 이용 권리 테스트: 인증된 데이터 접근, `RightsMode` 보존, 기사 본문 노출 제한.
- API·보안 테스트: 로그인, TOTP, 복구 코드 일회 소비, 세션 만료, 출처·CSRF 검사 실패, 커서 필터, 문서 경로 이탈 차단.
- 메시징 테스트: Discord 편집 실패 시 대체 전송과 MessengerBotR 점유·수신 확인 재시도.
- 웹 테스트: 테스트 데이터 대시보드, 빈 관심 목록, 필터, 검토 동작, 데스크톱·모바일 경로 기본 동작; 토스 연결 상태, 시세 만료, KST 분봉 표기, USD 정밀도, 갱신 중 확대 범위 유지.

## 비공개 문서 모음의 목록

실제 표본마다 다음 정보를 기록합니다.

```json
{
  "receiptNo": "redacted-or-private",
  "detailType": "D002",
  "scenario": "market-buy-multiple-rows",
  "sha256": "...",
  "expectedFile": "market-buy-multiple-rows.expected.json",
  "parserVersion": "opendart-xml-v1"
}
```

서식이 서로 다른 시기의 문서를 최소 20개 보관합니다. 장내매수·매도, 시간외 대량매매, 증여, 옵션, RSU/RSA, 전환, 분할·합병, 신탁, 여러 행·증권, D005 변경·철회·부분 실행, D001 최초·변경·정정·철회를 포함해야 합니다.

## 명령어

Node.js 24/npm과 Python 3.12 개발 환경이 필요합니다. [Python 환경 설치](PYTHON_WORKER.md#실행-환경) 후 운영 프로세스와 산출물을 공유하는 작업 공간에서는 격리 검증기를 사용합니다.

```bash
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
python3 scripts/verify-in-isolation.py
```

검증기는 임시 작업 복사본에서 `npm run check`와 `npm run build`를 실행합니다. `check`는 포맷, 린트, 타입 검사, 전체 테스트, MessengerBotR 문법 검사를 순서대로 실행합니다. CI나 운영 산출물과 분리된 작업 공간에서는 두 npm 명령을 직접 실행할 수 있습니다. 실제 자격 증명이나 `.env` 없이 실행할 수 있으며 공급자 호출과 운영 데이터베이스 연결은 포함하지 않습니다.

처음 복제했거나 `dist`를 지운 경우에도 루트의 타입 검사·테스트 명령은 `build:packages`를 먼저 실행합니다. 공통 TypeScript 패키지는 contracts → database 순서로 빌드합니다. OpenDART 파서는 Python 워커에 포함되며 별도 Node 파서 패키지 빌드는 필요하지 않습니다.

개별 검증은 다음과 같이 실행합니다.

```bash
npm run typecheck
npm test
npm run test:scripts
npm run check:messenger-script
python3 scripts/worker.py lint
python3 scripts/worker.py typecheck
python3 scripts/worker.py test
```

실제 소스 기본 동작 테스트는 명시적으로 선택했을 때만 실행하고 요청 한도를 적용하며 일반 CI에서 제외합니다. 로그에는 요청 종류, 상태, 소요 시간, 응답 해시를 기록할 수 있지만 API 키나 전체 쿼리 URL을 기록하면 안 됩니다.

## Python 통합 검사

다음 변수는 폐기 가능한 테스트 인스턴스를 명시할 때만 사용합니다. 각 테스트의 DB 이름·소켓·포트 제한을 확인하며 운영 연결 값을 넣지 않습니다.

| 환경 변수                  | 검증 범위                                                          |
| -------------------------- | ------------------------------------------------------------------ |
| `ORSEM_TEST_DATABASE_URL`  | 공시·저장·알림 outbox의 실제 MySQL 동작                            |
| `ORSEM_CONNECTORS_TEST_DB` | 수집기 체크포인트·권리·커서의 실제 MySQL 동작                      |
| `ORSEM_MARKET_TEST_DB`     | 가격·식별 정보·배치 저장·동시 연결 잠금의 실제 MySQL 동작          |
| `ORSEM_TEST_REDIS_URL`     | Node↔Python 일반 작업, 재시도·지연, 연속 스케줄, 종료 중 잠금 갱신 |

변수가 없는 검사는 건너뛰므로 통과 수와 생략 수를 함께 기록합니다. BullMQ를 변경할 때는 `test_queue_compatibility.py`, `test_scheduler_advancement.py`, `test_runtime_shutdown.py`를 실제 Redis에서 실행하여 `runtime.Worker`의 동작을 확인합니다. 테스트는 고유 큐 접두사를 사용하며 자신이 생성한 데이터만 정리합니다. 공급자 응답은 합성 자료를 사용하고 외부 연결 성공은 별도로 기록합니다.
