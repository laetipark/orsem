# 아키텍처

Orsem은 개인용 비상업 관측 시스템입니다. 공시와 뉴스를 감지하며, 주문을 실행하거나 자동 매수·매도 추천을 생성하지 않습니다.

이 문서는 Python 3.12 워커의 구조를 설명합니다. 현재 운영 전환 상태는 [배포 문서](DEPLOYMENT.md#python-워커-전환-상태)에 별도로 기록합니다.

```text
OpenDART / SEC / Samsung Global / Federal Reserve / BLS
                          │
                          ▼
            Python worker 수집기 + 영속 체크포인트
                          │
                   MySQL job_outbox
                          │
                          ▼
                  BullMQ 후처리 큐
                          │
        원본 ZIP ──► 한도가 적용된 파서 ──► 형식화된 사실
                          │
                규칙 + 선택적 로컬 AI 검토
                          │
                          ▼
        이벤트 묶음 / 검토 작업 / alert_outbox
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
      NestJS API       Discord 봇     MessengerBotR
          │
          ▼
      React 대시보드
```

NAVER 뉴스는 정기 대상 순환 또는 종목 뉴스 열람 시 자동 조회합니다. 검색 메타데이터는 기존 `source_items`·`news_items`·`news_articles`·`news_source_companies`에 저장하고 회사 뉴스와 같은 커서로 최신순 조회합니다. 원응답·원문/네이버 링크·발행 문자열·UTC 발행/최초 관측을 보존하며 기사 전문·AI·번역·자동 알림 수집은 하지 않습니다. 저장 뉴스는 현재 등록 정책과 행별 audience 권한을 함께 검사합니다.

## 패키지

- `apps/api`: 인증이 필요한 REST API와 봇 기기 게이트웨이.
- `apps/worker/python/orsem_worker`: Python 일정·소스 어댑터·BullMQ 작업·정규화·전송 대기함·분류기.
- `apps/discord-bot`: 조회 전용 슬래시 명령과 기한부 점유 방식의 알림 전송.
- `apps/web`: 운영 대시보드.
- `packages/contracts`: 실행 시점에 검증하는 소스·API·큐 계약.
- `packages/database`: TypeORM 엔티티, 데이터 소스, 마이그레이션. 스키마 자동 동기화는 비활성화합니다.
- `apps/worker/python/orsem_worker/disclosures`: 한도가 적용된 ZIP/XML 정규화, D001–D005 추출기, 원문 검토·조회용 데이터 반영, SEC ownership 파서.
- `scripts/worker.py`와 `scripts/*parser*.py`: 저장소 소스의 실행·검증·감사 진입점. 운영 CLI는 설치된 wheel의 `orsem_worker.cli`를 직접 실행합니다. 외부 TypeScript 복구 환경과 전환 상태는 [Python 워커 안내](PYTHON_WORKER.md#전환과-복구)에서 구분합니다.
- `integrations/messengerbot-r`: 로컬 전송 기록을 갖춘 Android API2 브리지.

## 코드 책임 분리

- API의 `resources/orsem-data.service.ts`는 조회·권한·트랜잭션을 조합합니다. 순수 응답 변환은 `resources/resource-mappers.ts`, 페이지 결과 구성은 `common/pagination.ts`, 커서 직렬화는 `common/cursor.ts`에서 관리합니다. 지역 필터와 정렬을 적용한 뒤 `limit + 1`개를 읽어 다음 페이지 유무를 결정합니다.
- Python worker의 `connectors/common.py`와 개별 클라이언트는 HTTP 응답 바이트·redirect·제한 시간을 통제합니다. `market/toss.py`는 요청 범위·저장된 수집 이력·현재 시각을 이용해 토스 갱신 범위를 결정합니다. `disclosures/`는 원문 보존과 추출·검토·반영을, `connectors/`는 소스별 권리·예산·수집·번역을, `market/`은 가격·기업 정보·시장 선정을 담당합니다.
- `core.py`·`storage.py`는 기존 MySQL 테이블에 바인딩된 SQL과 명시적 트랜잭션으로 접근합니다. DDL은 계속 `packages/database`의 TypeORM 마이그레이션이 관리하며 Python에서 스키마를 자동 생성하지 않습니다. `jobs.py`는 기존 JSON 작업 계약을 검증하고 `runtime.py`·`scheduling.py`는 기존 Redis 큐와 JobScheduler를 관리합니다. `push.py`·`outbox.py`·`alert_gate.py`는 알림 수신 권한과 현재 활성 공시 결과를 전송 직전에도 확인합니다.
- 웹의 시장 조회, 그룹 분류, 시각 표시, 카드와 가격 표시를 별도 모듈로 관리합니다. 화면 배치는 컴포넌트와 CSS가 맡고, 수집 시각·자료 기준 시각의 의미는 `lib/market-time.ts`에서 공유합니다. 표시용 한글 명칭은 `lib/domain-labels.ts`를 사용하며 API 코드와 원본 인용문은 변경하지 않습니다.

Node.js 24/npm workspace는 API·웹·Discord·공통 TypeScript 계약을 유지합니다. Python 워커는 JavaScript 실행 브리지 없이 `python -m orsem_worker`로 실행합니다. 기존 BullMQ 큐 이름·접두사·작업 데이터·재시도 계약과 DB 식별자를 공유하므로 언어 전환 시 일반 큐 작업이나 수집 자료를 초기화하지 않습니다. Python 패키지는 wheel과 잠긴 의존성으로 배포합니다.

정기 작업의 다음 회차는 처리 시작 시 producer ID로 중복을 방지하며 등록합니다. 종료 시에는 모든 큐 수신을 먼저 차단하고 주기 작업을 취소한 뒤 실행 중인 작업의 잠금 갱신과 DB·HTTP 연결을 유지하며 처리를 기다립니다. MySQL advisory lock은 같은 연결의 쓰기 트랜잭션이 커밋 또는 롤백된 뒤 해제하여 다음 수집기가 이전 체크포인트를 읽는 구간을 만들지 않습니다.

운영 산출물과 겹치는 작업 공간에서는 `python3 scripts/verify-in-isolation.py`로 `npm run check`와 `npm run build`를 격리 실행합니다. Python 검증은 Ruff·mypy·pytest를 사용합니다. 실행 환경과 관리 명령은 [Python 워커 안내](PYTHON_WORKER.md)를 참고하세요.

## 이벤트 시각의 의미

다음 필드는 절대 하나로 합치지 않습니다.

- `eventDate`: 실제 거래 또는 소유변동이 발생한 날짜.
- `publishedAt` / `rceptDate`: 소스 게시 시각 또는 공시 접수일.
- `firstObservedAt`: Orsem이 해당 항목을 처음 감지한 시각.
- `processedAt`: 파싱·분류가 완료된 시각.

날짜만 있는 원본 값은 SQL `DATE`로 유지합니다. 시각은 UTC로 저장하고 KST로 표시합니다.

## 시장 데이터

```text
토스 REST 봉 ──► BullMQ worker ──► MySQL 소스별 가격 봉
                                              │
토스 WebSocket ──► 대표 worker ──► Redis 시세  │
                                      │       │
                                      └───┬───┘
                                          ▼
                                    인증된 API
                                          │
                                          ▼
                                      기업 차트
```

REST와 WebSocket은 서버의 OAuth 토큰 하나를 공유하며, 갱신은 순차적으로 처리합니다. 브라우저는 페이지가 보이는 동안 선택한 차트와 현재가를 2초마다 조회합니다. 분봉 화면은 이벤트 수익률에 필요한 일봉도 조회합니다. 타임라인 조회는 저장된 봉을 반환하고, 중복을 합친 worker 갱신 작업을 큐에 넣습니다. OHLCV는 공식 REST 봉을 사용하며, 수신 체결 틱은 유실 가능한 스냅샷이므로 이를 모아 봉을 재구성하지 않습니다.

일봉 날짜는 해당 시장의 거래일을 유지하며, 미국 주식은 뉴욕 날짜를 사용합니다. 분봉 시각은 UTC로 저장하고 KST로 표시합니다. 각 봉은 소스, 이용 권리 모드, 원본 필드, 관측 시각을 보관합니다. 차트 공급자는 토스만 사용합니다. Alpaca 자산 마스터 동기화는 기업 식별 정보를 별도로 제공하며, KRX와 Alpaca 가격 수집은 종료되었습니다.

## 뉴스 번역

뉴스의 원본 메타데이터와 한국어 번역은 별도 저장합니다. 수집 후 기존 번역 큐가 로컬 Ollama에서 승인된 제목과 제공 요약만 처리합니다. 기사 HTML·본문·이미지를 요청하거나 번역하지 않습니다. API는 번역이 현재 원문 해시·출처·이용 권리와 맞는 경우만 반환합니다. 조회 요청은 번역 추론을 직접 실행하지 않습니다. 웹은 원문과 출처를 유지합니다. [세부 계약](NEWS_TRANSLATION.md)을 참고하세요.

## 기존 수집 경로의 조건부 뉴스 확장

Marketaux·Alpha Vantage·Finnhub는 Python `connectors/providers.py`의 공급자와 공통 발견 후보 계약을 사용합니다. BullMQ 수집 → 권리·무료 entitlement 검사 → 기존 DB 예산 예약 → 공급자 metadata 정규화 → 기존 회사 연결/뉴스 중복 제거 → source_items/news_items 저장 → 공식 자료 후보 연결 순서를 따릅니다. RSS는 같은 경로의 정확한 URL 프로필을 사용합니다.

일반 뉴스에는 본문 수집 단계가 없다. 공급자별 장애를 provenance와 함께 기록하며 다른 서비스로 묵시적으로 대체하지 않는다. 재시작 cursor와 overlap은 기존 checkpoint 구조를 사용한다. 회사·원출처·시간이 맞는 정규화 제목과 canonical URL로 기사를 묶되 발견 경로와 독립 원출처 수를 분리한다.

API는 인증된 세션에서 `ADMIN_UI | MEMBER_UI | SHARED_ROOM | BOT` 독자를 결정하고, 승인 당시와 현재의 권리 교집합을 적용한다. 신규 개인용 뉴스는 관리자 전용이다. 기본 화면·검색·뉴스 카드·운영 및 검토 화면을 재사용한다. 공식 자료 링크의 수동 확인은 기존 reviews에 남기며 공시 분류나 EventCluster 근거 등급을 바꾸지 않는다.

우선순위는 공식 공시·정부·기업 IR → 독립 언론 → API/집계 후보 발견을 유지한다. aggregator의 sentiment나 보도 수는 자동 매수·매도 추천·주문으로 이어지지 않는다.

## 공시 유형의 경계

- D001: 5% 대량보유 보고와 변동.
- D002: 임원·주요주주의 실제 소유상황 보고.
- D003: 의결권 위임 권유, 대상회사·권유자·주총·안건.
- D004: 공개매수, 신고·설명·실제 결과를 별도 구분.
- D005: 향후 거래계획으로, 체결 증거가 아님.

D005와 D002의 계획·실행 연결 후보는 다대다 관계입니다. 자동 확정에는 기업, 보고자, 증권, 계획 기간, 수량이 정확히 일치해야 합니다. 정정 관계는 감사 가능한 그래프로 남기며 이전 제출 문서를 삭제하지 않습니다.

## 전송 보장 범위

DB 전송 대기함과 고유한 멱등성 키가 일반적인 중복 등록과 재시작 시 중복을 방지합니다. Discord와 카카오톡은 종단 간 멱등성을 제공하지 않으므로, 외부 전송 뒤 수신 확인이 유실되는 경우까지 완전한 중복 방지를 보장하지는 않습니다. MessengerBotR은 영속적인 로컬 전송 기록으로 이 위험 구간을 줄입니다.
