# 문서 안내

현행 가이드는 실행 방법과 데이터 계약을 설명합니다. 운영 적용 여부·관측 결과·복구 명세는 [배포 문서](DEPLOYMENT.md)를 기준으로 확인합니다. 날짜별 기록의 경로·수치·상태는 당시 사실이며 현재 실행 명령으로 사용하지 않습니다.

## 시작·구조·운영

| 문서                                                                                | 내용                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| [프로젝트 README](../README.md)                                                     | 로컬 시작과 작업 공간 구성                        |
| [Python 워커](PYTHON_WORKER.md)                                                     | 개발 소스와 운영 wheel 실행, CLI, 검증, 복구 경로 |
| [아키텍처](ARCHITECTURE.md) · [데이터 구조](DATA_MODEL.md) · [API](API.md)          | 서비스 책임과 저장·조회 계약                      |
| [운영](OPERATIONS.md) · [배포](DEPLOYMENT.md) · [테스트](TESTING.md)                | 장애 점검, 적용 명세, 격리 검증                   |
| [자격 증명](CREDENTIALS.md) · [보안](SECURITY.md) · [카카오 로그인](KAKAO_LOGIN.md) | 외부 비밀 파일, 인증과 접근 제어                  |

## 수집·파싱·이용 권리

| 문서                                                                                                            | 내용                                |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [소스 안내](SOURCES.md) · [이용 권리](RIGHTS.md)                                                                | 수집 범위와 소스별 허용 조건        |
| [파싱 무결성](PARSER_INTEGRITY.md)                                                                              | D001–D005 분류·검토·재검증·감사 CLI |
| [SEC 수집](SEC_COLLECTION.md) · [누락 복구](SEC_GAP_RECOVERY.md) · [ownership](SEC_OWNERSHIP.md)                | CIK·공시 접수·Form 3/4/5·접근 제한  |
| [뉴스 수집](NEWS_COLLECTION.md) · [공급자 비교](NEWS_PROVIDER_COMPARISON.md) · [뉴스 번역](NEWS_TRANSLATION.md) | 메타데이터·예산·권리·한국어 표시    |

## 화면·시장·알림

| 문서                                                                           | 내용                       |
| ------------------------------------------------------------------------------ | -------------------------- |
| [웹 안내](../apps/web/README.md) · [종목 화면](COMPANY_SCREEN.md)              | 탐색·차트·종목별 화면      |
| [관심 그룹](WATCHLIST_GROUPS.md) · [Web Push](WEB_PUSH.md)                     | 개인·공유 목록과 알림 설정 |
| [월간 시총 목록](MONTHLY_MARKET_LEADERS.md) · [국내 ETF](KOREAN_ETF_MASTER.md) | 선정·식별 정보·수동 검증   |
| [시장 지표](MARKET_INDICATORS.md) · [종목 로고](STOCK_LOGOS.md)                | 출처·갱신·표시 정책        |

## 날짜별 기록

다음 문서는 과거 분석과 적용 증거입니다. 당시 TypeScript 소스 경로, 임시 파일 경로, 테스트 수와 장애 상태를 현재 Python 워커의 상태로 해석하지 않습니다. 현행 명령은 위 가이드를 사용하고 외부 원문·백업은 해당 감사 명세로 찾습니다.

- 2026-09-05: [배포](DEPLOYMENT-2026-09-05.md), [번역 편집](TRANSLATION-EDITOR-2026-09-05.md). SEC 수집의 초기 결과는 [SEC 수집 문서의 과거 기록](SEC_COLLECTION.md#과거-실행-기록--2026-09-05-0006-kst)에 있습니다.
- 2026-09-06: [뉴스 배포](DEPLOYMENT-2026-09-06-WATCHLIST-NEWS.md), [관심방 배포](DEPLOYMENT-2026-09-06-WATCHLIST-ROOMS.md), [커넥터 설정 계획](CONNECTOR-SETUP-PLAN-2026-09-06.md), [커넥터 검증](CONNECTOR-VERIFICATION-2026-09-06.md), [SEC·뉴스 변경 전 분석](SEC_NEWS_IMPLEMENTATION_ANALYSIS.md), [구현 결과](SEC_NEWS_IMPLEMENTATION_RESULT_2026-09-06.md).
- 2026-09-09: [SEC 접근 재설정](SEC_ACCESS_RECONFIGURATION_2026-09-09.md), [SEC 복구 감사](SEC_RECOVERY_AUDIT_2026-09-09.md).
- 2026-09-10: [SEC Python 접근 검토](SEC_PYTHON_ACCESS_REVIEW_2026-09-10.md). Python 워커 전환의 진행·최종 결과는 [배포 문서](DEPLOYMENT.md#python-워커-전환-상태)에 기록합니다.

현행 문서 안에도 날짜가 붙은 감사 절이 있습니다. 예를 들어 [소스 안내](SOURCES.md)의 확장 전 repository audit와 [파싱 무결성](PARSER_INTEGRITY.md)의 2026-09-05 회귀 수치는 보존된 과거 기준입니다.
