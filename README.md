# Orsem

Orsem은 한국의 지분 공시, 공식 공시 문서, 시장 가격, 출처가 있는 뉴스를 확인하는 개인용 관측 시스템입니다. API는 NestJS, 화면은 React, 수집·파싱 워커는 Python 3.12로 구성합니다. D001 대량보유 보고, D002 임원·주요주주의 실제 소유변동, D003 의결권 위임 권유, D004 공개매수, D005 향후 거래계획은 서로 다른 이벤트 유형으로 저장하고 검토합니다.

Python 워커는 운영 전환과 31분 안정성 관측을 완료했으며, 기존 TypeScript 워커·파서 소스는 검증된 외부 복구 환경을 보존한 뒤 정리했습니다. 실행 환경과 검증·운영 명령은 [Python 워커 안내](docs/PYTHON_WORKER.md), 현재 배포 상태는 [배포 문서](docs/DEPLOYMENT.md)에서 확인합니다. [문서 목록](docs/README.md)은 현행 가이드와 날짜별 감사·배포 기록을 구분합니다.

이 시스템은 관측을 목적으로 합니다. 보유 수량 증가를 자동으로 장내매수로 판단하지 않으며, 어떤 이벤트도 자동 매수·매도 추천이나 주문으로 연결하지 않습니다.

Marketaux·Alpha Vantage NEWS_SENTIMENT·Finnhub Company News의 조건부 metadata 어댑터와 NVDA·AVGO·PANW 공식 IR/한국경제 증권 RSS 프로필을 기존 뉴스 경로에 추가했습니다. **모두 기본 비활성·권리 UNKNOWN**이며 무료 계정 응답과 저장 권리를 확인해야 합니다. 신규 개인용 뉴스는 관리자 화면에 한정하고 본문·이미지를 수집하지 않습니다. 기존 DART·SEC·NAVER·공식 RSS·GDELT·Alpaca News와 토스 가격 구현을 재사용합니다. [기존 구현 audit](docs/SOURCES.md), [조사·채택 결정](docs/NEWS_PROVIDER_COMPARISON.md), [활성화 조건](docs/OPERATIONS.md)을 참고하세요.

## 작업 공간 구성

```text
apps/api                 NestJS REST, 인증, 관리자 및 봇 게이트웨이
apps/worker/python       Python BullMQ 수집기, ZIP/XML 파서 및 알림
apps/discord-bot         Discord 전송 및 조회 전용 슬래시 명령
apps/web                 React/Vite 운영 대시보드
packages/contracts       Zod 계약 및 도메인 용어
packages/database        MySQL 엔티티 및 마이그레이션
scripts/worker.py        Python 실행·검사·운영 CLI 진입점
integrations/            MessengerBotR API2 브리지
deploy/                  적용 전 검토할 PM2/Nginx/MySQL 예시
docs/                    아키텍처, 이용 권리, 보안 및 운영 절차
```

## 로컬 미리보기

Node.js 24, npm 11과 Python 3.12가 필요합니다. API·웹·Discord와 공통 TypeScript 패키지는 npm workspace를 유지합니다.

```bash
cp .env.example .env
npm install
python3.12 -m venv .venv
.venv/bin/python -m pip install -r apps/worker/python/requirements-dev.lock
npm run dev:web
```

웹 앱은 `VITE_FIXTURE_MODE=true`로 명시한 경우에만 테스트 데이터 어댑터를 사용하며, 운영 빌드에서는 자동 활성화되지 않습니다. 전체 서비스를 실행하려면 MySQL과 Redis를 설정하고 마이그레이션을 적용한 뒤, 별도 터미널에서 API와 worker를 시작합니다.

```bash
npm run db:migrate
npm run dev:api
python3 scripts/worker.py start
```

## 실제 데이터 소스 설정

OpenDART 재검증과 UTC 이관, 현재 검토 수치 및 CSV 내보내기는 [파싱 무결성 운영 절차](docs/PARSER_INTEGRITY.md)를 참고하세요.

