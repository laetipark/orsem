# 종목 로고 운영 및 출처 검수

공식 문서 확인일: **2026-09-10 (KST)**. 아래 내용은 이 날짜에 열람한 공식 페이지에 근거한다. 무료 조건은 계정 대시보드와 함께 재확인하며, 조건이 충돌하거나 권한이 확인되지 않으면 더 제한적인 조건을 적용한다. 외부 공급자 계정 생성, 유료 구독, 카드 등록, 자동 충전, 초과 과금 설정을 이 작업에서 실행하지 않는다.

## 기존 구조와 변경 경계

- Node.js 24 / npm workspaces / TypeScript strict 구조다. 웹은 React 19 + Vite 7, 테스트는 Vitest + Testing Library + jsdom이다. Next.js 또는 이미지 최적화 서버가 아니다.
- API는 NestJS / Express, DB는 TypeORM / MySQL이며 마이그레이션을 사용한다. `synchronize: false`를 유지한다. API와 contracts 테스트는 TypeScript 컴파일 후 Node 내장 test runner를 실행한다. 로고 기능은 워커에 이미지 수집 작업을 등록하지 않는다.
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

[출처 표시 문서](https://www.logo.dev/docs/platform/attribution)는 무료 상업적 이용 시 화면에 보이는 링크를 요구한다. 로그인 기반 앱은 공개 안내 페이지에 출처를 둘 수 있으므로 `/logo-sources` 본문에 `Logos provided by Logo.dev` 링크를 표시한다. 링크에는 `noreferrer`를 붙이지 않으며 production URL을 공급자 대시보드에서 검증해야 한다. 앱에 코드가 존재하는 것과 대시보드에서 승인된 것은 구분한다.

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

기존 매핑은 `companies.corp_code`다. 기존 Python `apps/worker/python/orsem_worker/disclosures/client.py`의 `company_information`이 이미 `company.json`을 호출한다. `company_information_snapshots.raw_json.annual.profile.hm_url`을 재사용하여 **후보**로 제시할 수 있다. 종목코드/고유번호 일치, URL 정규화, 기업 홈페이지 여부를 검수한 후에만 `officialDomain`으로 승인한다. 홈페이지 문자열을 얻었다는 사실만으로 승인하지 않는다. ETF에는 일반 상장회사 경로를 자동 적용하지 않는다. 이 기능을 위해 전 종목 수집을 새로 실행하지 않는다. 기존 `OPENDART_API_KEY`를 브라우저에 노출하지 않는다.

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

공개 출처 페이지는 `/logo-sources`이며 `/sources` 본문의 로고 안내에서 연결한다. footer와 관심종목 popout의 안내 링크는 제거했다. Logo.dev 직접 출처 링크는 공개 안내 본문에 두며 `noreferrer` 없이 origin 수준 Referer를 전달한다. 공식 문서의 로그인 기반 앱에 대한 공개 안내 페이지 배치 조건을 따른다. 공개 페이지는 로컬 파일의 API credits를 함께 표시한다. 운영 계정에서 공개 production URL 승인은 별도로 확인해야 한다. 후속 화면·로더 변경은 2026-09-11 01:58:01 KST에 운영 반영했으며 아래 검증 기록에서 적용 범위와 검수 한계를 구분한다.

## 재현 가능한 검증

저장소의 기존 테스트 프레임워크를 사용한다. 통합 테스트의 실행 여부·성공 건수는 해당 변경의 완료 보고와 CI 결과에서 확인한다. 문서 조회 성공을 테스트 성공으로 대신하지 않는다.

```sh
npm run test -w @orsem/contracts
npm run test -w @orsem/api
npm run test -w @orsem/web
npm run typecheck
```

로고 테스트는 목 메타데이터와 `/logos/` 테스트 경로, 모의 load/error 이벤트를 사용한다. jsdom 테스트는 실제 이미지 바이트를 디코딩한 증거가 아니다. 국내 앞자리 0·영숫자·거래소 접미사, 보통주/우선주 및 미국 클래스별 종목 식별, ETF 역할, 키 없음·정보 없음, 순차 실패·최대 2개 외부 후보·실패 기록, 관리자 권한/경로 검증, 무료 예산, 접근성/다크모드, 브라우저 직접 이미지 요청을 확인한다. 실제 키가 설정되어도 이 테스트를 외부 로고 일괄 수집으로 바꾸지 않는다.

## 로더·캐시와 반복 로딩 억제

메타데이터는 최대 512개를 5분간 공유하며 실패 시 60초 후 다시 조회할 수 있다. 이벤트·시총 목록에서도 기존 회사 UUID를 전달해 같은 종목의 목록·상세 조회가 같은 캐시를 사용한다. 시장·거래소·문자열 코드의 일치는 별도로 검증한다. 동일 내용의 메타데이터 갱신은 기존 응답 참조를 유지한다. 시간 경계에서 후보를 다시 계산하더라도 후보 구성이 같으면 기존 후보 참조를 유지하여 표시 중인 로고를 불필요하게 다시 로딩하지 않는다.

브라우저가 제공하는 IntersectionObserver로 **150ms 연속 노출**을 확인한 뒤 조회한다. 빠르게 지나간 항목, 화면 밖 항목, 숨긴 탭은 새 로고 조회를 시작하지 않는다. 이미 시작한 이미지 요청을 취소하기 위해 DOM을 반복 제거하지 않으며, 숨겨진 동안에는 20초 로딩 중단 판정 타이머도 멈춘다. 이미 표시된 이미지가 다시 보일 때는 같은 DOM을 유지한다. IntersectionObserver가 없는 환경은 기존 지연 로딩과 화면 가시성 검사를 사용한다.

이미지 실패 기록은 최대 1,024개·60초의 메모리 정보다. 해당 URL이 아직 로드되지 않은 아바타만 실패 변경에 반응한다. 다른 아바타에서 같은 URL이 실패해도 이미 로드된 이미지를 제거하지 않는다. 정상 표시된 대체 후보는 짧은 실패 기록이 만료됐다는 이유로 다시 교체하지 않는다. 관리자가 후보를 변경·거절하면 새 메타데이터를 따른다. URL이 같고 검수 상태·역할만 바뀌면 DOM을 유지하면서 표시 정보를 갱신한다.

이미지별 최대 2회 외부 후보·순차 요청·서버 permit은 유지한다. 서로 다른 아바타의 permit을 공유하거나 이미지 파일을 자체 캐시에 저장하지 않는다. 브라우저 기본 캐시 외의 이미지 바이트 캐시는 추가하지 않았으며, 새 아바타 마운트에서 모든 요청이 사라지는 것을 보장하지 않는다.

구현 파일은 `components/company-avatar.tsx`, `lib/use-company-logo.ts`, `lib/logo-failures.ts`, `lib/company-branding.ts`다. 호출 지점의 UUID 전달은 `components/event-row.tsx`, `components/market-selection.tsx`에 반영했다. `components/watchlist-groups-panel.css`는 내 종목·관심종목·팝아웃·같은 구조의 최근조회 로고 padding을 0으로 지정한다. 상세 화면의 고정 크기·padding 0과 모든 이미지의 `object-fit: contain`을 유지한다.

## 실제 이미지 확인 범위와 남은 검수

2026-09-11 KST의 운영 Chrome 표본 확인이다. 실제 표시와 DB의 수동 기업 매핑 검수는 별개이며 아래 표본의 검수 상태는 `unreviewed`다. 로컬 기업·ETF 파일은 아직 등록하지 않았다.

| 종목               | 실제 확인                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 애플 `AAPL`        | `img.logo.dev/ticker/AAPL` 직접 이미지 128px 디코딩 및 다크 테마의 애플 모양 확인. origin Referer, 장식 이미지 접근성 속성 확인 |
| 삼성전자 `005930`  | 거래소 보완 후 `/ticker/005930.KS` 로딩과 다크 테마 상세 화면의 삼성 로고 확인. 종목명·가격·차트 정상 표시                      |
| KODEX 200 `069500` | 자체 아이콘과 상품명·코드 표시. ETF 식별 정보는 있으나 검수된 상품/운용사 매핑과 issuerId가 없어 외부 후보를 생성하지 않음      |

삼성전자의 `companies.market=KRX`는 동일 종목 TOSS `STOCK_INFO`의 내부 ID·코드·원본 코드·KRW·ACTIVE·자산 유형을 검증해 KOSPI로 보완했다. 로고 메타데이터만 보완하며 기존 회사 행·가격·보유 데이터는 변경하지 않는다.

- 국내 개별주: KOSDAQ 실물 로고의 기업 일치, 개별 보통주·우선주 매핑, 회사·공식 도메인 일치 검수가 남는다.
- 미국 개별주: BRK.B 등 특수 표기와 주식 클래스별 공급자 응답을 검수해야 한다. GOOG·GOOGL의 별도 식별은 자동 테스트로 확인했으며 실물 커버리지 확인과 다르다.
- ETF: 상품·운용사 메타데이터, issuerId·역할·출처 및 실물 이미지 검수가 필요하다. 기초지수·편입기업 이미지로 대신하지 않는다.
- 운영: Brandfetch 실제 이미지 응답, 무료 계정·과금 설정·대시보드 한도·production 출처 URL 승인 및 Nginx 운영 반영은 이 표본으로 확인하지 않았다.

전체 종목 커버리지, 실제 HTTP 오류 원인, 파일 재배포 권한을 목 테스트나 URL 생성만으로 확인했다고 해석하지 않는다.

## 검증 및 운영 반영 기록

2026-09-11 초기 전체 검증은 웹 **596/596**, API **356/356**(skip 0), contracts **31/31**, Python market **70/70**이었다. 격리 API·웹 빌드도 통과했다. API 테스트의 로컬 포트 제한은 허용된 격리 실행에서 해결했고, Redis 예산 테스트는 별도의 임시 Redis를 사용한 뒤 종료했다. 초기 전체 결과는 이후 변경까지 포함한 최신 통합 검증 결과를 대신하지 않는다.

후속 거래소 보완은 웹 로고 **32/32**, API 로고 **15/15**, 격리 API·웹 빌드 통과 후 운영 반영했다. 공개 키 형식·PM2 로고 설정 6개 일치와 health live/ready HTTP 200을 확인했다. 공급자 플래그는 활성화하고 각각 500,000의 내부 상한을 유지했으며 계정·카드·구독·자동 충전 설정은 변경하지 않았다. API 파일 교체 원본은 `/tmp/orsem-logo-release-uBpD6T`에 보관했다.

이후 로고 padding 0 및 footer의 영문 직접 링크 제거는 출처·공개 라우트·팝아웃 **29/29**와 격리 웹 빌드 통과 후 웹만 반영했다. 이 배포의 index 백업은 `/tmp/orsem-logo-footer-release-y2rlx8_i`다.

**후속 변경은 2026-09-11 01:58:01 KST에 통합 배포를 완료했다.** 로고 범위는 모든 footer의 내부 로고 안내 링크 제거, `/logo-sources` 반응형, 반복 로딩 억제 및 기존 UUID 공유다. 앞선 집중 검사에서 로더/후보 **38/38**, 이벤트/시총 목록 **16/16**이 통과했고, 마지막 시간 경계의 후보 참조 유지 수정 이후 웹 전체 **614/614**(77개 파일), TypeScript·ESLint·빌드를 통과했다. 전체 프로젝트의 격리 `npm run check`와 빌드도 통과했다.

실제 브라우저의 fixture 화면에서 `/logo-sources`를 280·320·375·420·768·1280px로 확인했다. 가로 넘침은 없었고 Logo.dev 본문 출처 링크를 유지하며 footer의 로고 출처 링크는 0개였다. 이 검증은 화면 배치와 출처 링크 확인이며 위의 실제 이미지 표본이나 기업·상품 매핑 검수 범위를 늘리지 않는다.

통합 배포는 웹 78개와 API `news-content` 산출물 3개를 포함하며 기존 웹 자산을 보존했다. API만 기존 환경으로 재시작했고 Python worker·DB·큐는 변경하지 않았다. 로고 API·외부 이미지 다운로드 경로의 추가 변경은 없다. 백업, 최종 index 해시, 최초 시도의 자동 복구와 재배포 결과는 [화면·로고 후속 배포 기록](DEPLOYMENT.md#2026-09-11-화면로고-후속-정리-배포)을 따른다.

앞선 집중 로더 검증 로그는 `/tmp/orsem-logo-loading-test.log`, `/tmp/orsem-logo-loading-types.log`다. 초기 전체 결과는 `/tmp/orsem-logo-web-final.log`, `/tmp/orsem-logo-api-final-permitted.log`에, 거래소 보완 결과는 `/tmp/orsem-logo-activation-*-test.log`, `/tmp/orsem-logo-activation-*-build.log`에 보관했다. 이 임시 로그의 초기 수치를 최신 통합 결과 대신 사용하지 않는다.

## 이전 코드 정리와 배포 자산 보존

이전 Python 로고 수집 원본·전용 테스트와 build·egg-info·옛 로고 pyc 생성물을 제거했다. 워커 담당의 fresh wheel 검사는 소스 파일 66개의 SHA 일치와 옛 로고 모듈·pycache 포함 0개를 확인했다. 이전 공급자 조사 문서도 제거했으며 현재 로고 어댑터·권리 검수와 재발 방지 테스트, 뉴스용 Finnhub 설정은 유지한다.

현재 index에서 참조하지 않는다는 이유만으로 과거 웹 해시 자산을 삭제하지 않는다. 운영에서 사용했던 롤백·열린 탭 및 최근 30일 발행 자산은 보존한다. 일시 제거했던 파일 4개는 원본과 SHA-256 일치를 확인해 복원했으며 기록은 `/tmp/orsem-old-logo-assets-1pv8zsgd/restored-sha256.json`에 있다. 옛 소스 제거와 운영 롤백 산출물 보존은 구분한다.
