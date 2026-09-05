# 사이트 콘텐츠용 뉴스 수집

2026-09-05 구현. `/news`에는 본문을 저장하고 승인 회원에게 표시할 수 있으며, 영문인 경우 로컬 한국어 번역까지 완료된 기사만 나타납니다. 제목·링크만 허용되는 소스는 정기 수집과 통합 뉴스 DB에 넣지 않습니다. OpenDART와 SEC 공시는 기존 이벤트·공시 화면에서 계속 처리합니다.

## 활성 소스

| 런타임 ID        | 소스                       | 본문 경로                                                           | 권리와 표시                                         | 주기 |
| ---------------- | -------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- | ---- |
| `samsung-global` | Samsung Global Newsroom    | 등록된 Global RSS의 `content:encoded`, 필요할 때 같은 공식 기사 URL | 로그인한 개인·승인 회원에게만 원문과 로컬 번역 표시 | 15분 |
| `fed-press`      | Federal Reserve 보도자료   | 공식 RSS가 가리키는 Fed 본문                                        | 공식 사이트의 공개 영역 텍스트, 제3자 자료 제외     | 15분 |
| `fed-speeches`   | Federal Reserve 연설·증언  | 공식 RSS가 가리키는 Fed 본문                                        | 공식 사이트의 공개 영역 텍스트, 제3자 자료 제외     | 15분 |
| `bls-latest`     | Bureau of Labor Statistics | 공식 RSS가 가리키는 BLS 본문                                        | 공개 영역 텍스트, 사진·삽화·로고 제외               | 15분 |

근거는 [Samsung Global 이용약관](https://news.samsung.com/global/terms), [Fed 저작권·면책 안내](https://www.federalreserve.gov/disclaimer.htm), [BLS 저작권 안내](https://www.bls.gov/opub/copyright-information.htm)입니다. Samsung 콘텐츠는 `PRIVATE_DISPLAY_ONLY`, Fed·BLS 텍스트는 `OFFICIAL_PUBLIC_DATA`로 기록합니다.

이투데이, Microsoft IR, GDELT와 NAVER는 사이트 본문으로 저장·번역할 권리가 확인된 활성 소스가 아닙니다. 이투데이·Microsoft IR 정기 수집과 GDELT는 비활성화합니다. NAVER는 사용자가 직접 실행하는 저장하지 않는 검색 화면만 유지하며, 통합 뉴스·검색·AI·알림에 연결하지 않습니다. 설정 스키마는 위 RSS ID 외의 값을 거절하고, IR 생성·수정 API는 정확한 Samsung Global URL·RSS·`PRIVATE_DISPLAY_ONLY` 조합만 허용합니다. 조사 후보를 환경 변수에 적어도 런타임 소스로 등록되지 않습니다.

## 저장과 공개 조건

`source_items`는 원출처 제목·URL·GUID·작성자·원래 발행 문자열·발행 시각·최초 관측 시각·권리 정책을 보존합니다. `news_article_contents`는 출처 항목 하나에 대응하며 정화된 원문 블록, 언어, 본문 해시, 추출 상태·버전·시각, 정책 스냅샷과 번역 처리 이력을 저장합니다. 서로 다른 출처의 본문을 합치지 않습니다.

본문 프로필은 다음 조건을 모두 명시해야 합니다.

- `fullTextStorageAllowed === true`
- `displayAllowed === true`
- 영문이면 `aiAllowed === true`
- 정책 URL과 확인 날짜, 정확한 피드·기사 호스트
- `OFFICIAL_PUBLIC_DATA` 또는 인증된 개인 화면용 `PRIVATE_DISPLAY_ONLY`

`UNKNOWN`과 `false`는 허용으로 해석하지 않습니다. 기사 원문은 HTTPS와 등록된 공개 호스트에서만 가져오며 모든 리디렉션과 DNS 결과를 다시 검증합니다. HTML은 실행하지 않고 제목·문단·인용·목록의 일반 텍스트 블록으로 바꿉니다. 이미지·영상·광고·스크립트·스타일·폼·iframe과 추적 요소는 저장하거나 표시하지 않습니다.

한국어 본문은 추출이 끝나면 공개할 수 있습니다. 영문 본문은 원문 제목 번역과 모든 본문 블록 번역이 현재 해시와 일치해야 공개합니다. 추출·번역이 대기 또는 실패 상태인 항목은 내부 재시도 대상으로만 두고 `/news`에는 반환하지 않습니다.

## 삼성 발행 시각

Samsung Global RSS는 시·분을 `Asia/Seoul`의 wall clock으로 처리합니다. 예를 들어 원본 `Fri, 04 Sep 2026 21:30:00 +0000`은 `2026-09-04 21:30 KST`, 저장 instant는 `2026-09-04T12:30:00Z`입니다. 원본 문자열과 보정 규칙 버전을 함께 보존합니다. 다른 피드는 명시된 UTC 오프셋을 그대로 존중하며 시간대가 없는 값은 추정하지 않습니다.

기존 Samsung Global 행은 대상 피드 URL을 정확히 제한한 마이그레이션으로 9시간 보정합니다. `source_items.published_at`, 대응하는 `news_items.published_at`, 기사 묶음 정렬 시각만 갱신하고 `first_observed_at`은 바꾸지 않습니다.

## 설정과 운영 확인

```dotenv
NEWS_RSS_FEEDS=fed-press,fed-speeches,bls-latest
IR_FEED_URLS=https://news.samsung.com/global/feed
GDELT_ENABLED=false
GDELT_NEWS_DOMAINS=
NEWS_TRANSLATION_ENABLED=true
```

본문 수집은 뉴스 발견 뒤 별도 작업으로 순차 처리합니다. 원문 해시, 정책, 추출기, 모델이나 번역 프롬프트 버전이 바뀌면 이전 결과를 공개하지 않고 다시 처리합니다. 실제 원문은 테스트 fixture로 커밋하지 않으며 합성된 최소 RSS·HTML만 사용합니다.

배포 확인에는 마이그레이션 전 백업, 이용 불가 뉴스 삭제 건수, 활성 피드별 HTTP 상태, 본문 추출 상태, 번역 대기·실패 건수, `/news`의 소스 목록, Samsung KST 표시와 재수집 시 중복 증가 여부가 모두 포함됩니다.
