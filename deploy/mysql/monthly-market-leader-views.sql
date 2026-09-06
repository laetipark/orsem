-- 기존 Orsem 설치에서 MySQL 관리자가 한 번 실행합니다.
-- 스키마와 계정이 다른 설치에서는 아래 이름을 먼저 변경하세요.
-- 기존 회사·뉴스·그룹 데이터와 권한을 바꾸지 않습니다.
-- CREATE는 기존 DB 권한이며, 아직 없는 뷰 이름에도 객체별 권한을 등록하기 위해 명시합니다.
-- DROP은 CREATE OR REPLACE VIEW의 재실행에 필요한 해당 뷰 교체 권한입니다.

GRANT CREATE, CREATE VIEW, SHOW VIEW, DROP
  ON orsem.market_leader_watchlist TO 'orsem'@'127.0.0.1';
GRANT CREATE, CREATE VIEW, SHOW VIEW, DROP
  ON orsem.market_leader_company_links TO 'orsem'@'127.0.0.1';
