# Orsem

Orsem은 한국의 지분 공시, 공식 공시 문서, 시장 가격, 출처가 있는 뉴스를 확인하는 개인용 관측 시스템입니다. API는 NestJS, 화면은 React, 수집·파싱 워커는 Python 3.12로 구성합니다. D001 대량보유 보고, D002 임원·주요주주의 실제 소유변동, D003 의결권 위임 권유, D004 공개매수, D005 향후 거래계획은 서로 다른 유형으로 저장하고 검토합니다.

이 시스템은 관측을 목적으로 합니다. 보유 수량 증가를 자동으로 장내매수로 판단하지 않으며, 어떤 이벤트도 자동 매수·매도 추천이나 주문으로 연결하지 않습니다.

공시·뉴스의 원본 필드, 출처, 이용 권리, 사건일·발행일·최초 관측 시각을 구분해 보존합니다. 뉴스는 허용된 제목·제공 요약 등 메타데이터를 표시하며 기사 본문을 수집하지 않습니다. 가격은 토스증권을 사용합니다. 수집 범위와 조건은 [소스 안내](docs/SOURCES.md)와 [이용 권리](docs/RIGHTS.md)를 따릅니다.

[문서 안내](docs/README.md)에서 현행 가이드와 날짜별 배포·감사 기록을 구분해 찾을 수 있습니다.

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

웹 미리보기에는 Node.js 24와 npm 11이 필요합니다. API·웹·Discord와 공통 TypeScript 패키지는 npm workspace를 유지합니다. 전체 서비스를 실행하려면 Python 3.12, MySQL, Redis도 준비합니다.

문서의 파일 경로와 셸 명령은 프로젝트 루트를 기준으로 합니다. 외부 데이터는 `../orsem-data`, 비밀 설정은 `../.config/orsem` 배치를 기본 예시로 사용합니다. 링크와 실행 환경의 경로 처리 원칙은 [문서 안내](docs/README.md#문서-작성과-경로-기준)를 참고하세요.

```bash
cp .env.example .env
npm install
npm run dev:web
```

예시 설정은 개발용 `VITE_FIXTURE_MODE=true`를 사용합니다. 운영 빌드에서는 테스트 데이터 어댑터가 활성화되지 않습니다. `.env`에는 실제 비밀 값을 넣지 말고 외부 파일 경로와 비밀이 아닌 설정만 둡니다. 전체 서비스를 실행할 때는 [자격 증명 관리](docs/CREDENTIALS.md)에 따라 MySQL·Redis와 필수 비밀을 별도로 주입하고, [Python 워커 실행 환경](docs/PYTHON_WORKER.md#실행-환경)을 준비한 뒤 마이그레이션을 적용합니다.

```bash
npm run db:migrate
npm run dev:api
python3 scripts/worker.py start
```

API와 워커는 각각 별도 터미널에서 실행합니다. 이 호스트처럼 Python 3.12에 `ensurepip`가 없으면 [Python 워커의 pip 없는 환경 준비](docs/PYTHON_WORKER.md#실행-환경)를 따릅니다.

## 실제 데이터 소스 설정

OpenDART 재검증과 UTC 이관, 검토 수치 및 CSV 내보내기는 [파싱 무결성 운영 절차](docs/PARSER_INTEGRITY.md)를 참고하세요.

1. OpenDART 키를 추가하고 기업 코드 동기화를 초기화합니다.
2. 최초 관심 목록은 비워 둡니다. 그룹 관리에서 개인 관심기업을 추가합니다.
3. 일봉·분봉 차트와 현재가는 [토스 설정 절차](docs/OPERATIONS.md#toss-securities-chart-setup)를 따릅니다. 가격 공급자는 토스만 사용합니다. SEC 공시, Alpaca 기업 식별 정보, 검토된 뉴스 소스는 필요에 따라 각각 설정합니다.
4. 뉴스는 코드에 이용 조건과 정확한 호스트가 등록된 Samsung Global, Federal Reserve, BLS, EIA의 제목·제공 요약·출처를 수집하고 기사 본문은 요청하거나 저장하지 않습니다. 네이버 검색 메타데이터도 기존 뉴스 테이블에 저장해 회사 뉴스와 최신순으로 통합하며, 임의의 기업 IR URL은 활성화하지 않습니다.
5. 파서 테스트 데이터를 검증하고 알림 없는 과거 수집을 실행한 뒤 실시간 알림 전송을 활성화합니다.

기업 페이지가 보이는 동안 선택한 차트와 현재가를 2초마다 조회합니다. 분봉 화면은 이벤트 수익률에 필요한 일봉 데이터도 갱신합니다. worker가 토스 공식 봉과 실시간 시세를 수집하며, 시각과 신선도 상태를 통해 수신 시점을 확인할 수 있습니다.

분야별 설정·계약·운영 절차는 [문서 안내](docs/README.md)에서 찾을 수 있습니다.

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

공시 원문, 로그, 비밀 값, 비공개 테스트 문서 모음은 이 저장소가 아닌 `../orsem-data`에 보관합니다.

## 문서 길잡이

- 구조·저장·API: [아키텍처](docs/ARCHITECTURE.md), [데이터 구조](docs/DATA_MODEL.md), [API](docs/API.md)
- 수집·권리: [파싱 무결성](docs/PARSER_INTEGRITY.md), [SEC 수집](docs/SEC_COLLECTION.md), [뉴스 수집](docs/NEWS_COLLECTION.md), [이용 권리](docs/RIGHTS.md)
- 화면·목록: [종목 화면](docs/COMPANY_SCREEN.md), [월간 시장 목록](docs/MONTHLY_MARKET_LEADERS.md), [관심 그룹](docs/WATCHLIST_GROUPS.md)
- 실행·검증: [Python 워커](docs/PYTHON_WORKER.md), [운영](docs/OPERATIONS.md), [배포](docs/DEPLOYMENT.md), [테스트](docs/TESTING.md)

날짜별 조사·적용 결과와 복구 자료는 [문서 안내의 기록 목록](docs/README.md#날짜별-기록)에서 찾습니다.
