import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchlistRooms1788408000000 implements MigrationInterface {
  name = 'AddWatchlistRooms1788408000000';
  async up(r: QueryRunner): Promise<void> {
    const suffix = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    await r.query(`CREATE TABLE IF NOT EXISTS watchlist_rooms (
      id CHAR(36) NOT NULL PRIMARY KEY, owner_key VARCHAR(48) NOT NULL, name VARCHAR(80) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '', revision INT UNSIGNED NOT NULL DEFAULT 0,
      legacy_group_id CHAR(36) NULL UNIQUE,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY ix_room_owner (owner_key)
    ) ${suffix}`);
    await r.query(`CREATE TABLE IF NOT EXISTS watchlist_room_members (
      room_id CHAR(36) NOT NULL, actor_key VARCHAR(48) NOT NULL, role VARCHAR(16) NOT NULL DEFAULT 'MEMBER',
      can_manage_groups BOOLEAN NOT NULL DEFAULT 0, can_manage_stocks BOOLEAN NOT NULL DEFAULT 0,
      position INT UNSIGNED NOT NULL DEFAULT 0, joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY(room_id,actor_key), KEY ix_room_member_actor(actor_key,position),
      CONSTRAINT fk_room_member_room FOREIGN KEY(room_id) REFERENCES watchlist_rooms(id) ON DELETE CASCADE
    ) ${suffix}`);
    await r.query(`CREATE TABLE IF NOT EXISTS watchlist_room_requests (
      room_id CHAR(36) NOT NULL, actor_key VARCHAR(48) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
      requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY(room_id,actor_key),
      CONSTRAINT fk_room_request_room FOREIGN KEY(room_id) REFERENCES watchlist_rooms(id) ON DELETE CASCADE
    ) ${suffix}`);
    await r.query(`CREATE TABLE IF NOT EXISTS watchlist_personal_spaces (
      actor_key VARCHAR(48) NOT NULL PRIMARY KEY, revision INT UNSIGNED NOT NULL DEFAULT 0
    ) ${suffix}`);
    await r.query(`CREATE TABLE IF NOT EXISTS watchlist_change_logs (
      id CHAR(36) NOT NULL PRIMARY KEY, actor_key VARCHAR(48) NOT NULL, room_id CHAR(36) NULL,
      group_id CHAR(36) NULL, action VARCHAR(64) NOT NULL, details_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY ix_watch_change_room(room_id,created_at), KEY ix_watch_change_group(group_id,created_at)
    ) ${suffix}`);
    if (!(await r.hasColumn('watchlist_groups', 'room_id'))) {
      await r.query(`ALTER TABLE watchlist_groups ADD room_id CHAR(36) NULL,
        ADD KEY ix_watchlist_room_position(room_id,position),
        ADD CONSTRAINT fk_watchlist_group_room FOREIGN KEY(room_id) REFERENCES watchlist_rooms(id) ON DELETE CASCADE`);
    }
    if (!(await r.hasColumn('watchlist_groups', 'revision')))
      await r.query('ALTER TABLE watchlist_groups ADD revision INT UNSIGNED NOT NULL DEFAULT 0');
    // IDs are deterministic. Mark migrated groups private at the end so repeat runs cannot
    // restore departed members or overwrite ownership/edits after activation.
    await r.query(`INSERT IGNORE INTO watchlist_rooms(id,owner_key,name,legacy_group_id,created_at,updated_at)
      SELECT id,owner_key,name,id,created_at,updated_at FROM watchlist_groups WHERE is_shared=1 AND room_id IS NULL`);
    await r.query(`INSERT IGNORE INTO watchlist_room_members(room_id,actor_key,role,can_manage_groups,can_manage_stocks,position)
      SELECT r.id,g.owner_key,'ADMIN',1,1,g.position FROM watchlist_rooms r JOIN watchlist_groups g ON g.id=r.legacy_group_id
      WHERE g.is_shared=1 AND g.room_id IS NULL`);
    await r.query(`INSERT IGNORE INTO watchlist_room_members(room_id,actor_key,role,position)
      SELECT r.id,f.owner_key,'MEMBER',f.position FROM watchlist_group_follows f
      JOIN watchlist_groups g ON g.id=f.group_id JOIN watchlist_rooms r ON r.legacy_group_id=g.id
      WHERE g.is_shared=1 AND g.room_id IS NULL`);
    await r.query(`UPDATE watchlist_groups g JOIN watchlist_rooms r ON r.legacy_group_id=g.id
      SET g.room_id=r.id,g.is_shared=0 WHERE g.room_id IS NULL AND g.is_shared=1`);
  }
  async down(): Promise<void> {
    throw new Error(
      'Room membership and change history must be preserved. Disable room/group routes before restoring application artifacts.',
    );
  }
}
