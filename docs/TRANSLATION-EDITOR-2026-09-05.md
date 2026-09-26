# 뉴스 번역 재사용·관리자 편집 검증 결과

2026-09-05 KST 기준. 구현과 전체 검사는 완료했으며 이번 후속 기능의 운영 적용은 보류되어 있다. 앞서 적용한 메모리·반응형·공시 건수·커넥터 분류 개선은 유지한다.

후속 정리에서 Azure 연결 어댑터·제공자 선택·월 문자 예약 기능과 전용 테스트는 삭제했다. 아래 Azure 구현·검사 결과는 삭제 전 이력이며 현재 기능이 아니다. 현재 번역 설정은 [로컬 번역 안내](NEWS_TRANSLATION.md)를 따른다.

## 확인과 변경

- 변경 전 집계에서 완료된 제목 89건, 본문 23건은 모두 처리 횟수 1회였다. 완료된 동일 기사를 반복 번역했다는 증거는 없었다. 본문 실패 16건 중 14건에 재시도 기록이 있었으며 최대 3회, 실패 코드는 VALIDATION이었다. 동일 기사 중복 원문·본문 집계는 0건이었다.
- 실제 낭비 가능성이 있던 실패 후 앞쪽 본문 재처리, 부수 메타데이터 해시 변경, 수집과 작업 점유의 경쟁 조건을 수정했다. 완료 입력과 조각을 재사용하고 작업 토큰·원문 해시를 비교하여 저장한다. 번역 응답 성공과 DB 저장 사이의 프로세스 중단까지 정확히 한 번을 보장하지는 않는다.
- ADMIN 전용 Markdown 편집기에서 원문을 참고하며 제목·요약·본문을 수정한다. 별도 수정본과 감사 이력에 저장하여 원문과 자동 번역은 보존한다. 권한·CSRF·충돌 409·안전한 Markdown·원문 변경 후 관리자 복구·감사 이력 전체 일치 검사를 추가했다.
- Azure 연결 어댑터와 월 문자 예약 한도를 구현했다. 실패 시 다른 제공자로 자동 전환하지 않으며 운영 설정은 LOCAL을 유지했다. Azure 실서비스 키를 연결하거나 외부 번역을 요청하지 않았다.

## 검증

- 전체 `npm run check` 통과: 형식·린트·타입 검사, 스크립트 33개, API 229개, Discord 4개, 웹 199개, worker 434개, 계약 23개, DB 34개, 파서 115개, 합계 **1,071개 테스트**.
- 전체 `npm run build` 통과. 편집기는 별도 지연 로딩 묶음 126.79KB / gzip 37.07KB, 초기 JS는 303.56KB / gzip 97.35KB.
- 실제 Redis의 격리된 테스트 큐 2개에서 한도 100자에 동시 50회×3자를 예약: 33회 성공·17회 거절·99자. 추가 1자로 100자 도달 후 요청 차단. 손상된 카운터와 잘못된 입력은 실패 시 요청 차단. 테스트 키 정리 후 잔여 0개, Azure HTTP 0회.
- 실제 브라우저의 fixture에서 관리자 로그인, 원문 참고, Markdown 미리보기, 저장 후 제목·요약의 카드 반영, 원문 유지, 기사 이동 후 초안 복원을 확인했다. 입력과 미리보기 화면에서 320·375·620·621·768·900·901·1100·1101·1440px 가로 넘침이 없었다. 운영 기사를 시험 수정하지 않았다. 취소 확인 대화상자의 브라우저 검증은 자동화 세션이 중단되어 완료하지 못했으며 관련 단위 테스트 결과와 구분한다.

## 운영 적용 상태

새 관리자 수정 기능에는 nullable JSON 컬럼 2개와 `news_translation_revisions` 이력 테이블이 필요하다. 대상은 `AddManualNewsTranslations1788405000000` 마이그레이션 1개로 확인했고 원본 행과 테이블 정의를 저장소 밖에 백업했다. 원문 수정·삭제·기존 행 재작성은 포함하지 않는다.

