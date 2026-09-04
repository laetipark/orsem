# Orsem

Orsem은 한국의 지분 공시, 공식 공시 문서, 시장 가격, 출처가 있는 뉴스를 확인하는 NestJS + React 기반 개인용 관측 시스템입니다. D001 대량보유 보고, D002 임원·주요주주의 실제 소유변동, D005 향후 거래계획은 서로 다른 이벤트 유형으로 저장하고 검토합니다.

이 시스템은 관측을 목적으로 합니다. 보유 수량 증가를 자동으로 장내매수로 판단하지 않으며, 어떤 이벤트도 자동 매수·매도 추천이나 주문으로 연결하지 않습니다.

## 작업 공간 구성

```text
apps/api                 NestJS REST, 인증, 관리자 및 봇 게이트웨이
apps/worker              BullMQ 수집기, 파서 작업 관리 및 알림
apps/discord-bot         Discord 전송 및 조회 전용 슬래시 명령
apps/web                 React/Vite 운영 대시보드
packages/contracts       Zod 계약 및 도메인 용어
packages/database        MySQL 엔티티 및 마이그레이션
packages/opendart-parser 처리 한도가 적용된 ZIP/XML 파서
integrations/            MessengerBotR API2 브리지
deploy/                  적용 전 검토할 PM2/Nginx/MySQL 예시
docs/                    아키텍처, 이용 권리, 보안 및 운영 절차
```

## 로컬 미리보기

Node.js 24와 npm 11이 필요합니다.

```bash
cp .env.example .env
npm install
npm run dev:web
```

웹 앱은 `VITE_FIXTURE_MODE=true`로 명시한 경우에만 테스트 데이터 어댑터를 사용하며, 운영 빌드에서는 자동 활성화되지 않습니다. 전체 서비스를 실행하려면 MySQL과 Redis를 설정하고 마이그레이션을 적용한 뒤, 별도 터미널에서 API와 worker를 시작합니다.

```bash
npm run db:migrate
npm run dev:api
npm run dev:worker
```

## 실제 데이터 소스 설정

OpenDART 재검증과 UTC 이관, 현재 검토 수치 및 CSV 내보내기는 [파싱 무결성 운영 절차](docs/PARSER_INTEGRITY.md)를 참고하세요.

1. OpenDART 키를 추가하고 기업 코드 동기화를 초기화합니다.
2. 최초 관심 목록은 비워 둡니다. 화면에서 P1/P2 보유·관찰 기업을 추가합니다.
3. 일봉·분봉 차트와 현재가는 [토스 설정 절차](docs/OPERATIONS.md#toss-securities-chart-setup)를 따릅니다. 가격 공급자는 토스만 사용합니다. SEC 공시, Alpaca 기업 식별 정보, 선택적인 뉴스 소스는 필요에 따라 각각 설정합니다.
4. 기업 IR의 RSS/Atom 또는 공식 URL을 명시적으로 등록합니다. 광범위한 IR 크롤러는 제공하지 않습니다.
5. 파서 테스트 데이터를 검증하고 알림 없는 과거 수집을 실행한 뒤 실시간 알림 전송을 활성화합니다.

기업 페이지가 보이는 동안 선택한 차트와 현재가를 2초마다 조회합니다. 분봉 화면은 이벤트 수익률에 필요한 일봉 데이터도 갱신합니다. worker가 토스 공식 봉과 실시간 시세를 수집하며, 시각과 신선도 상태를 통해 수신 시점을 확인할 수 있습니다.

[아키텍처](docs/ARCHITECTURE.md), [API](docs/API.md), [소스 어댑터](docs/SOURCES.md), [데이터 이용 권리](docs/RIGHTS.md), [보안](docs/SECURITY.md), [카카오 로그인 설정](docs/KAKAO_LOGIN.md), [서비스별 자격 증명 관리](docs/CREDENTIALS.md), [테스트](docs/TESTING.md), [운영](docs/OPERATIONS.md), [배포](docs/DEPLOYMENT.md) 문서를 참고하세요.

## 화면과 통합 검색

상단 헤더에서 오늘·이벤트·관심기업 화면으로 이동하고, 통합 검색으로 수집된 종목·뉴스·국내외 공시 메타데이터를 찾습니다. 종목은 기업 관측 화면으로, 뉴스와 공시는 원문으로 연결합니다. 관리자용 검토함과 운영 메뉴는 하단에 표시합니다. 조회 회원에게는 관리자 메뉴를 표시하지 않습니다. [웹 화면 안내](apps/web/README.md)와 [검색 API 계약](docs/API.md#통합-검색)을 참고하세요.

선택적인 [뉴스 자동 한국어 번역](docs/NEWS_TRANSLATION.md)은 로컬 Ollama로 수집된 영문 제목·허용 요약을 번역합니다. 외부 번역 API 이용료 없이 서버 자원을 사용하며, 원문과 출처를 보존하고 자동 번역 표시를 붙입니다. 기사 전체를 크롤링하지 않고 DART·SEC 공시는 번역 대상에서 제외합니다.

## 검증

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run check:messenger-script
```

공시 원문, 로그, 비밀 값, 비공개 테스트 문서 모음은 이 저장소가 아닌 `/home/laeti/orsem-data`에 보관합니다.
