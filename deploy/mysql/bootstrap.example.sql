-- 비밀번호를 바꾼 뒤 MySQL 관리자로 실행합니다.
CREATE DATABASE IF NOT EXISTS orsem
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'orsem'@'127.0.0.1'
  IDENTIFIED BY 'REPLACE_WITH_A_RANDOM_PASSWORD';

GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON orsem.* TO 'orsem'@'127.0.0.1';

-- 월간 목록의 두 뷰만 생성·검증·교체할 수 있습니다.
-- CREATE를 함께 명시하면 뷰를 만들기 전에도 객체별 권한을 부여할 수 있습니다.
GRANT CREATE, CREATE VIEW, SHOW VIEW, DROP
  ON orsem.market_leader_watchlist TO 'orsem'@'127.0.0.1';
GRANT CREATE, CREATE VIEW, SHOW VIEW, DROP
  ON orsem.market_leader_company_links TO 'orsem'@'127.0.0.1';

FLUSH PRIVILEGES;
