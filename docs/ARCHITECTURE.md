# 아키텍처

Orsem은 개인용 비상업 관측 시스템입니다. 공시와 뉴스를 감지하며, 주문을 실행하거나 자동 매수·매도 추천을 생성하지 않습니다.

```text
OpenDART / SEC / Samsung Global / Federal Reserve / BLS
                          │
                          ▼
            검토된 프로필의 worker 수집기 + 체크포인트
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

NAVER 뉴스는 정기 대상 순환 또는 종목 뉴스 열람 시 자동 조회합니다. 임시 메모리 결과는 공식 뉴스와 함께 표시하되 DB·번역·통합 검색·알림 파이프라인에는 저장하지 않습니다.

## 패키지

- `apps/api`: 인증이 필요한 REST API와 봇 기기 게이트웨이.
- `apps/worker`: 일정, 소스 어댑터, 큐, 정규화, 전송 대기함, 분류기.
- `apps/discord-bot`: 조회 전용 슬래시 명령과 기한부 점유 방식의 알림 전송.
- `apps/web`: 운영 대시보드.
- `packages/contracts`: 실행 시점에 검증하는 소스·API·큐 계약.
- `packages/database`: TypeORM 엔티티, 데이터 소스, 마이그레이션. 스키마 자동 동기화는 비활성화합니다.
- `packages/opendart-parser`: 악의적인 입력에 대비한 ZIP/XML 정규화와 D001/D002/D003/D004/D005 추출기.
- `integrations/messengerbot-r`: 로컬 전송 기록을 갖춘 Android API2 브리지.

## 코드 책임 분리

- API의 `resources/orsem-data.service.ts`는 조회·권한·트랜잭션을 조합합니다. 순수 응답 변환은 `resources/resource-mappers.ts`, 페이지 결과 구성은 `common/pagination.ts`, 커서 직렬화는 `common/cursor.ts`에서 관리합니다. 지역 필터와 정렬을 적용한 뒤 `limit + 1`개를 읽어 다음 페이지 유무를 결정합니다.
- worker의 `common/bounded-response.ts`는 선언된 크기와 실제 스트림 바이트를 함께 제한합니다. 제공자마다 정한 한도·오류 문구는 호출부에 남깁니다. `market-data/toss-view-fetch-policy.ts`는 요청 범위·저장된 수집 이력·현재 시각으로 갱신 범위를 결정하며 네트워크나 데이터베이스에 접근하지 않습니다.
- 웹의 시장 조회, 그룹 분류, 시각 표시, 카드와 가격 표시를 별도 모듈로 관리합니다. 화면 배치는 컴포넌트와 CSS가 맡고, 수집 시각·자료 기준 시각의 의미는 `lib/market-time.ts`에서 공유합니다. 표시용 한글 명칭은 `lib/domain-labels.ts`를 사용하며 API 코드와 원본 인용문은 변경하지 않습니다.

루트의 `npm run build:packages`는 공통 패키지를 의존 순서대로 빌드합니다. `npm run check`로 로컬과 CI에서 같은 검증 순서를 실행합니다. [검증 명령](TESTING.md)을 참고하세요.

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

Marketaux·Alpha Vantage·Finnhub는 기존 `LinkDiscoveryAdapter`와 `DiscoveryCandidate`를 확장한다. 별도 가격 adapter, company master, queue, 뉴스 DB를 만들지 않는다. BullMQ 수집 → 권리·무료 entitlement 검사 → 기존 DB 예산 예약 → 공급자 metadata 정규화 → 기존 회사 연결/뉴스 중복 제거 → source_items/news_items 저장 → 공식 자료 후보 연결 순서를 따른다. RSS는 같은 경로의 정확한 URL 프로필만 확장한다.

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
