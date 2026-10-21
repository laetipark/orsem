![Orsem 오늘 화면의 데스크톱·모바일 UI와 레이아웃 설명](docs/assets/orsem-figma-ui.png)

<p align="center">
  <sub>Figma 상세 UI · 화면의 데이터는 모의 값입니다</sub><br>
  <a href="https://www.figma.com/design/3ywykwXQtzJxqu7zn2YwlO/orsem-ui?node-id=0-1">Figma UI 문서 보기 · 6개 통합 화면</a>
</p>

# Orsem

## 출처와 시각을 확인하는 공시·시장 관측 도구

Orsem은 국내외 공시, 내부자 소유변동, 시장 가격과 허용된 뉴스 메타데이터를 한곳에서 살펴보는 개인용 웹 서비스입니다. 수집된 정보의 원본과 출처, 이용 권리, 시점을 함께 확인할 수 있도록 설계했습니다.

## 💬 프로젝트 소개

공시 유형과 수량 변화만으로 거래 의도를 단정하지 않고, 확인 가능한 원문과 데이터 맥락을 함께 보여줍니다. DART의 D001 대량보유, D002 임원·주요주주 소유변동, D003 의결권 위임 권유, D004 공개매수, D005 향후 거래계획은 서로 다른 사건으로 분류합니다.

Orsem은 정보 관측 서비스입니다. 보유 수량 증가를 장내매수로 자동 판단하지 않으며, 매수·매도 추천이나 주문 기능을 제공하지 않습니다.

## ✨ 주요 기능

- **오늘·시장 관측** — 시장 지표, 관심 종목 소식, 오늘 접수된 공시와 수집 상태를 한 화면에서 확인합니다.
- **공시 탐색과 검토** — D001–D005 유형별 목록, 공시 상세, 정정 연결과 사람 검토 상태를 살펴봅니다.
- **종목 화면** — 가격 차트, 공시·뉴스 이벤트, 출처와 시점을 함께 확인합니다.
- **관심 그룹과 통합 검색** — 종목·공시·뉴스 메타데이터를 검색하고 개인·공유 관심 목록을 관리합니다.
- **운영 상태 확인** — 수집 소스와 실행 이력, 큐 적체, 실패·재시도 정보를 확인합니다.
- **알림 연동** — Discord 봇과 MessengerBotR 브리지에서 조회와 알림을 지원합니다.

## 🛠️ 기술 스택 및 시스템 구성

<img alt="Node.js 24" src="https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=node.js&logoColor=white">&nbsp;
<img alt="npm Workspaces" src="https://img.shields.io/badge/npm-Workspaces-CB3837?style=for-the-badge&logo=npm&logoColor=white">&nbsp;
<img alt="NestJS 11" src="https://img.shields.io/badge/NestJS-11-E0234E?style=for-the-badge&logo=nestjs&logoColor=white">&nbsp;
<img alt="React 19" src="https://img.shields.io/badge/React-19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB">&nbsp;
<img alt="Vite 7" src="https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white">&nbsp;
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white">&nbsp;
<img alt="Python 3.12" src="https://img.shields.io/badge/Python-3.12-3776AB?style=for-the-badge&logo=python&logoColor=white">&nbsp;
<img alt="MySQL" src="https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white">&nbsp;
<img alt="Redis" src="https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white">

| 영역      | 기술·책임                                                 |
| --------- | --------------------------------------------------------- |
| API       | NestJS REST API, 세션 인증, 관리자 기능                   |
| 웹        | React 19, Vite, TypeScript 기반 대시보드                  |
| 수집 워커 | Python 3.12, BullMQ 작업 처리, 공시·뉴스·시장 데이터 수집 |
| 공통 계약 | Zod 기반 API 계약과 도메인 용어                           |
| 저장소    | MySQL, TypeORM 마이그레이션, Redis 큐·세션                |
| 연동      | Discord 조회·알림 봇, MessengerBotR API2 브리지           |

## 📁 프로젝트 구성

```text
apps/api                 NestJS API, 인증, 관리자 기능
apps/web                 React 운영 대시보드와 공개 화면
apps/worker/python       Python 수집·파싱·알림 워커
apps/discord-bot         Discord 조회 및 알림 명령
packages/contracts       Zod 계약과 공통 도메인 용어
packages/database        MySQL 엔티티와 마이그레이션
integrations/            MessengerBotR API2 브리지
scripts/                 검증·운영 CLI와 개발 도구
deploy/                  검토 후 적용하는 배포 예시
docs/                    구조·데이터·권리·보안·운영 문서
```

## ⚙️ 환경 설정 및 실행

### 사전 요구사항

- Node.js 24 이상, npm 11 이상
- 전체 서비스를 실행할 때 Python 3.12, MySQL, Redis
- 실제 소스 연결에 필요한 자격 증명은 저장소 외부에 별도 관리

