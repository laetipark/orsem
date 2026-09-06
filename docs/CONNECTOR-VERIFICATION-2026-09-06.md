# NAVER·SEC·GDELT 추가 검증

검증일: 2026-09-06 KST. 실제 키·이메일·IP·기사 본문은 이 문서에 포함하지 않습니다.

최신 판정: NAVER는 계정 확인과 무료 한도 설정을 마치고 04:06 KST 실제 검색에 성공했습니다. SEC는 403 접근 거부, GDELT는 단독 검색 성공과 별개로 운영 수집의 429가 남았습니다. 두 커넥터는 04:00 KST 정기 작업에서도 같은 오류였고, 이번 NAVER 설정 과정에서 추가 강제 요청을 보내지 않았습니다.

## NAVER: 계정 확인·무료 한도 설정·실제 검색 성공

현재 공식 개요와 이용 준비 문서에서 한시적 무료 제공 및 유료 전환 사전 공지를 확인했습니다. 공식 무료 종료일은 제시하지 않습니다. 기존 Cloud 뉴스 API 주소와 인증 헤더 이름도 공식과 일치합니다.

처음에는 운영 키가 존재하고 PM2와 환경 파일의 값이 같아도 무료 확인 월·배정량·재확인 기한이 비어 있어 자동·수동 검색이 차단됐습니다. 사용자 로그인 후 04:03 KST 기존 `orsem` Application의 뉴스·웹문서 권한, 당일 0/25,000회, 당월 48/775,000회와 월 잔여 774,952회를 확인했습니다. 이는 NAVER 검색 카테고리 합산 사용량입니다. 실제 한도 설정과 상품 이용 중 상태를 읽었으며 계정의 한도나 인증 정보는 변경하지 않았습니다.

04:05:47 KST에 아래 앱 설정을 반영하고 API만 재시작했습니다. 기존 환경 파일·PM2 저장 파일을 먼저 백업했고, API/worker/웹/DB/번역 실행 파일은 변경하지 않았습니다. PM2 재부팅 복원에는 API의 해당 다섯 키만 반영했으며 전역 `pm2 save`는 실행하지 않았습니다.

| 설정                 | 운영 값                     |
| -------------------- | --------------------------- |
| 무료 확인 월         | `2026-09`                   |
| 앱 월 누적 배정 상한 | `30000`                     |
| 앱 일/월 호출 한도   | `1000` / `30000`            |
| 운영 재확인 기한     | `2026-09-13T00:00:00+09:00` |

04:06:06 KST에 배포된 검색 서비스와 DB 사용량 예약을 통해 삼성전자 검색을 1회 실행했습니다. 실제 공급자 HTTP 200, 결과 20개와 모든 항목의 링크를 확인했습니다. 앱 카운터는 0→1, 일 잔여 999회·월 잔여 29,999회였으며 NAVER `source_items`와 연결 `news_articles`는 검사 전후 모두 0건입니다. 기사 응답·검색어는 이 진단의 파일에 저장하지 않았습니다. 운영 키의 실제 승인과 무료 검색 경로가 확인됐습니다.

이어서 실제 회원 로그인 세션에서 뉴스 화면의 ‘네이버 직접 검색’으로 이동해 1회 검색했습니다. 화면에 외부 기사 링크 20개와 다음 결과 버튼이 표시됐고 인증·권한·한도·시간 초과 오류는 없었습니다. 자동 새로고침은 켜지 않았고 기사 DOM·원문·검색어는 파일에 저장하지 않았습니다. 04:08 KST 최종 서버 검사에서 총 2회 차감, 일 잔여 998회·월 잔여 29,998회, NAVER 기사 저장 0건과 API 준비 상태 200을 확인했습니다. 다른 모든 기존 PM2 프로세스 PID·상태와 관련 없는 환경·재부팅 복원 필드는 보존됐습니다.

설정 백업은 `/home/laeti/orsem-data/backups/naver-config-20260905T190546460Z`입니다. API PID는 139342로 바뀌었고 worker·Ollama·Discord PID는 유지됐습니다. API 준비 상태는 200입니다. 이 이후 PID는 앞선 배포의 역사적 기록과 구분합니다.

`NAVER_NEWS_FREE_UNTIL`은 현재 구현의 자동 중단 시각입니다. 위 9월 13일 00시 KST는 운영자가 무료 안내와 계정 사용량을 다시 확인할 기한이며, 공급자가 확정한 무료 종료일이 아닙니다. 그때까지 다시 확인하여 설정을 갱신하지 않으면 검색이 자동 중단됩니다. 월 변경에도 재확인이 필요합니다. 다른 클라이언트가 같은 키를 사용하면 공급자 합계가 앱 카운터보다 많을 수 있으므로 계정 사용량을 계속 대조합니다.

