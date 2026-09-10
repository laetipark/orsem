# 국내 ETF 종목 목록

국내 ETF는 OpenDART 기업 고유번호 목록과 별도로 토스증권의 공식 종목 목록에서 가져옵니다. 수집 범위는 토스증권이 제공하는 국내 ETF이며, KRX에 존재하는 모든 상품의 완전한 목록이라고 표시하지 않습니다. 새 API 키나 주문·계좌 API를 사용하지 않습니다.

## 출처와 갱신

공식 [토스 OpenAPI 가이드](https://developers.tossinvest.com/docs)와 [서버 OpenAPI 명세](https://openapi.tossinvest.com/openapi-docs/latest/openapi.json)의 `GET /api/v1/stocks/all`을 사용합니다. 이 API는 페이지 구분 없이 시장별 전체 결과를 반환하며, 공급자는 하루 한 번 조회 후 캐싱을 권장합니다.

기존 토스 설정과 공용 OAuth 캐시·호출 간격 제한을 사용합니다. `KOSPI`, `KOSDAQ`, `KR_ETC` 각각에 `securityType=ETF`와 `status=ACTIVE|DELISTED`를 적용해 정상 동기화마다 6회 조회합니다. Worker는 시작 시와 매시간 갱신 필요 여부를 확인하며, 성공한 스냅샷은 24시간 동안 재사용합니다. 자격 증명이 없으면 이 동기화만 비활성화합니다.

국내 ETF의 종목 코드는 숫자와 대문자로 이루어진 6자리입니다. 예를 들어 `0000D0` 같은 코드도 저장·검색·차트 연결에 사용합니다. ETF는 `companies`에 종목명·시장·종목 코드로 등록하고 `corpCode`, `cik`, `ticker`는 임의로 만들지 않습니다. 기존 시장 시총 상위 기업 선정에서는 ETF 제외 기준을 유지합니다.

## 식별 정보와 보존

`source_checkpoints`의 `TOSS / KR_ETF_MASTER`는 완전한 응답 스냅샷, 원본 필드, 조회 조건, 출처 URL, `PRIVATE_DISPLAY_ONLY` 권리, 관측 시각, 최초 관측 시각, 스냅샷 해시와 처리 건수를 보관합니다. `TOSS / KR_ETF_IDENTITY:<companyId>`에는 개별 종목의 원본 응답, ISIN, 이 동기화가 생성한 기업인지 여부와 이름 갱신 이력을 기록합니다. 공급자가 제공하지 않은 기업 원본 갱신일은 추정하지 않습니다.

기존 기업 고유번호·CIK·티커가 있거나 같은 종목 코드에 여러 행이 연결되면 기존 식별 정보를 보존하고 충돌로 집계합니다. `OTHER` 시장의 기존 코드도 확인합니다. 같은 이름의 기존 ETF는 관측 정보만 연결하며 소유권이나 회사 필드를 변경하지 않습니다. 이 동기화가 새로 생성한 ETF만 명시적인 상태에 따라 갱신합니다. 사용자가 바꾼 이름은 유지합니다.

목록에서 빠졌다는 이유만으로 상장 폐지 처리하지 않습니다. 이 동기화가 생성한 ETF에 한해 동일 코드·ISIN·시장이 `DELISTED` 응답에 명시된 경우만 `isListed=false`로 바꿉니다. 기존 회사 행·관계·공시는 삭제하지 않습니다. 활성 목록의 빈 결과, 이전 대비 20%를 넘는 급감, 중복 또는 잘못된 식별 정보, 실패한 시장 응답이 있으면 전체 적용을 중단하고 이전 정상 목록을 유지합니다. 활성·폐지 목록 간 코드 재사용은 서로 다른 ISIN일 때 구분하며 기존 회사에 새 증권을 덮어쓰지 않습니다.

## 수동 확인과 적용

격리 후보는 `python3 scripts/worker.py cli sync-korean-etfs --dry-run`으로 확인합니다. 운영에서는 설치된 wheel을 직접 선택합니다. 환경 파일은 기존 외부 설정으로 주입하고 명령 출력에 키를 노출하지 않습니다. [Python CLI 실행 구분](PYTHON_WORKER.md#운영-cli)을 참고하세요.

```bash
export ORSEM_REPO_ROOT=/home/laeti/orsem
/home/laeti/orsem-data/worker/current/bin/python -I -B -m orsem_worker.cli sync-korean-etfs --dry-run
```

이 명령은 6개 공식 응답과 기존 식별 정보를 확인한 뒤 예상 등록·갱신·충돌 건수만 출력합니다. 기업이나 체크포인트를 저장하지 않습니다. 검증된 후보와 운영 백업을 확보한 후 `--apply`를 사용하면 하나의 트랜잭션으로 기업과 체크포인트를 반영합니다. Worker의 자동 갱신과 CLI는 공통 DB 잠금으로 중복 실행을 막습니다. 기존 API의 종목 목록·통합 검색·관심 종목·차트는 등록된 ETF의 회사 ID와 종목 코드를 그대로 사용합니다.
