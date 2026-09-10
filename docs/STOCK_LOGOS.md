# 종목 로고 운영 및 출처 검수

공식 문서 확인일: **2026-09-10 (KST)**. 아래 내용은 이 날짜에 열람한 공식 페이지에 근거한다. 무료 조건은 계정 대시보드와 함께 재확인하며, 조건이 충돌하거나 권한이 확인되지 않으면 더 제한적인 조건을 적용한다. 외부 공급자 계정 생성, 유료 구독, 카드 등록, 자동 충전, 초과 과금 설정을 이 작업에서 실행하지 않는다.

## 기존 구조와 변경 경계

- Node.js 24 / npm workspaces / TypeScript strict 구조다. 웹은 React 19 + Vite 7, 테스트는 Vitest + Testing Library + jsdom이다. Next.js 또는 이미지 최적화 서버가 아니다.
- API는 NestJS / Express, DB는 TypeORM / MySQL이며 마이그레이션을 사용한다. `synchronize: false`를 유지한다. API와 contracts 테스트는 TypeScript 컴파일 후 Node 내장 test runner를 실행한다. Python worker와 기존 TypeScript worker 코드는 함께 존재한다.
- 종목 식별자는 기존 `companies.id` UUID다. `market + stockCode`, `market + ticker`에 별도 유일성이 있다. `stock_code`는 문자열 `CHAR(6)`, `ticker`는 문자열 `VARCHAR(32)`, OpenDART `corp_code`는 별도의 `CHAR(8)`이다. 로고 공유를 이유로 종목 ID, 보통주·우선주, 주식 클래스, 가격 또는 보유 데이터의 식별자를 합치지 않는다.
- 종목 목록·상세·관심종목·최근 종목 등은 공통 `apps/web/src/components/company-avatar.tsx`를 사용한다. 기존 `brand-logo.tsx`는 서비스 자체 ORSEM 로고다.
- Vite는 저장소 루트 `.env`를 읽는다. `VITE_*`는 빌드 시 브라우저에 노출되므로 비밀 키를 넣지 않는다. API/worker는 런타임 설정 검증과 서버 `.env`를 사용한다. PM2의 기존 환경이 남을 수 있어 `ecosystem.config.cjs`의 `fileBackedEnvironment` 목록을 통한 설정 전달을 확인한다. 키 값은 문서나 로그에 출력하지 않는다.
- 기존 로고 코드는 `source_checkpoints`의 `COMPANY_LOGO` / `COMPANY_LOGO_REQUEST`에 메타데이터를 보관하고 웹 메모리 캐시를 사용했다. 로고 이외의 종목 메타데이터·시세 캐시는 변경 대상이 아니다. `apps/web/public/sw.js`는 알림 전용이며 이미지 요청을 가로채거나 캐시하지 않는다.
- 작업 전 Python `market/logos.py`는 Finnhub/Tickerlogos 이미지를 서버에서 검증하고 `market/__init__.py`가 60초마다 갱신했다. 이 경로를 새로운 무료 공급자 이미지 수집기로 재사용하지 않는다. 과거 `verifiedAt`는 이미지 로드/형식 검사 결과여서 기업 로고에 대한 수동 검수 증거가 아니다.
- Nginx 템플릿은 `deploy/nginx/orsem.laetipark.me.conf`다. 기본 `Referrer-Policy`는 `strict-origin-when-cross-origin`, 작업 전 CSP는 popout의 `frame-ancestors` 제한뿐이다. API의 Helmet CSP는 비활성화되어 있다. 새 이미지 CSP를 적용할 때 실제 사용하는 호스트만 허용하며, 템플릿 수정과 운영 Nginx 반영은 구분한다.

## Logo.dev: 기본 공급자

