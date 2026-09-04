# 카카오 로그인 운영

카카오 로그인은 회원의 신원을 확인하고 Orsem 이용 승인을 요청하는 기능입니다. 최초 로그인으로 생성되는 계정은 `VIEWER`·`PENDING`이며, 관리자가 승인하기 전에는 기존 관측 데이터를 볼 수 없습니다. 기존 로컬 관리자 로그인과 TOTP는 그대로 사용합니다.

일반 회원은 `/login`에서 카카오로 가입·로그인합니다. 관리자 이메일·비밀번호·TOTP/복구 코드는 별도 `/admin/login`에서 입력합니다. 일반 로그인 화면에는 관리자 입력 폼이 없으며, 관리자 화면에서는 카카오 설정을 조회하지 않습니다.

기능을 배포하는 것만으로 카카오 로그인이 활성화되지는 않습니다. 실제 키가 설정되지 않은 상태에서는 `GET /api/v1/auth/kakao/config`가 `{"enabled":false,"startUrl":null}`을 반환합니다. 이 문서는 설정 절차이며, 카카오 앱 생성이나 실제 계정 가입 검증이 완료됐다는 의미는 아닙니다.

## 카카오디벨로퍼스 설정

1. [카카오디벨로퍼스 앱 관리](https://developers.kakao.com/console/app)에 카카오계정으로 로그인하고 Orsem용 앱을 생성하거나 기존 앱을 선택합니다.
2. **앱 → 플랫폼 키 → REST API 키**에서 키를 확인합니다. 이 값이 JSON의 `clientId` 또는 환경 변수 `KAKAO_CLIENT_ID`입니다. JavaScript 키, 어드민 키, 앱의 숫자 ID와 구분합니다.
3. **같은 REST API 키 → 클라이언트 시크릿**에서 시크릿 값을 확인하고 활성화 상태를 유지합니다. 이 값이 `clientSecret` 또는 `KAKAO_CLIENT_SECRET`입니다. 키와 시크릿은 같은 REST API 키에 속해야 합니다. [공식 키·시크릿 설정 안내](https://developers.kakao.com/docs/ko/app-setting/app)
4. **카카오 로그인 → 사용 설정 → 상태**를 **ON**으로 설정합니다.
5. **카카오 로그인 → OpenID Connect → 상태**도 **ON**으로 설정합니다. Orsem은 `scope=openid`로 받은 ID 토큰을 검증하므로, OIDC가 꺼져 있으면 로그인 완료가 불가능합니다. [공식 로그인·OIDC 설정 안내](https://developers.kakao.com/docs/ko/kakaologin/prerequisite)
6. **앱 → 플랫폼 키 → 사용하는 REST API 키 → 카카오 로그인 리다이렉트 URI**에 아래 콜백 주소를 정확히 등록합니다. `redirectUri`는 발급받는 비밀 값이 아니라 서비스가 정하고 등록하는 주소입니다. 프로토콜·호스트·경로·끝 슬래시가 모두 일치해야 합니다. [공식 리다이렉트 URI 안내](https://developers.kakao.com/docs/ko/app-setting/app#redirect-uri)

| 구분             | `WEB_ORIGIN`                 | 등록할 콜백 URI                                         |
| ---------------- | ---------------------------- | ------------------------------------------------------- |
| 운영 사이트 예시 | `https://orsem.laetipark.me` | `https://orsem.laetipark.me/api/v1/auth/kakao/callback` |
| 로컬 개발 예시   | `http://localhost:5173`      | `http://localhost:5173/api/v1/auth/kakao/callback`      |

콜백은 항상 `WEB_ORIGIN` + `/api/v1/auth/kakao/callback`입니다. 요청의 `Host`나 임의의 복귀 주소로 바뀌지 않습니다. `KAKAO_REDIRECT_URI`를 별도로 지정한다면 이 값과 정확히 같아야 합니다. 운영에서는 HTTPS를 사용하며, 웹과 API가 같은 공개 출처에서 제공되어야 합니다.

현재 구현은 이메일·전화번호·생일·친구 목록을 요청하지 않습니다. ID 토큰의 문자열 `sub`를 회원 식별자로 사용하고, 토큰에 닉네임이 포함된 경우에만 표시 이름으로 보관합니다. 닉네임이 없어도 가입할 수 있으므로, 이름 표시를 위해 추가 개인정보 동의를 필수로 설정할 필요는 없습니다.

## 서버 자격 증명

저장소 밖의 파일을 API 실행 사용자 소유로 준비하고 권한을 `0600`으로 제한합니다. 권장 경로는 `/home/laeti/.config/orsem/credentials/kakao.json`입니다. 다른 서비스와 함께 관리하는 방법은 [서비스별 자격 증명 관리](CREDENTIALS.md)를 참고합니다. 기존 `/home/laeti/orsem-data/kakao-credentials.json` 경로도 사용할 수 있습니다. 아래 값은 모두 자리표시자입니다.

```json
{
  "clientId": "YOUR_KAKAO_REST_API_KEY",
  "clientSecret": "YOUR_KAKAO_CLIENT_SECRET",
  "redirectUri": "https://orsem.laetipark.me/api/v1/auth/kakao/callback"
}
```

```bash
install -d -m 0700 /home/laeti/.config/orsem/credentials
# 편집기로 위 JSON을 kakao.json에 저장한 뒤 실행합니다.
chmod 0600 /home/laeti/.config/orsem/credentials/kakao.json
```

API 프로세스 환경에 `KAKAO_CREDENTIALS_FILE=/home/laeti/.config/orsem/credentials/kakao.json`을 지정합니다. 저장소 루트 `.env`에는 이 비밀이 아닌 경로만 넣을 수 있습니다. 파일의 `redirectUri`는 생략할 수 있으며, 생략하면 위의 고정 콜백을 사용합니다. 파일을 웹 정적 디렉터리에 두거나 내용을 명령행·로그·저장소에 남기지 않습니다.

| 환경 변수                | 의미                                                |
| ------------------------ | --------------------------------------------------- |
| `KAKAO_CREDENTIALS_FILE` | 외부 JSON 파일 경로                                 |
| `KAKAO_CLIENT_ID`        | REST API 키; 해당 파일 항목보다 우선                |
| `KAKAO_CLIENT_SECRET`    | 클라이언트 시크릿; 해당 파일 항목보다 우선          |
| `KAKAO_REDIRECT_URI`     | 선택적인 고정 콜백 확인 값; 해당 파일 항목보다 우선 |

빈 환경 값은 파일의 해당 항목으로 보완합니다. 파일이 없거나 JSON이 잘못된 경우 파일 설정을 사용하지 않으며, 키나 파싱 오류 본문은 로그에 출력하지 않습니다. 최종 REST API 키 또는 시크릿이 없거나, 지정한 콜백이 고정 주소와 다르거나, 테스트 데이터 모드이면 카카오 로그인만 비활성화됩니다. 로컬 관리자 로그인은 계속 사용할 수 있습니다. `VITE_*`에 시크릿을 넣지 않습니다.

파일 방식으로 전환할 때 기존 `KAKAO_CLIENT_ID`, `KAKAO_CLIENT_SECRET`, `KAKAO_REDIRECT_URI`에 값이 남아 있으면 파일보다 우선합니다. `.env`와 실행 환경의 값을 정리하고, PM2에 예전 값이 남아 있는 경우 이 세 변수를 `.env`에서 빈 값으로 명시한 뒤 `pm2 restart ecosystem.config.cjs --only orsem-api --update-env`로 반영합니다. 카카오 파일 경로는 그대로 유지합니다.

키 설정 전에 회원 테이블 마이그레이션을 적용하고, 설정 변경 후 [배포 절차](DEPLOYMENT.md)에 따라 API 프로세스를 다시 시작합니다. 설정 파일은 시작할 때 읽습니다. Redis와 MySQL도 정상이어야 실제 로그인이 완료됩니다. `enabled=true`는 설정이 갖춰졌다는 뜻이며, 외부 인증 성공을 보장하는 상태 점검은 아닙니다.

저장소의 Nginx 템플릿은 정확히 `/api/v1/auth/kakao/callback`에 대해 `access_log off`와 `Referrer-Policy: no-referrer`를 설정합니다. 운영 설정에도 이 블록을 반영해 인가 코드가 포함된 콜백 쿼리가 접근 로그나 참조 헤더로 전달되지 않도록 합니다. 별도 프록시나 외부 모니터링을 추가할 때도 이 경로의 쿼리 수집을 제외합니다.

## 가입과 권한

| 계정 상태                  | 가능한 동작                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------ |
| 비로그인                   | 로그인 화면, 세션 및 카카오 설정 확인                                                |
| 카카오 `PENDING`           | 승인 대기 확인, Orsem 로그아웃                                                       |
| 카카오 `REJECTED`          | 이용 불가 상태 확인, Orsem 로그아웃                                                  |
| 카카오 `APPROVED`·`VIEWER` | 대시보드, 통합 검색, 기업·차트·현재가, 공시 메타데이터, 이벤트, 뉴스, 관심 목록 조회 |
| 로컬 `ADMIN`               | 기존 관리자 기능과 회원 승인·거절                                                    |

승인된 회원은 명시적으로 허용된 `GET`·`HEAD`만 이용할 수 있습니다. 관심 목록 변경, 검토 처리, 수집 작업 실행, IR 소스 관리, 회원 관리, 공시 원문 다운로드, 관리자 비밀번호·TOTP 변경은 허용되지 않습니다. 카카오 계정이 관리자 이메일과 같더라도 관리자 계정에 연결되거나 승격되지 않습니다.

관리자는 `GET /api/v1/auth/members?status=PENDING`으로 신청 목록을 확인하고, `PATCH /api/v1/auth/members/:id`에 `{"status":"APPROVED"}` 또는 `{"status":"REJECTED"}`를 보내 처리합니다. 변경 요청에는 기존 관리자 세션과 CSRF 토큰이 필요합니다. 상태와 처리 시각, 처리 관리자 및 감사 기록을 보관합니다. 기존 승인·거절 상태는 재로그인해도 유지되며, 보호된 요청마다 DB 상태를 다시 확인하므로 거절 변경은 다음 요청부터 적용됩니다.

## 테스트와 실제 가입 확인

`npm run doctor`의 `Kakao login` 항목은 REST API 키·시크릿 누락, 읽을 수 없는 JSON 파일, 콜백 불일치를 비밀 값 없이 알려줍니다. `npm run test:doctor`로 진단 자체의 회귀 테스트를 실행할 수 있습니다. `OK`는 로컬 설정 확인이며 카카오 앱 설정이나 실제 계정 인증까지 확인한 결과는 아닙니다.

카카오의 **테스트 앱**은 원본 앱과 키·설정이 별도이며, 테스트 앱에 등록된 멤버만 이용할 수 있습니다. 운영에는 원본 앱의 키를 사용해야 합니다. 테스트 앱 생성 조건과 제한은 [카카오 앱 설정](https://developers.kakao.com/docs/ko/app-setting/app#test-app)을 확인합니다. 카카오 테스트 앱의 멤버 등록과 Orsem 관리자의 이용 승인은 서로 다른 절차입니다.

테스트 앱을 사용할 때는 별도의 개발 설정과 DB에서 검증하고, 운영용 회원 데이터와 섞지 않습니다. Orsem 테스트 데이터 모드에서는 외부 카카오 로그인을 비활성화하므로 모의 화면 확인만으로 실제 가입 검증을 대신할 수 없습니다.

운영 앱과 키를 준비한 뒤 다음 순서로 실제 흐름을 확인합니다.

1. 설정 API의 `enabled=true`와 로그인 버튼을 확인합니다. 별도 브라우저 세션에서 카카오 로그인을 시작하고, 인증 후 고정 사이트의 `/login?kakao=success`로 복귀하는지 확인합니다.
2. 신규 회원 세션이 `authenticated=true`, `canAccess=false`, `role=VIEWER`, `status=PENDING`인지 확인합니다. 승인 전 데이터 API가 거절되어야 합니다.
3. 로컬 관리자 계정으로 해당 회원을 승인한 뒤, 회원 브라우저에서 관측 화면을 조회합니다. 관리자 화면과 데이터 변경 요청은 계속 거절되어야 합니다.
4. 회원을 거절 상태로 변경하면 다음 보호된 조회가 차단되는지 확인합니다. 카카오 재로그인으로 승인 상태가 초기화되면 안 됩니다.
5. Orsem 로그아웃 뒤 기존 로그인 세션이 무효화되는지 확인합니다. 가입 취소·잘못된 콜백·재사용 콜백에서는 새 회원 세션이 만들어지면 안 됩니다.

이 확인은 실제 카카오 앱·계정이 필요한 운영 점검입니다. 자동 회귀 테스트는 `state` 재사용, 서명·nonce 검증, 승인 전 접근 차단을 검증하지만 실제 앱 설정까지 확인하지는 않습니다.

## 로그인 실패와 로그아웃

버튼이 비활성화되면 키 파일의 존재·읽기 권한·JSON 형식, API 환경 변수 우선순위, 테스트 데이터 모드, 고정 콜백 일치를 확인합니다. 설정이 활성인데 인증 완료가 실패하면 카카오 로그인/OIDC ON, 동일 REST API 키의 시크릿과 등록 콜백, Redis·DB 상태, 서버 시각을 점검합니다. `KOE004`는 로그인 OFF, `KOE006`은 등록 콜백 불일치의 대표적인 원인입니다. 콜백의 코드·토큰·원본 응답을 공유하거나 로그에 남기지 않습니다.

로그인 `state`는 브라우저 세션에 연결되며 5분 동안 한 번만 소비할 수 있습니다. 중단되거나 만료된 로그인은 버튼에서 새로 시작합니다. 인증 실패는 고정된 `/login?kakao=error`로 돌아옵니다.

Orsem의 `POST /api/v1/auth/logout`은 **Orsem 서비스 세션만 종료**합니다. 브라우저의 카카오계정 로그인, 카카오와 앱의 연결, 카카오 토큰의 폐기를 수행하지 않습니다. 따라서 다음 카카오 로그인에서 계정 입력이 생략될 수 있습니다. 카카오계정 로그아웃과 연결 해제는 별도 기능이며 현재 제공하지 않습니다. 구분은 [카카오 로그인 REST API](https://developers.kakao.com/docs/ko/kakaologin/rest-api)를 참고합니다.
