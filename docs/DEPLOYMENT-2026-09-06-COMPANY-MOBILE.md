# 종목 상세 모바일 개선 운영 배포

2026-09-06 15:27 KST · https://orsem.laetipark.me

## 반영 결과

모바일 로고·종목명/시장/코드 한 줄, 가격 중심 배치, 필요한 설명의 `?` 도움말, 관심그룹 등록 상태와 다중 선택·해제 저장을 운영에 반영했습니다. 상세 변경은 [모바일 디자인 구현](COMPANY-MOBILE-DESIGN-2026-09-06.md)에 있습니다.

## 변경 범위와 백업

직전 운영 웹(13:55 KST 배포)을 격리 사본에서 재빌드하여 86개 파일이 모두 동일함을 확인했습니다. 검증된 이번 소스 21개 파일의 해시도 배포 전 대조했습니다. 미배포 번역 편집기는 기존과 같은 빌드 설정으로 제외했으며 SEC/GDELT/Alpaca 수집기 변경을 포함하지 않았습니다.

서버 교체는 아래 3개 JS 파일입니다.

- `apps/api/dist/watchlist-groups/watchlist-groups.controller.js`
- `apps/api/dist/watchlist-groups/watchlist-groups.service.js`
- `packages/contracts/dist/watchlist-groups.js`

API 준비 상태를 확인한 뒤 웹 88개 파일을 반영하고 `index.html`을 마지막에 교체했습니다. 기존 해시의 웹 자산은 남겼습니다. `orsem-api`만 재시작했으며 worker·Ollama·Discord PID와 관련 없는 산출물 해시를 보존했습니다. DB 마이그레이션, 운영 설정 변경, 커넥터 추가 활성화는 없습니다.

비공개 백업: `/home/laeti/orsem-data/backups/company-mobile-20260906T062614Z`

DB 백업 192,201,466바이트, 이전 웹·서버 산출물, 새 산출물, 해시 목록과 이번 소스 패치를 보관했습니다. 배포 도구는 `/tmp/orsem-company-mobile-release/`에 있습니다.

## 운영 검증

- API live/ready 및 공개 웹 200.
- 승인된 관리자·회원 각각의 임시 로그인 세션으로 실제 삼성전자 상세·현재가·63개 일봉·최근 소식 조회 200. 표시 가격과 비교 종가가 있음을 확인했습니다.
- 각 계정의 임시 개인그룹에서 추가·해제 저장 204, revision 증가, GET `private, no-store` 확인.
- 동일 revision으로 동시에 저장하면 204/409가 각각 한 번 발생합니다.
- 다른 계정 비공개 그룹 저장은 404, CSRF 없는 저장은 403. 혼합 일괄 저장이 실패하면 앞선 그룹도 변경되지 않습니다.
- 임시 공유방 생성→참가 요청→승인 후 읽기 전용 회원에게 기존 등록 상태가 보이고, 해당 그룹 저장과 개인·읽기 전용 그룹 혼합 저장은 403입니다.
- 검증용 그룹 3개·공유방 1개·세션 2개를 모두 정리했습니다. 기존 사용자 그룹의 종목·이름·순서는 수정하지 않았습니다. 검증 감사 기록과 개인 공간 revision 증가는 보존합니다.
- 운영 브라우저의 로그인 화면을 확인했습니다. 로그인 후 새 화면의 시각·터치 영역 검증은 앞선 격리 브라우저 검사(320~1280px, 밝은/어두운 테마)를 기준으로 하며, 운영 로그인 후 실제 기기의 터치 조작을 수행했다고 주장하지 않습니다.
- 배포 전 웹 287개·API 276개 테스트와 빌드/타입/변경 파일 스타일 검사를 통과했습니다.

비공개 백업의 `result.json`, `membership-production-verification.json`, `final-verification.json`에 실제 결과가 있습니다.

## 복구

문제가 생기면 백업 `before/`의 위 서버 3개 파일과 이전 웹 `index.html`을 복원하고 `orsem-api`만 재시작합니다. 기존 웹 자산은 유지되어 즉시 복귀할 수 있습니다. 작업용 복구 명령은 다음과 같습니다.

```bash
node /tmp/orsem-company-mobile-release/deploy.cjs rollback
```

DB를 이전 시점으로 덮어쓰거나 역마이그레이션하지 않습니다. 기존 사용자 데이터와 정상 수집 결과, 검증 감사 기록을 보존합니다.
