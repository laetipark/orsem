# SEC Form 3/4/5 지분 관측

기존 회사별 FILING_RECEIPT를 유지하고, receipt 저장 후 ownership XML을 처리한다. raw XML은 DB나 Git에 저장하지 않는다. `SourceItem.rawMetadataJson.secOwnership`에 구조화 사실과 XML SHA-256, parserVersion, accession, source URL을 기록한다.

`EventCluster.canonicalEventType=OTHER`, `metadataJson.observationKind=SEC_INSIDER_TRANSACTION`을 사용해 기존 enum·UI 호환성을 유지한다. 이벤트는 `SEC_OWNERSHIP:{accession}`당 하나다. 거래 행은 그 이벤트의 ownership.transactions에 둔다. 여러 share class가 있으면 companyId는 null, relatedCompanyIds에 모두 기록하며 원래 회사별 receipt는 계속 유지한다. 3/5의 보유 행과 4/A 등의 정정 여부도 따로 보존한다. 정정 accession으로 이전 관측을 덮어쓰지 않는다.

## 의미와 숫자

issuer CIK·이름·티커, 보고자 CIK·이름·역할·직함, 증권명·거래일·원문 코드·취득/처분 코드·수량·가격·거래 후 보유·직접/간접 보유·파생 여부·각주 ID를 보존한다. 금액·수량은 XML 문자열 그대로이며 JS number로 변환하지 않는다. 가격 누락은 null이며 0으로 만들지 않는다. 원문 거래 구조 rawFields도 유지한다.

파생 분류는 원문과 별개다. P/S는 공개시장 **또는 사적 거래**의 매수/매도, A는 부여, M은 행사/전환, F는 세금·행사대금 관련, G는 증여, J는 기타, C는 전환, D는 발행사에 대한 처분으로 구분한다. 모르는 코드는 UNKNOWN이다. 취득 수량이나 A 방향만으로 시장매수로 분류하지 않는다. 원문 해석 기준은 [SEC Form 4](https://www.sec.gov/files/form4.pdf)와 [Ownership XML 명세](https://www.sec.gov/info/edgar/ownershipxmltechspec-v3.pdf)다.

filingDate·reportPeriod·transactionDate는 날짜 문자열이고 acceptanceDateTime은 공급자 시각이다. occurredAt을 임의의 자정이나 접수일로 만들지 않는다. firstObservedAt은 Orsem 관측 시각이다.

## 안전성과 재시도

- 동일 issuer/accession의 www.sec.gov HTTPS Archives XML만 요청한다. xslF345X 숫자 viewer 경로는 실제 XML 경로로 정규화한다. 인증정보·쿼리·인코딩 경로·상위 경로·리다이렉트는 거절한다.
- 응답 최대 2MiB, XML 깊이 32, 노드 30,000으로 제한한다. OpenDART의 선언·XInclude·복잡도 검사 함수를 재사용한다. DTD·ENTITY·외부 처리 명령을 거절하고 숫자 자동 변환을 끈다. 파싱 시간 예산을 넘긴 결과는 저장하지 않는다.
- 한 실행에서 오래된 pending부터 최대 3건 처리한다. XML 실패 시 receipt는 보존하고 ownershipStatus=FAILED, 1시간 후 재시도 시각을 남긴다. 첫 실패 후 해당 실행의 추가 XML 호출은 중단한다. SEC 공통 cooldown이 항상 우선한다.
- ownership 사실과 이벤트를 같은 DB 트랜잭션으로 저장한다. 이미 완료된 관측은 병렬 worker가 다시 생성하지 않는다. 이 관측에서 자동 투자 권고나 거래·푸시 알림을 생성하지 않는다.

## 분기 데이터 대조 인터페이스

[SEC Insider Transactions Data Sets](https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets)는 분기별 추출 자료로, 실시간 원문을 대체하지 않는다. 현재 분기 대조 인터페이스와 다운로드·ZIP importer는 구현되어 있지 않다. 후속 대조 계약은 연도·분기·공식 URL·파일 해시·suppressAlerts=true를 입력받아 checked/missingAccessions/discrepancies를 반환하는 형태로 설계한다.

추후 importer는 원문과 분기 데이터 accession을 대조하고 누락된 원문 복구 작업만 별도로 만든다. 숫자·각주 차이는 검수 대상으로 남기며 분기 데이터를 새 실시간 거래로 알리지 않는다. 데이터 자체의 추출 오류 가능성과 분기 말 접수 경계를 보존한다.