1. OpenDART 키를 추가하고 기업 코드 동기화를 초기화합니다.
2. 최초 관심 목록은 비워 둡니다. 그룹 관리에서 개인 관심기업을 추가합니다.
3. 일봉·분봉 차트와 현재가는 [토스 설정 절차](docs/OPERATIONS.md#toss-securities-chart-setup)를 따릅니다. 가격 공급자는 토스만 사용합니다. SEC 공시, Alpaca 기업 식별 정보, 검토된 뉴스 소스는 필요에 따라 각각 설정합니다.
4. 뉴스는 코드에 이용 조건과 정확한 호스트가 등록된 Samsung Global, Federal Reserve, BLS, EIA의 제목·제공 요약·출처를 수집하고 기사 본문은 요청하거나 저장하지 않습니다. 네이버 검색 메타데이터도 기존 뉴스 테이블에 저장해 회사 뉴스와 최신순으로 통합하며, 임의의 기업 IR URL은 활성화하지 않습니다.
5. 파서 테스트 데이터를 검증하고 알림 없는 과거 수집을 실행한 뒤 실시간 알림 전송을 활성화합니다.

기업 페이지가 보이는 동안 선택한 차트와 현재가를 2초마다 조회합니다. 분봉 화면은 이벤트 수익률에 필요한 일봉 데이터도 갱신합니다. worker가 토스 공식 봉과 실시간 시세를 수집하며, 시각과 신선도 상태를 통해 수신 시점을 확인할 수 있습니다.

분야별 설정·계약·운영 절차는 [문서 목록](docs/README.md)에서 찾을 수 있습니다.

## 화면과 통합 검색

상단 헤더에서 오늘·이벤트·관심기업 화면으로 이동하고, 통합 검색으로 수집된 종목·뉴스·국내외 공시 메타데이터를 찾습니다. 종목은 기업 관측 화면으로, 뉴스와 공시는 각각 원문 페이지로 연결합니다. 뉴스에는 제목·제공 요약·관련 종목을 표시합니다. 관리자용 검토함과 운영 메뉴는 하단에 표시합니다. 조회 회원에게는 관리자 메뉴를 표시하지 않습니다. [웹 화면 안내](apps/web/README.md)와 [검색 API 계약](docs/API.md#통합-검색)을 참고하세요.

선택적인 [뉴스 자동 한국어 번역](docs/NEWS_TRANSLATION.md)은 로컬 Ollama로 이용이 승인된 영문 제목과 제공 요약을 번역합니다. 원래 메타데이터와 출처를 보존하고 자동 번역 표시를 붙입니다. 번역이 대기 중이거나 실패해도 허용된 원래 메타데이터와 상태를 표시하며 본문 준비 여부는 뉴스 노출에 영향을 주지 않습니다. DART·SEC 공시와 네이버 검색 결과는 번역 대상에서 제외합니다.

## 검증

운영 프로세스가 이 저장소의 `dist`를 사용하면 격리 복사본에서 검사와 빌드를 실행합니다. 아래 명령은 `npm run check`와 `npm run build`를 임시 작업 복사본에서 실행하며 운영 `dist`를 교체하지 않습니다.

```bash
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
python3 scripts/verify-in-isolation.py
```

Python만 검사할 때는 `python3 scripts/worker.py lint`, `typecheck`, `test`를 사용합니다. DB·Redis 통합 검사는 별도로 지정한 폐기 가능한 인스턴스에서 실행합니다. 운영 명령과 각 명령의 쓰기 범위는 [Python 워커 안내](docs/PYTHON_WORKER.md)에 정리합니다.

공시 원문, 로그, 비밀 값, 비공개 테스트 문서 모음은 이 저장소가 아닌 `/home/laeti/orsem-data`에 보관합니다.

## SEC·뉴스 복구

SEC는 recent 전체와 과거 제출 파일의 커서를 복구하고 공시 접수 뒤 Form 3/4/5 지분 관측을 별도로 처리합니다. GDELT는 publisher 승인과 시간 구간 체크포인트를 모두 요구합니다. 선택적 Alpaca News는 기본 비활성이며 가격 공급자는 계속 토스입니다. [변경 전 분석](docs/SEC_NEWS_IMPLEMENTATION_ANALYSIS.md), [SEC 복구](docs/SEC_GAP_RECOVERY.md), [ownership 파서](docs/SEC_OWNERSHIP.md), [뉴스 공급자 비교](docs/NEWS_PROVIDER_COMPARISON.md)를 참고하세요.

종목 목록·상세 주소와 차트는 [종목 화면](docs/COMPANY_SCREEN.md), 저장 구조와 보존 기준은 [데이터 구조](docs/DATA_MODEL.md)를 참고하세요.

운영 관심 목록은 [국내·미국 월간 시총 상위 20종목](docs/MONTHLY_MARKET_LEADERS.md)으로 대체합니다. 매월 검증된 목록으로 갱신하고 실패하면 이전 목록을 유지합니다. 개인·공유방 관심 그룹은 별도로 유지하며 Discord와 MessengerBotR에서 시장 목록·뉴스를 조회할 수 있습니다.
