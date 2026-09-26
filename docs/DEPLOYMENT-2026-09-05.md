# 2026-09-05 종가 표시·번역 검증 운영 배포

사용자의 운영 배포 요청에 따라 23:36 KST에 https://orsem.laetipark.me 에 반영했다.

## 반영 범위

- API: `live-price.service.js` 교체와 기존 `orsem-data.service.js`의 `previousDailyCloses` 권리 필터만 적용했다. 현재 작업 트리의 API 전체를 배포하지 않았다.
- Worker: 반기 검사의 `news-translation-facts.js`와 일치하는 소스맵만 교체했다. 현재 운영 클라이언트와 동일한 export를 사용한다.
- 웹: 현재 작업 트리의 호환되는 전체 웹을 production 빌드했다. `VITE_FIXTURE_MODE=false`, `FIXTURE_MODE=false`, `VITE_NEWS_TRANSLATION_EDITOR_ENABLED=false`, `VITE_API_BASE_URL=/api/v1`을 명시했다.
- DB 스키마·공유 DB/계약 패키지·환경 설정·모델·Nginx 설정은 유지했다. 관리자 편집·본문 조각 재사용의 서버 기능은 이번 배포에 포함되지 않는다.

API와 worker만 각각 한 번 재시작했다. Ollama와 Discord는 기존 PID를 유지했다. 여덟 worker 큐를 일시 정지하고 활성 작업 0개를 확인한 뒤 반영했으며, 모든 큐의 원래 재개 상태를 복원했다. 웹은 새 자산을 먼저 복사하고 `index.html`을 마지막에 교체했다. 기존 해시 자산은 열린 브라우저와 복구를 위해 보존했다.

## 검증

- 운영 모듈을 결합한 API 테스트 13개, compiled 사실검사 232개와 운영 번역 클라이언트 호환성 검사 8개, 웹 관련 테스트 69개 통과. 격리 TypeScript 컴파일·웹 타입검사 통과.
- 공개 사이트와 API readiness HTTP 200. 운영 API·worker의 새 시작 로그에 검사한 오류 패턴이 없고 정상 준비 메시지를 확인했다.
- 기존 DB·Redis와 배포된 서비스로 삼성전자·컴투스·제테마의 2026-09-04 종가 대체 응답을 확인했다. 미국 종목은 국내 종가 대체에서 제외됐다.
- 로그인된 운영 브라우저의 삼성전자 상세와 관심기업 화면에서 **최근 거래일 종가**, **₩257,000**, **2026. 09. 04. 종가 · 토스증권 국내 일봉**을 확인했다. 금액은 기존 저장값과 대조한 것으로 별도 외부 시세 검증은 아니다.
- 앞서 보정한 제목·요약 31건과 본문 16건(175블록)의 저장값, 원문·권리·해시 보존, 운영 API 읽기를 배포 후 재검증했다. 긴 본문 실패 54건은 이번 배포에서 처리하지 않았다.

## 복구 자료

비공개 배포·백업 폴더:

`../orsem-data/backups/production-close-translation-20260905T143135Z`

`runtime-before.tar.gz`에 기존 API·worker·웹과 공유 패키지 산출물, `before.json`에 원본 파일 해시와 프로세스 정보를 보존했다. `plan.json`과 `candidate/`에 반영한 파일 및 웹 전체 산출물, 검증 JSON에 배포 후 상태를 보존한다. 비밀 환경 파일은 이 백업에 포함하지 않는다.

복구할 때는 작업 큐를 드레인한 후 `plan.json`의 대상 네 파일과 이전 웹 산출물을 복원하고 API·worker만 재시작한다. readiness와 큐 복원을 확인한다. 공유 패키지나 DB 스키마를 롤백할 필요는 없으며, 앞서 적용한 재번역 데이터도 이 코드 복구의 대상이 아니다.