### 웹 미리보기

프로젝트 루트에서 의존성을 설치하고 개발 서버를 실행합니다.

```bash
cp .env.example .env
npm install
npm run dev:web
```

예시 환경은 개발 모드에서만 모의 데이터를 사용할 수 있습니다. 운영 빌드에서는 fixture 데이터가 자동으로 활성화되지 않습니다. 실제 자격 증명은 `.env`나 Git에 넣지 말고 [자격 증명 관리](docs/CREDENTIALS.md)를 따릅니다.

### API와 워커 실행

MySQL·Redis와 Python 실행 환경을 준비하고, 자격 증명을 설정한 뒤 각 명령을 별도 터미널에서 실행합니다.

```bash
npm run db:migrate
npm run dev:api
python3 scripts/worker.py start
```

개발용 DB 스키마 변경은 마이그레이션으로 관리하며 TypeORM `synchronize`는 사용하지 않습니다. Python 환경과 운영 명령은 [워커 실행 안내](apps/worker/README.md)와 [Python 워커 문서](docs/PYTHON_WORKER.md)를 확인하세요.

## 🔗 주요 화면 경로

| 경로                       | 화면                            |
| -------------------------- | ------------------------------- |
| `/`                        | 오늘의 공시·시장·관심 종목 관측 |
| `/markets`, `/markets/:id` | 시장 지표와 상세 차트           |
| `/search?q=...`            | 종목·공시·뉴스 통합 검색        |
| `/events`, `/events/:id`   | 공시 이벤트 목록과 상세 정보    |
| `/companies/:codeOrTicker` | 종목 가격·공시·뉴스 관측        |
| `/watchlist`               | 개인·공유 관심 그룹과 종목      |
| `/reviews`, `/operations`  | 검토함과 수집 운영 상태         |
| `/login`                   | 회원 로그인과 승인 상태 확인    |

비로그인 이용자는 공개 시장·종목·뉴스 화면을 볼 수 있고, 승인 회원은 권한에 따라 기존 관측 기능을 이용합니다. 메뉴와 화면 상태는 [웹 안내](apps/web/README.md)에 정리합니다.

## 📡 데이터·이용 원칙

- 공시·뉴스의 원본 필드, 출처, 이용 권리, 사건일, 발행·접수일, 최초 관측 시각을 구분해 보존합니다.
- 사용자에게는 KST를 표시하고, 시각이 있는 값은 UTC instant로 저장합니다. 출처가 날짜만 제공하면 날짜 값으로 보존합니다.
- 뉴스는 허용된 제목·제공 요약 등 메타데이터만 다루며 기사 본문을 요청하거나 저장하지 않습니다.
- 가격 차트와 현재가는 토스증권을 사용합니다. 수집 범위와 각 제공자의 허용 조건은 [소스 안내](docs/SOURCES.md)와 [이용 권리](docs/RIGHTS.md)를 따릅니다.
- 자격 증명이 없는 커넥터는 해당 연동만 비활성화하며, 운영 환경에는 fixture 데이터를 자동 삽입하지 않습니다.
- 수량 증가만으로 장내매수를 추정하지 않고, 자동 매수·매도 추천이나 주문을 수행하지 않습니다.

## 🧪 검증

운영 프로세스가 저장소의 `dist`를 사용 중이라면 격리 복사본에서 검사와 빌드를 실행합니다.

```bash
export ORSEM_WORKER_PYTHON="$PWD/.venv/bin/python"
npm run check:isolated
```

문서 링크와 프로젝트 Markdown만 검사하려면 `npm run check:docs`를 사용합니다. 전체 테스트 명령과 테스트 환경은 [테스트 전략](docs/TESTING.md)을 참고하세요.

## 📚 프로젝트 문서

- **구조와 계약** — [아키텍처](docs/ARCHITECTURE.md), [데이터 구조](docs/DATA_MODEL.md), [API](docs/API.md)
- **화면과 기능** — [웹 안내](apps/web/README.md), [종목 화면](docs/COMPANY_SCREEN.md), [Figma UI 문서](https://www.figma.com/design/3ywykwXQtzJxqu7zn2YwlO/orsem-ui?node-id=0-1)
- **수집과 권리** — [소스 안내](docs/SOURCES.md), [파싱 무결성](docs/PARSER_INTEGRITY.md), [SEC 수집](docs/SEC_COLLECTION.md), [뉴스 수집](docs/NEWS_COLLECTION.md), [이용 권리](docs/RIGHTS.md)
- **개발과 운영** — [자격 증명](docs/CREDENTIALS.md), [Python 워커](docs/PYTHON_WORKER.md), [운영](docs/OPERATIONS.md), [배포](docs/DEPLOYMENT.md), [테스트](docs/TESTING.md)
- **문서 길잡이** — [전체 문서 안내](docs/README.md)
