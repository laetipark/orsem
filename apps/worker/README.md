# Orsem worker

Python 3.12와 BullMQ로 실행하는 수집·파싱 워커입니다. OpenDART·SEC 공시, 뉴스 메타데이터, 토스 시장 데이터 수집과 알림 작업을 처리합니다. 소스는 `apps/worker/python/orsem_worker`, 테스트는 `apps/worker/python/tests`에 있습니다.

## 실행과 검증

개발 환경 설치 후 저장소 루트에서 실행합니다.

```bash
python3 scripts/worker.py start
```

개발 실행기는 저장소의 Python 소스를 사용하며, 운영 PM2는 저장소 밖 `../orsem-data/worker/current`에 설치한 wheel을 실행합니다. 설치·검사·운영 CLI·복구 명령은 [Python 워커 안내](../../docs/PYTHON_WORKER.md), 2026-09-11 전환 결과는 [배포 이력](../../docs/DEPLOYMENT_HISTORY.md#python-워커-전환-상태)을 따릅니다.

## 유지할 데이터 계약

- OpenDART `D001`–`D005`는 별도 도메인으로 처리합니다. 양수 수량만으로 장내매수를 판단하지 않습니다.
- 원본 필드·출처·이용 권리·사건일·게시일·최초 관측 시각을 보존합니다. 날짜는 날짜로, 시각은 UTC로 저장하고 화면에는 KST로 표시합니다.
- 뉴스는 허용된 제목·제공 요약·출처·원문 링크를 수집하고, 번역도 허용된 제목·요약에 한정합니다. 기사 본문은 수집하지 않습니다.
- 가격 공급자는 토스이며, Alpaca 자산 마스터는 기업 식별 정보에 사용합니다.
- 자격 증명이 없으면 해당 커넥터만 비활성화합니다. 원문·자격 증명·운영 산출물은 저장소 밖에 보관합니다.
- 스키마 변경은 `packages/database`의 마이그레이션으로 관리하고 운영 환경에 fixture를 자동 생성하지 않습니다.
- 자동 매수·매도 추천이나 주문을 생성하지 않습니다.

세부 계약은 [파싱 무결성](../../docs/PARSER_INTEGRITY.md), [SEC 수집](../../docs/SEC_COLLECTION.md), [뉴스 수집](../../docs/NEWS_COLLECTION.md), [뉴스 번역](../../docs/NEWS_TRANSLATION.md), [운영](../../docs/OPERATIONS.md), [이용 권리](../../docs/RIGHTS.md)에서 확인합니다.