[가격표](https://www.logo.dev/pricing)의 Community는 월 $0, 월 500,000 요청, 카드 불필요다. Logo API 요청과 유료 Brand API 크레딧은 구분한다. 무료 요금제의 한도를 늘리기 위해 유료 전환하지 않는다. 기존 서버·DB·트래픽 비용은 이 무료 외부 API 요금과 별도다.

[티커 문서](https://www.logo.dev/docs/logo-images/ticker)는 미국 종목의 무접미사 조회와 한국 `.KS` / `.KQ`를 설명한다. `.KS`는 KOSPI, `.KQ`는 KOSDAQ로 확인된 거래소 정보가 있을 때만 적용한다. `KRX`라는 포괄 정보만으로 접미사를 결정하지 않는다. 이미 접미사가 있는 코드는 중복 추가하지 않는다. 미국 클래스 티커의 점·하이픈 변환은 이 문서에서 확인되지 않았으므로 `BRK.B → BRK-B`를 일반 규칙으로 만들지 않는다.

[도메인 문서](https://www.logo.dev/docs/logo-images/get)에 따라 publishable key, `size=128`, `format=webp`, `fallback=404`를 사용한다. `theme=auto`는 색상 보정 없음이며 `light` / `dark`는 투명 로고의 지배적인 밝은색/어두운색을 배경에 맞게 반전할 수 있다. 전역 CSS 필터로 기업 색상을 반전하지 않고 기본 로고 표면을 안정적으로 제공한다. URL 생성이나 HTTP 이미지 로드 성공만으로 기업 로고가 맞다는 검수 결과를 저장하지 않는다.

```text
https://img.logo.dev/ticker/{providerTicker}?token={publishableKey}&size=128&format=webp&fallback=404
https://img.logo.dev/{verifiedDomain}?token={publishableKey}&size=128&format=webp&fallback=404
```

[출처 표시 문서](https://www.logo.dev/docs/platform/attribution)는 무료 상업적 이용 시 화면에 보이는 링크를 요구한다. 로고가 보이는 앱 화면에 `Logos provided by Logo.dev` 링크를 표시하고 로그인 없이 접근할 수 있는 공개 안내 페이지에도 표시한다. 링크에는 `noreferrer`를 붙이지 않으며 production URL을 공급자 대시보드에서 검증해야 한다. 앱에 코드가 존재하는 것과 대시보드에서 승인된 것은 구분한다.

[자체 호스팅 문서](https://www.logo.dev/docs/platform/self-hosting)는 Pro/Enterprise/별도 계약에 자체 저장 권한을 부여한다. 무료 기능에는 외부 이미지 일괄 다운로드, 자체 스토리지 저장, 이미지 프록시 또는 CDN 재호스팅을 넣지 않는다. 브라우저가 공급자 응답에 따라 수행하는 기본 캐시는 방해하지 않는다.

## Brandfetch: 선택적 보조 공급자

[가격표](https://brandfetch.com/developers/pricing)의 표에는 무료 Logo API **월 1,000,000** 요청, 같은 페이지 FAQ에는 Logo CDN과 Search 각각 **월 500,000** 요청이라고 적혀 있다. [Logo API 개요](https://docs.brandfetch.com/logo-api/overview)도 월 1,000,000 요청을 명시하므로 공식 안내가 서로 일치하지 않는다. **계정 대시보드 확인 전 월 500,000 이하를 내부 상한**으로 적용한다. 무료 플랜은 카드가 필요 없고 Logo API는 Brand API의 일회성 100 fetch와 다른 제품이다. 초과 사용은 즉시 차단이 아닌 soft limit일 수 있으므로 공급자 차단에만 의존하지 않는다.

캐시도 불일치한다. 가격표 FAQ는 로고의 로컬 캐시를 안내하지만 Logo API 개요의 usage guidelines는 브라우저 직접 임베드, 원본 origin을 담은 `Referer`, 프로그램 방식 이미지 접근 금지 및 캐시 필요 시 별도 계약을 명시한다. **직접 `<img>` 표시만 사용하고 서버 fetch, curl 배치 검증, 저장/다운로드 프록시를 만들지 않는다.** `referrerPolicy="origin"`으로 사이트 origin만 전송한다. 공개 Client ID를 매 요청에 넣고 서버 secret/API key로 대체하지 않는다. Logo API 자체의 출처 링크는 의무가 아니지만 출처 기록은 유지한다.

[파라미터 문서](https://docs.brandfetch.com/logo-api/parameters)의 명시적 `ticker/` / `domain/` 경로를 사용해 식별자 자동 추론의 충돌을 피한다. `fallback/404`는 404와 투명 placeholder 응답을 뜻한다. `theme/light`, `theme/dark`는 밝은/어두운 버전의 로고이며 Logo.dev 배경 보정 의미와 같다고 가정하지 않는다. 한국 티커 표기는 위 문서만으로 확인되지 않았으므로 자동 생성하지 않는다. 한국 보조 조회는 기업 매핑이 검수된 도메인 또는 별도로 응답까지 확인한 공급자 매핑만 사용한다.

```text
https://cdn.brandfetch.io/ticker/{providerTicker}/w/128/h/128/fallback/404?c={clientId}
https://cdn.brandfetch.io/domain/{verifiedDomain}/w/128/h/128/fallback/404?c={clientId}
```

## 로컬 파일과 검수 기록

[Simple Icons 저장소](https://github.com/simple-icons/simple-icons)의 프로젝트 라이선스는 CC0다. 하지만 [DISCLAIMER](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md)는 **개별 아이콘이 모두 CC0라는 뜻이 아니며**, 개별 라이선스·상표·브랜드 가이드라인을 확인해야 한다고 설명한다. 개별 라이선스 데이터가 비어 있다는 이유로 사용 권한을 승인하지 않는다. 사용할 파일만 개별 원본/가이드라인과 기업 매핑을 확인해 등록한다.

[Wikimedia Commons 재사용 안내](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)는 파일별 설명 페이지에서 라이선스를 확인하고 요구되는 저작자·라이선스 링크·수정 사항 표시를 준수하도록 안내한다. Commons에 있다는 이유만으로 적합한 이용 조건이나 정확한 기업 매핑이 보증되는 것은 아니다. 상표 등 저작권 외 제한도 확인한다. uploader와 원저작자가 다르면 원저작자를 기록한다.

개별 로고 승인 시 다음을 함께 보관한다.

- 종목 UUID, market/exchange/symbol/assetType, 별도 issuerId.
- 공급자별 ticker 또는 domain, 검수된 officialDomain, 매핑 근거 URL.
- 로컬 경로, 원본 파일의 설명 페이지 URL, 출처, 라이선스명·URL, 저작자 및 필요한 표시 문구, 수정 여부.
- `logoRole` (`company`, `fund`, `issuer`, `fallback`), 검수 상태, 검수 일시/검수자, 공급자 활성화 여부.

ETF 로고는 상품(`fund`)과 운용사(`issuer`)를 구분한다. 운용사 로고를 대신 표시하더라도 ETF 이름·티커는 함께 남긴다. 상품명 접두사, 기초지수 또는 주요 편입기업만으로 운용사/상품 로고를 결정하지 않는다. 검수되지 않은 항목은 자체 텍스트·도형 아이콘으로 표시할 수 있다. 이 작업에서 다운로드한 Simple Icons/Wikimedia 기업 로고는 **없다**. 검수되지 않은 파일을 먼저 저장하여 커버리지를 늘리지 않는다.

## OpenDART 기업 도메인 후보

[기업개황 공식 문서](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)의 `company.json`은 8자리 문자열 `corp_code`와 서버용 `crtfc_key`를 받으며 `hm_url` 홈페이지를 반환한다. 이 API는 로고 API가 아니다. 6자리 주식 코드를 `corp_code`에 넣지 않는다.

기존 매핑은 `companies.corp_code`다. 기존 Python `apps/worker/python/orsem_worker/disclosures/client.py`의 `company_information`과 TypeScript `apps/worker/src/opendart/opendart.client.ts`의 기업정보 조회가 이미 `company.json`을 호출한다. `company_information_snapshots.raw_json.annual.profile.hm_url`을 재사용하여 **후보**로 제시할 수 있다. 종목코드/고유번호 일치, URL 정규화, 기업 홈페이지 여부를 검수한 후에만 `officialDomain`으로 승인한다. 홈페이지 문자열을 얻었다는 사실만으로 승인하지 않는다. ETF에는 일반 상장회사 경로를 자동 적용하지 않는다. 이 기능을 위해 전 종목 수집을 새로 실행하지 않는다. 기존 `OPENDART_API_KEY`를 브라우저에 노출하지 않는다.

## 무료 운영 원칙과 실패 해석

1. 모든 공급자 키가 없거나 공급자가 비활성화되면 검수된 로컬 로고와 자체 아이콘만으로 화면을 유지한다.
2. 후보 순서는 관리자 지정 → 검수된 로컬 → Logo.dev 티커 → 검수된 도메인/보조 공급자 → ETF의 검수된 운용사/브랜드 → 자체 아이콘이다.
3. 가시 영역부터 단일 후보를 요청한다. 한 렌더링에서 외부 후보는 기본 최대 2개이며 병렬 이미지 사전 요청은 하지 않는다.
4. 이미지 에러는 다음 후보로 넘어가고 실패 URL을 짧게 기록해 반복 요청을 억제한다. 원인이 관측되지 않은 브라우저 이미지 에러를 HTTP 404/403/429로 기록하지 않는다. 일시 장애를 영구 로고 없음으로 저장하지 않는다.
5. 공급자 전체를 비활성화할 수 있어야 한다. 무료 한도 소진 시 자체 아이콘으로 전환하고 초과 과금/업그레이드로 우회하지 않는다. 자체 요청 예약 수는 실제 공급자 청구 계량과 다를 수 있으며 다른 앱/배포에서 같은 키를 사용하면 대시보드 사용량도 함께 확인한다.
6. 매핑 메타데이터 캐시는 이미지 파일 캐시와 별개다. 메타데이터 조회 실패나 로고 이미지 실패로 종목명·가격·수익률·차트를 차단하지 않는다.
7. 외부 SVG를 HTML로 삽입하지 않는다. 관리자 지정도 기존 권한 검사와 검수된 로컬 경로 제한을 거친다. 임의 외부 URL을 서버가 받아 다운로드하는 기능은 제공하지 않는다.

## 구현 연결 정보

계약 스키마는 `packages/contracts/src/company-logos.ts`, 메타데이터 API는 `apps/api/src/resources/company-logo.service.ts`에 있다. 아래 경로는 기본 API prefix `/api/v1`을 기준으로 한다.

| 환경변수                   | 기본값 / 조건                                      |
| -------------------------- | -------------------------------------------------- |
| `LOGO_DEV_ENABLED`         | `false`; `true`여도 키·Redis·양수 한도가 모두 필요 |
| `LOGO_DEV_PUBLISHABLE_KEY` | 미설정; 공개용 `pk_` 키만 허용                     |
| `LOGO_DEV_MONTHLY_LIMIT`   | `500000`; 범위 `0`–`500000`, `0`이면 비활성        |
| `BRANDFETCH_ENABLED`       | `false`; 선택적 보조 공급자                        |
| `BRANDFETCH_CLIENT_ID`     | 미설정; 공개 Logo API Client ID                    |
| `BRANDFETCH_MONTHLY_LIMIT` | `500000`; 범위 `0`–`500000`, `0`이면 비활성        |

서버는 이미지 표시에 필요한 공개 키/Client ID만 브라우저에 전달한다. `VITE_*`에 서버 secret을 넣지 않는다. Logo.dev secret key, Brandfetch Brand API key는 필요 없다. 키 없이도 실행되며 fixture mode에서도 외부 공급자를 사용하지 않는다. 공급자 장애 시 해당 `*_ENABLED=false` 또는 `*_MONTHLY_LIMIT=0`으로 설정하고 API 프로세스 환경을 갱신한다. 이미 열린 화면에 설정이 반영되는 시간은 메타데이터 캐시에 영향받을 수 있으나 새 외부 요청 직전의 서버 permit도 비활성 상태를 확인한다.

| API                                      | 동작 / 접근                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/companies/:id/logo`         | 로그인 세션; `{ metadata, providers }` 반환. 기존 종목 UUID 또는 기존 종목 해석 경로 사용                          |
| `POST /api/v1/companies/:id/logo-permit` | 로그인 세션 + 기존 CSRF 검증; `{ "provider": "logoDev" }` 또는 `brandfetch` 입력, `{ allowed: boolean }` 반환      |
| `PATCH /api/v1/companies/:id/logo`       | 기존 관리자 권한 + CSRF; `CompanyLogoMetadata` 전체를 검증해 저장. 잘못된 경로·미검수 권한·다른 종목 식별정보 거부 |
| `GET /api/v1/companies/logo-credits`     | 공개; 검수된 로컬 파일의 `{ path, source, sourceUrl, license, attribution }` 목록                                  |

관리자는 GET으로 현재 종목 메타데이터를 읽고 실제 출처·기업 매핑을 검수한 뒤 PATCH로 등록한다. 로컬 파일 경로는 `/logos/` 아래의 검수된 파일만 허용하며 경로 등록으로 파일을 내려받거나 생성하지 않는다. 실제 파일과 이용 조건을 코드 리뷰로 배포해야 한다. `license` 문자열에는 개별 라이선스명과 필요한 원문 링크를, `attribution`에는 원저작자와 필수 표시 문구·수정 사항을 보관한다. `sourceUrl`은 원본/설명 페이지의 HTTPS 주소다. `reviewedAt`는 실제 검수 시각의 UTC instant다. PATCH는 URL 생성·이미지 로딩을 자동 검수로 승인하는 기능이 아니다.

저장소는 기존 `source_checkpoints`의 `connector=COMPANY_LOGO_METADATA`, `stream=companies.id`다. JSON은 `{ version: 1, mapping, updatedBy, updatedAt }`를 저장한다. 기존 테이블을 재사용하므로 새 DB 마이그레이션은 필요 없다. 과거 `COMPANY_LOGO` 캐시의 이미지 검증을 이 검수 저장소로 자동 복사하지 않는다.

외부 `<img>` 요청 직전에 permit을 받고 기존 세션 Redis의 원자적 Lua 연산으로 공급자별 공유 예산을 예약한다. 최근 32일을 포함하는 **33개 UTC 날짜 버킷**을 합산하므로 공급자 월 경계/시간대보다 보수적으로 제한한다. 예약한 후보가 브라우저 캐시에서 나오거나 실패해도 예약은 환급하지 않는다. 따라서 이 수는 실제 공급자 과금 계량과 같지 않으며 실제 허용량보다 적게 쓸 수 있다. 이전 날짜 버킷이 범위를 벗어나며 예산이 점진적으로 복원된다. Redis 장애 시 메모리 예산으로 우회하지 않고 외부 요청을 거절한다.

**Redis 예산 키와 영속성을 유지한다.** Redis를 초기화하거나 서로 다른 Redis를 사용하는 배포에서 같은 공개 키를 공유하면 상한을 보장할 수 없다. 같은 키의 타 앱 트래픽도 이 예약 수에 들어오지 않으므로 전용 키를 사용하거나 그 사용량만큼 내부 한도를 낮춘다. 공개 키를 직접 사용하는 외부 남용은 애플리케이션 permit으로 막을 수 없으므로 공급자 대시보드의 origin 제한 및 총사용량 확인도 필요하다. 무료 한도 소진을 결제 설정 변경으로 해결하지 않는다.

공개 출처 페이지는 `/logo-sources`이며 앱 공통 footer와 관심종목 popout은 이 안내 페이지로 연결한다. Logo.dev 직접 출처 링크는 공개 안내 본문에 두며 `noreferrer` 없이 origin 수준 Referer를 전달한다. 공식 문서의 로그인 기반 앱에 대한 공개 안내 페이지 배치 조건을 따른다. 공개 페이지는 로컬 파일의 API credits를 함께 표시한다. 운영 계정에서 공개 production URL 승인은 별도로 확인해야 한다.

## 재현 가능한 검증

저장소의 기존 테스트 프레임워크를 사용한다. 통합 테스트의 실행 여부·성공 건수는 해당 변경의 완료 보고와 CI 결과에서 확인한다. 문서 조회 성공을 테스트 성공으로 대신하지 않는다.

```sh
npm run test -w @orsem/contracts
npm run test -w @orsem/api
npm run test -w @orsem/web
npm run typecheck
```

로고 테스트는 목 메타데이터와 `/logos/` 테스트 경로, 모의 load/error 이벤트를 사용한다. jsdom 테스트는 실제 이미지 바이트를 디코딩한 증거가 아니다. 국내 앞자리 0·영숫자·거래소 접미사, 보통주/우선주 및 미국 클래스별 종목 식별, ETF 역할, 키 없음·정보 없음, 순차 실패·최대 2개 외부 후보·실패 기록, 관리자 권한/경로 검증, 무료 예산, 접근성/다크모드, 브라우저 직접 이미지 요청을 확인한다. 실제 키가 설정되어도 이 테스트를 외부 로고 일괄 수집으로 바꾸지 않는다.

## 실제 이미지 확인 범위와 남은 검수

최초 구현·공식 문서 확인 시점에는 외부 키가 없었고 로고 이미지 요청을 보내지 않았다. 이후 키 설정 및 소수 종목 확인 결과는 아래의 활성화 후속 기록에 구분해 남긴다. 테스트의 로컬 경로와 목 응답은 실제 이미지 표시나 외부 공급자의 커버리지 증거가 아니다. 상용 기업·ETF 로컬 파일은 이번 변경에 포함하지 않았다. 개별 이용 조건과 기업 매핑 검수 후 관리자 API로 등록해야 한다.

- 국내 개별주: KOSPI/KOSDAQ 거래소 근거, 영숫자/앞자리 0 보존, 보통주·우선주 개별 ID, 회사와 도메인 일치, 실제 로고 모양 검수가 남는다.
- 미국 개별주: 거래소와 주식 클래스별 공급자 매핑을 검수한다. 특히 BRK.B의 공급자 표기/응답, GOOG·GOOGL의 별도 종목 유지, 동일 로고 공유 여부를 구분한다.
- ETF: 국가별 상품 메타데이터, 상품 자체 로고와 운용사 로고 역할, issuerId 및 출처, 실제 이미지가 지수나 편입기업 로고가 아닌지를 검수한다.
- 운영: 무료 플랜/카드 없음/초과 과금 비활성, 대시보드 한도, 공개 production 출처 URL 승인, 작은 표본의 브라우저 직접 표시, CSP와 Referer 전달을 확인한다.

## 변경 파일과 실행 결과 (2026-09-11)

- 웹 공통 로더: `components/company-avatar.tsx`, `company-avatar.css`, `lib/company-branding.ts`, `lib/use-company-logo.ts`, `lib/logo-failures.ts`, `lib/api.ts`. 메타데이터는 최대 512개를 5분간 공유하고, 재마운트·가시성/포커스 변경 시 만료를 확인한다. 메타데이터 조회 실패는 60초 후 다시 시도할 수 있다. 이미지 실패는 최대 1,024개의 60초 기록만 남기며, 20초 이상 멈춘 이미지도 다음 후보로 전환한다.
- 신원·관리·예산: `packages/contracts/src/company-logos.ts`, `apps/api/src/resources/company-logo.service.ts`, `config/app-config.ts`, `security/security.ts`, `security/session-runtime.service.ts`. 기존 company UUID·시장·코드와 가격/보유 데이터는 합치지 않는다. `STOCK_INFO` 및 `KR_ETF_IDENTITY`의 동일 종목 출처가 자산 유형을 제공하며, 모르면 `unknown`으로 남겨 자동 티커 조회를 생략한다. 검수 거절이나 손상된 매핑은 자동 조회로 되돌아가지 않는다.
- 화면 연결: `components/logo-attribution.tsx`, `components/app-shell.tsx`, `pages/logo-sources-page.tsx`, `pages/sources-page.tsx`, `pages/watchlist-popout-page.tsx`, `app.tsx`, 관련 CSS. 기존 목록·관심종목·종목 상세·시장 목록·최근 종목의 CompanyAvatar를 재사용했다. 상세 페이지 로고는 기존 크기·padding 0을 유지하면서 `object-fit: contain`으로 잘림을 방지했다. 이 저장소에는 포트폴리오/보유 화면이 없으므로 새 보유 기능을 만들지 않았다.
- 운영: `.env.example`, `ecosystem.config.cjs`, `deploy/nginx/orsem.laetipark.me.conf`, Python `market/__init__.py`와 `tests/test_market.py`. 기존 로고 이미지 수집의 정기 실행을 제거하고, 종목 정보/시세 스케줄은 유지한다. Nginx 변경은 이미지 허용 호스트와 popout 정책만 다룬다.
- 검증 파일: `company-branding.test.ts`, `company-avatar.test.tsx`, `event-row.test.tsx`, `logo-sources-page.test.tsx`, 공개 라우트/출처/popout 테스트, `company-logo.spec.ts`, `company-logo-budget.spec.ts`, `test/logo-fixtures.ts`.

공개 안내 페이지를 로컬 개발 서버의 실제 브라우저에서 확인했다. 다크 테마 안내 및 Logo.dev 출처 링크는 보였고, 아직 배포되지 않은 운영 API의 로컬 credits 조회 실패도 페이지를 막지 않았다. 로고 렌더러의 밝은/어두운 모드와 장식 이미지 접근성은 자동 테스트에서 확인했으며, 공급자의 실물 로고를 두 테마에서 검수한 것은 아니다.

최초 구현 검증 단계에서는 서비스 재시작·운영 API/웹 배포를 수행하지 않았다. 초기 shared contracts/database 빌드 후 동일 저장소의 배포 작업과 조율했으며, 이후 API/웹 프로덕션 빌드는 `/tmp/orsem-stock-logos-check-20260911` 사본에서 검증했다. 공급자 계정·유료 구독·카드·자동 충전 설정은 만들거나 변경하지 않았다.

실행 결과:

| 검증                                            | 결과                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 격리 `npm test -w @orsem/web`                   | 76개 파일, **596/596 통과**                                                                        |
| 격리 `npm test -w @orsem/api`                   | **356/356 통과**, skip 0                                                                           |
| 격리 `npm test -w @orsem/contracts`             | **31/31 통과**                                                                                     |
| Python `test_market.py`                         | **70/70 통과**; `/tmp/orsem-python-migration-20260910/pyenv/bin/python` 사용                       |
| 로고 전용 브라우저 목 테스트                    | 후보/식별 16개 + 이미지 로더 11개, **27/27 통과** (웹 전체에 포함)                                 |
| 로고 전용 API                                   | 메타데이터/권한/거절 12개 + 실제 Redis 예산 1개 통과 (API 전체에 포함)                             |
| 격리 `build:packages`, API/Web production build | 성공                                                                                               |
| 변경 범위 ESLint, Prettier, `git diff --check`  | 통과                                                                                               |
| Nginx 설정                                      | 원본 구문 확인, 임시 사본의 listen만 18127로 바꾼 독립 검사 성공; 운영 설정 reload는 수행하지 않음 |

API 최초 샌드박스 실행은 테스트용 로컬 포트 열기 제한으로 실패했으며, 허용된 격리 실행에서 전체 통과했다. Redis 테스트는 운영 Redis를 사용하지 않고 port 0·임시 Unix socket·영속성 비활성 서버에서 실행했으며 종료했다. 웹 최초 전체 검사에서 관심방 생성 후 라우터 갱신을 기다리지 않는 기존 assertion의 비동기 순서 문제가 드러나 해당 URL assertion만 `waitFor`로 보완하고 전체 통과를 확인했다.

검증 로그는 `/tmp/orsem-logo-web-final.log`, `/tmp/orsem-logo-api-final-permitted.log`, `/tmp/orsem-logo-web-build.log`, `/tmp/orsem-logo-api-build.log`에 보관했다. 운영 배포 작업에 현재 소스와 위 결과를 전달했으며 해당 작업의 배포 성공 여부는 이 보고에 포함하지 않는다.

## 키 설정 및 활성화 후속 기록 (2026-09-11 KST)

사용자가 `.env`에 추가한 Logo.dev publishable key와 Brandfetch Logo API Client ID의 형식을 값 노출 없이 확인했다. 공급자 활성화 플래그 두 개를 `true`로 변경하고 각 500,000 요청의 내부 상한과 기존 키·다른 설정은 보존했다. API만 재시작한 뒤 PM2의 로고 환경변수 6개 일치와 `health/live`, `health/ready`의 HTTP 200을 확인했다. 키 형식 확인은 공급자 계정의 무료 플랜·과금 설정·대시보드 한도 확인을 대신하지 않으며, 이 후속 작업에서도 계정·결제 설정은 변경하지 않았다.

실제 서비스의 로그인된 Chrome에서 소수 종목만 확인했다.

| 종목               | 관측 결과                                                                                                                                                                      | 검수 상태                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 애플 `AAPL`        | `img.logo.dev/ticker/AAPL` 직접 이미지가 128px로 디코딩됐으며 다크 테마 화면에서 애플 모양 확인. `referrerPolicy=origin`, 장식 이미지 `alt=""` 및 부모 `aria-hidden=true` 확인 | 실제 표시 표본 확인. DB의 매핑 검수 상태는 `unreviewed` 유지                                            |
| 삼성전자 `005930`  | 최초 확인 시 자체 텍스트 아이콘 표시. 거래소 보완 배포 후 `/ticker/005930.KS` 이미지 로드 및 다크 테마 상세 화면의 삼성 로고 표시 확인. 종목명·가격·차트 사용 가능             | 실제 표시 표본 확인. DB의 매핑 검수 상태는 `unreviewed` 유지                                            |
| KODEX 200 `069500` | 자체 아이콘과 상품명·코드 표시                                                                                                                                                 | 동일 종목의 ETF 메타데이터는 있으나 검수된 상품/운용사 매핑과 issuerId가 없어 외부 후보를 생성하지 않음 |

삼성전자는 기존 `companies.market=KRX`와 동일 종목 TOSS `STOCK_INFO.rawPayload.market=KOSPI`를 확인했다. `company-logo.service.ts`는 내부 ID·종목코드·원본 코드·KRW·ACTIVE·자산 유형을 검증한 경우에만 KRX의 거래소를 KOSPI/KOSDAQ로 보완하도록 수정했다. 명시된 거래소, 기존 company ID, 가격·보유 데이터는 변경하지 않는다. 웹 `use-company-logo.ts`는 동일 국가·ID·코드 검증을 유지하면서 KRX 응답의 KOSPI/KOSDAQ 세분화를 허용한다. 서로 충돌하는 명시 거래소는 계속 거부한다.

추가 검증은 웹 로고 테스트 **32/32**, API 로고 테스트 **15/15**, 격리 API·웹 프로덕션 빌드 통과다. API는 `node --test --test-isolation=none apps/api/.test-dist/resources/company-logo.spec.js`로 개별 테스트 15개 실행을 확인했다. 로그는 `/tmp/orsem-logo-activation-web-test.log`, `/tmp/orsem-logo-activation-api-test.log`, `/tmp/orsem-logo-activation-api-build.log`, `/tmp/orsem-logo-activation-web-build.log`에 있다.

거래소 보완의 운영 파일 교체는 최초 자동 승인 검토에서 보류됐고, 사용자가 **운영 배포 승인**으로 명시적으로 승인한 뒤 완료했다. API의 `company-logo.service` 컴파일 산출물 3개만 교체·재시작하고 readiness HTTP 200을 확인한 뒤, 웹의 새 해시 자산을 추가하고 index를 원자적으로 교체했다. 기존 웹 자산은 유지했고 워커·DB는 변경하지 않았다. 교체 원본과 SHA-256 기록은 `/tmp/orsem-logo-release-uBpD6T`에 보관했다.

Brandfetch 실제 이미지, KOSDAQ 실물 로고의 기업 일치, 특수 미국 티커, ETF 상품/운용사 로고, 공급자별 계정 대시보드 조건은 아직 확인하지 않았다. 이 표본을 전체 종목 커버리지로 확대 해석하지 않는다. Nginx 운영 설정 변경도 이 후속 작업에서 수행하지 않았다.

## Footer·로고 여백·이전 소스 정리 (2026-09-11 KST)

사용자 요청에 따라 앱 공통 footer와 관심 종목 새창의 Logo.dev 직접 링크를 제거하고 `/logo-sources` 링크 하나로 통합했다. 공개 안내 페이지의 footer도 제거했다. Logo.dev 직접 출처 링크는 해당 페이지 본문에 남아 있으며, 공식 문서가 허용하는 로그인 기반 앱의 공개 안내 페이지 배치를 따른다. 공개 안내는 인증 API 장애와 관계없이 접근할 수 있고 직접 링크는 origin Referer를 전달한다.

홈 내 종목·관심 종목 카드/목록·새창 및 같은 구조의 최근조회에서 `.watch-group-stock__company .company-avatar img`의 padding을 0으로 변경했다. 고정 크기와 `object-fit: contain`, 상세 화면의 기존 padding 0을 유지한다.

미사용 Python 로고 수집 원본과 전용 테스트는 이미 제거된 상태였다. 워커 담당 작업에서 잔존 build·egg-info·옛 로고 pyc 생성물을 정리했으며, 오래된 공급자 조사 문서 `LOGO_API_AUDIT_2026-09-11.md`도 저장소에서 제거했다. 현재 로고 어댑터·검수 정보와 재발 방지 테스트, 뉴스용 Finnhub 설정은 유지한다.

출처·공개 라우트·팝아웃 관련 기존 테스트 **29/29**, 격리 웹 프로덕션 빌드 및 변경 TSX의 ESLint가 통과했다. 웹 새 해시 자산과 index만 배포했고 API·워커 프로세스는 재시작하지 않았다. 이전 index 백업은 `/tmp/orsem-logo-footer-release-y2rlx8_i`, 테스트·빌드 로그는 `/tmp/orsem-logo-links-web-test.log`, `/tmp/orsem-logo-links-web-build.log`에 있다. 운영 관심 종목 화면에서 로고와 내부 안내 링크 표시, footer의 영문 제공자 링크 제거를 확인했다.

이전 웹 배포의 해시 파일 4개에도 구 로고 공급자 코드가 남아 있었다. 현재 index의 자산 참조에서 빠졌다는 이유로 일시 제거했으나, 배포 담당 작업에서 열린 탭·검증된 롤백 및 최근 30일 발행 자산 보존 범위를 확인해 원본을 복원했다. 백업과 복원 파일의 SHA-256 일치 기록은 `/tmp/orsem-old-logo-assets-1pv8zsgd/restored-sha256.json`에 있다. 현재 소스의 옛 로고 제거와 최신 배포는 유지하며, 현재 index의 참조 여부만으로 이전 배포 자산을 삭제하지 않는다. 운영 공개 안내 페이지도 확인했으며 Logo.dev 링크는 본문에 한 번만 있고 footer에는 없다.