운영 DB 적용 호출은 초기 계획의 마이그레이션 없음 조건 및 별도 운영 DB 변경 승인 부족을 이유로 자동 승인 검토에서 거절됐다. SQL은 실행되지 않았다. 현재 API·worker 프로세스는 재시작하지 않았고 잠시 대기시킨 AI 큐는 재개했다. DB와 호환되는 기존 웹·서버 빌드를 복원했으며 검증된 새 빌드는 저장소 밖 candidate 디렉터리에 보관했다. 따라서 관리자 편집과 새 번역 처리 방식은 아직 운영 활성화 전이다.

승인 후에는 진행 중 번역 완료 → 최신 백업 → 위 마이그레이션 적용 → 검증된 API·worker·웹 빌드 반영 → 준비 상태와 큐 확인 순서로 진행한다. Discord와 Ollama 설정은 이번 후속 적용에서 바꿀 필요가 없다.

측정·검사 로그와 DB 백업은 `../../../tmp/orsem-translation-editor`에 있으며 실제 데이터와 자격 증명은 저장소에 넣지 않았다.

## 무료 번역 대안 재검토

| 선택지                           | 현재 무료 조건과 제약                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 현재 LOCAL Qwen                  | 외부 API 비용 없이 실행 중. 서버 자원 사용. 지속 무료 우선이면 추가 계정 없이 유지 가능.                                    |
| LibreTranslate/Argos 자체 호스팅 | 영어→한국어 지원, 외부 API 요금 없음. 별도 설치·품질·메모리 비교 필요. 운영자가 제공하는 호스팅 API는 유료.                 |
| DeepL 신규 Developer             | 총 100만 자 무료, 소진 후 재설정 없음. 기존 월 50만 자 Free는 신규 구매 종료.                                               |
| Google Cloud Translation NMT     | 월 50만 자 무료 크레딧, 결제 계정 필요. 초과 과금 방지를 위한 별도 한도 필요.                                               |
| Azure Translator F0              | 월 200만 자 무료. 현재 계정의 Students Starter 지원 목록에 Translator가 없으며 실제 생성 화면의 지역도 비어 있어 연결 중단. |
| Papago API                       | 상시 무료 API로 확인되지 않음. 유료 서비스.                                                                                 |

공식 근거: [LibreTranslate 언어](https://docs.libretranslate.com/guides/supported_languages/), [자체 호스팅 FAQ](https://docs.libretranslate.com/guides/faq/), [DeepL 최신 플랜](https://support.deepl.com/hc/en-us/articles/360021200939-DeepL-API-plans), [Google 가격](https://cloud.google.com/products/translate/pricing), [Google 결제 설정](https://docs.cloud.google.com/translate/docs/setup), [Azure 가격](https://azure.microsoft.com/en-us/pricing/details/translator/), [Students Starter 범위](https://learn.microsoft.com/en-us/azure/education-hub/azure-dev-tools-teaching/program-faq#azure-for-students-starter), [Papago 요금](https://www.ncloud.com/charge/price/ko).

현재 구독의 업그레이드나 새 유료 계정 가입은 진행하지 않았다. 지속 무료라는 사용자 조건에 따라 LOCAL을 계속 사용하며, 다른 제공자로 바꾸는 작업은 대안의 실제 조건과 품질을 확인한 뒤 결정한다.

## 웹 활성화 조건

번역 편집 UI는 `VITE_NEWS_TRANSLATION_EDITOR_ENABLED=true`인 웹 빌드에서만 활성화됩니다. 기본값은 비활성입니다. 수동 번역 마이그레이션과 편집 API가 적용된 뒤에만 이 값을 활성화해 웹을 빌드합니다. 검색·종목 화면만 배포할 때는 비활성으로 유지합니다.