- [공식 개요](https://guide.ncloud-docs.com/docs/apihub-overview)
- [사용 준비](https://guide.ncloud-docs.com/docs/apihub-spec)
- [Application 권한·이용량 확인](https://guide.ncloud-docs.com/docs/apihub-application)
- [뉴스 API](https://api.ncloud-docs.com/docs/naver-api-hub-search-news)

## SEC: 자동화 도구로 분류한 403 응답 확인

배포된 어댑터의 요청을 로컬 수신 서버로 검사했습니다. 설정된 User-Agent가 실제 전달되고 Node가 Host와 gzip/deflate 헤더를 추가합니다. 10자리 CIK 공식 URL·JSON Accept·TLS 검증·현재 실행 환경도 대조했으며, 403을 설명하는 명확한 구현 불일치는 찾지 못했습니다.

03:30:01 KST에 기존 DB 대기가 끝난 뒤 단일 실제 요청을 보냈습니다. 정기 요청과 겹치지 않도록 해당 큐만 잠시 정지하고 검사 직후 재개했습니다. 기존 `createSecFetch`를 사용해 대기를 우회하지 않았습니다.

| 관측                | 결과                                               |
| ------------------- | -------------------------------------------------- |
| HTTP                | 403, 약 85ms                                       |
| 서버 헤더           | AkamaiGHost                                        |
| 콘텐츠 유형         | text/html                                          |
| 오류 페이지 유형    | Undeclared Automated Tool                          |
| 요청 빈도 초과 문구 | 검사한 범위에서 감지되지 않음                      |
| 공시 저장           | 0건                                                |
| 다음 요청 가능 시각 | 검사 직후 03:40:01 KST; 이후 상태는 운영 기록 참조 |

오류 HTML은 메모리에서 최대 8KiB만 검사하고 유형 플래그만 남겼습니다. 원문·요청자 IP·실제 연락처를 보고서에 저장하지 않았습니다. JSON 파싱 이전의 접근 차단이라는 점은 확인했으나, User-Agent 분류·송신 IP 평판·공유 네트워크 중 어떤 요인이 결정적이었는지는 이 응답만으로 확정할 수 없습니다.

SEC 공식 FAQ는 접근 거부가 지속되면 오류 정보와 IP를 포함해 webmaster에 문의하도록 안내합니다. 문의 초안은 아래와 같으며 **전송하지 않았습니다**. 실제 송신 IP와 운영 연락처는 사용자가 확인해 비공개로 보완합니다. [SEC 공식 FAQ](https://www.sec.gov/about/webmaster-frequently-asked-questions)

```text
Subject: Declared EDGAR client receives an Undeclared Automated Tool response

Hello SEC Webmaster,

Our Orsem service receives HTTP 403 from
https://data.sec.gov/submissions/CIK0001045810.json.

The latest diagnostic request was at 2026-09-05 18:30:01 UTC.
The HTML response identifies the request as an Undeclared Automated Tool.
We have verified that a User-Agent containing our application identity and
monitored contact email is transmitted, with gzip/deflate supported.

The current worker serializes SEC requests with at least 250 ms between
requests and waits at least ten minutes after a 403 or 429, honoring a longer
Retry-After. This diagnostic consisted of one request after that wait.

User-Agent: [actual application identity and monitored contact email]
Outbound public IP: [verify privately before sending]

Could you advise why this declared client is being classified this way
and what compliant changes are needed for access?

Thank you.
```

## GDELT: 10초 연결 제한 확인, 대기를 늘린 진단은 성공

| 관측                               | 결과                                        |
| ---------------------------------- | ------------------------------------------- |
| 기존 네이티브 fetch                | 약 10.5초 후 `UND_ERR_CONNECT_TIMEOUT`      |
| 앱 전체 HTTP 설정                  | 15초                                        |
| 별도 DNS 검사                      | 성공, 약 39ms, IPv4 응답                    |
| TCP 연결                           | 약 182ms                                    |
| TLS 연결 완료                      | 약 9.85초, 인증서 검증 통과, TLS 1.3        |
| 별도 연결 제한 20초·전체 30초 진단 | 약 13.13초에 HTTP 200, 유효한 기사 링크 1개 |
| 03:30 기존 운영 정기 작업          | HTTP 429, 저장 0건, 03:38:12 KST까지 대기   |

진단은 같은 공식 HTTPS DOC API와 최소 검색 `stock market`, 최근 1시간, 최대 1건으로 수행했습니다. 다른 IP·프록시·TLS 우회를 사용하지 않았습니다. 응답 본문을 저장하지 않고 개수와 링크 형식만 검사했습니다.

Undici의 기본 연결 제한은 10초이며 앱의 전체 요청 제한과 별개입니다. 관측한 TLS 지연과 성공한 비교 요청은 이 제한이 일부 실패에 기여함을 뒷받침합니다. 다만 429도 별도로 발생했으므로 시간 제한 변경만으로 수집이 항상 성공한다고 결론 내리지 않습니다. [Undici Connector 문서](https://github.com/nodejs/undici/blob/main/docs/docs/api/Connector.md)

GDELT 전용 transport를 추가해 연결 제한 20초, 전체 요청 제한 30초를 적용했습니다. 공식 HTTPS DOC API에만 적용하고 다른 URL의 기존 fetch 옵션은 그대로 전달합니다. 기존 호출 취소, 공유된 GDELT 요청·대기 상태, SEC의 DB 접근 정책, TLS 검증을 보존하며 전역 dispatcher는 바꾸지 않습니다. worker 종료 때 전용 Agent를 닫습니다. 기존에 설치된 Undici 6.28.0을 worker의 직접 의존성으로 명시했습니다.

검증은 4개 모음·45개 테스트 전체 통과(건너뜀 0), ESLint 및 격리 TypeScript 빌드 통과입니다. 별도 localhost TLS 재현에서 handshake를 11.5초 지연시키자 기존 연결은 10.517초 후 같은 오류로 끝났고 실제 수정 transport는 11.515초에 200 응답을 받았습니다. 이 재현은 외부 API 요청 없이 인증서 검증을 유지했습니다.

03:38:18 KST에 `worker.module.js`, `connectors/connector-adapters.js`, 새 `connectors/gdelt-http-transport.js`의 세 파일을 운영 반영했습니다. 기존 429 대기가 끝난 뒤 백업·큐 배수·worker 단독 재시작·큐 재개를 수행했습니다. API 준비 상태 200, 기존 API·Ollama·Discord PID 유지, API·웹·번역·DB 실행 파일·환경 파일 해시 보존을 확인했습니다. DB 마이그레이션과 전역 PM2 설정 저장은 실행하지 않았습니다.

백업은 `/home/laeti/orsem-data/backups/gdelt-connect-20260905T183813028Z`입니다. 장애 시 이 백업의 세 파일만 되돌리고 worker를 재시작하며 이미 저장한 데이터는 보존합니다. 이전 관심그룹 배포 보고서의 worker PID·세 파일 해시는 이 후속 배포로 변경되었습니다.

첫 운영 검증(03:38:41–03:38:52)은 연결 시간 초과 없이 429 응답을 받았고 저장은 0건이었습니다. 이후 대기를 지킨 단독 진단에서 운영과 같은 거시경제 조건·한국어/영어·최근 24시간·최대 250건으로 조회했을 때 03:40:33에 HTTP 200과 유효한 링크 250건을 받았습니다. 이 단독 진단 결과는 뉴스 DB에 저장하지 않았습니다.

묶음 수집은 요청 시작 시각으로만 최소 간격을 계산하고 있었습니다. 첫 TLS 연결·응답에 5초 이상 걸리면 다음 요청을 완료 직후 즉시 보낼 수 있어, 재사용된 연결에서 공급자가 관측하는 요청 간격은 짧아질 수 있습니다. 응답 본문 처리 완료 또는 실패 후에도 최소 5초를 보장하도록 보완했습니다. 이것이 모든 429의 유일한 원인이라고 단정하지 않습니다.

느린 응답·실패 뒤 요청 간격을 검사하는 두 회귀 테스트가 기존 코드에서 실패하고 수정 후 통과하는 것을 확인했습니다. 최종 6개 모음·67개 테스트 전체 통과(건너뜀 0), ESLint 및 격리 TypeScript 빌드 통과입니다. 03:44:12 KST에 `connectors/connector-adapters.js` 한 파일만 추가 배포했습니다. 백업은 `/home/laeti/orsem-data/backups/gdelt-connect-20260905T184407438Z`이며, 해당 보완만 복구할 때는 이 백업의 어댑터를 사용합니다. 첫 연결 제한 변경까지 복구할 때는 앞선 세 파일 백업을 사용합니다.

최종 운영 검증은 03:44:31–03:44:42 KST에 실제 큐 경로로 실행했습니다. 결과는 `DEGRADED`, HTTP 429, 수집·저장 0건이었으며 다음 요청 가능 시각은 검사 직후 03:45:42 KST였습니다. 작업의 `completed`는 작업 처리가 종료됐다는 뜻이며 기사 수집 성공을 뜻하지 않습니다. 기사 저장과 화면 조회까지의 완료 기준은 **미충족**입니다. 추가 즉시 요청이나 제한 우회는 하지 않았고 기존 30분 정기 수집과 대기 정책을 유지합니다.

마지막 코드 대조에서 첫 거시경제 요청의 URL·파라미터·Accept·리다이렉트 정책은 성공한 단독 진단과 같았습니다. 운영은 기업별 요청까지 묶어서 완료한 뒤 저장하므로 `seen=0`만으로 첫 요청이 실패했다고 판단할 수 없습니다. 별도 프로세스의 단독 진단과 운영의 공유 연결·묶음 실행에는 차이가 있으나, 현재 기록으로 어느 요청에서 429가 발생했는지와 그 원인을 확정할 수 없습니다. 다음 진단에는 원문 없이 요청 순서·상태·실제 간격을 기록하는 관측이 필요합니다.

두 후속 배포 모두 worker만 재시작했습니다. 03:47 KST 최종 검사에서 API 준비 상태 200, 전체 운영 프로세스 online, 모든 큐 재개, 환경 파일 및 관련 없는 API·웹·DB·번역 실행 파일 해시 보존을 확인했습니다. 이 보고서와 테스트·진단의 비밀 없는 결과는 마지막 백업의 `verification` 폴더에 보관합니다.
