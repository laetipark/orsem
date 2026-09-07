import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { EntityManager } from 'typeorm';
import type { WatchPermissions, WatchRoom } from '@orsem/contracts';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';

export interface GroupActor {
  kind: 'ADMIN' | 'MEMBER';
  id: string;
  key: string;
}
export function groupActor(request: Pick<Request, 'session'>): GroupActor {
  const a = request.session?.adminId,
    m = request.session?.memberId;
  if ((!a && !m) || (a && m)) throw new UnauthorizedException('로그인이 필요합니다.');
  const kind = a ? 'ADMIN' : 'MEMBER';
  return { kind, id: (a ?? m)!, key: `${kind}:${a ?? m}` };
}
export const sqlBoolean = (v: unknown): boolean => v === true || v === 1 || v === '1';
export const sqlInstant = (v: Date | string): string =>
  v instanceof Date
    ? v.toISOString()
    : new Date(v.includes('T') ? v : v.replace(' ', 'T') + 'Z').toISOString();
export const activeActorSql = (key: string): string => `(
  EXISTS(SELECT 1 FROM admins a WHERE ${key}=CONCAT('ADMIN:',a.id) AND a.is_active=1)
  OR EXISTS(SELECT 1 FROM members m WHERE ${key}=CONCAT('MEMBER:',m.id) AND m.role='VIEWER' AND m.status='APPROVED'))`;
export const actorLabelSql = (key: string): string =>
  `COALESCE((SELECT display_name FROM members WHERE ${key}=CONCAT('MEMBER:',id)), '운영자')`;
export interface RoomRow {
  id: string;
  owner_key: string;
  name: string;
  description: string;
  revision: number;
  ownerLabel: string;
  memberCount: number;
  memberRole: string;
  can_manage_groups: unknown;
  can_manage_stocks: unknown;
}
export interface GroupRow {
  id: string;
  owner_key: string;
  room_id: string | null;
  name: string;
  revision: number;
  position: number;
  updated_at: Date | string;
  itemCount: number;
}
export interface Scope extends WatchPermissions {
  roomId: string | null;
  revision: number;
  room?: WatchRoom;
}

@Injectable()
export class WatchlistAccessService {
  constructor(private readonly database: DatabaseRuntimeService) {}
  async lockActiveActor(m: EntityManager, key: string): Promise<void> {
    const [kind, id] = key.split(':');
    if (!id || (kind !== 'ADMIN' && kind !== 'MEMBER')) throw new ForbiddenException();
    const rows = await m.query(
      kind === 'ADMIN'
        ? 'SELECT id FROM admins WHERE id=? AND is_active=1 FOR UPDATE'
        : "SELECT id FROM members WHERE id=? AND role='VIEWER' AND status='APPROVED' FOR UPDATE",
      [id],
    );
    if (!rows.length) throw new ForbiddenException('승인된 계정만 이용할 수 있습니다.');
  }
  async transaction<T>(actor: GroupActor, work: (m: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.database.requireDataSource().transaction(async (m) => {
          if (actor.key !== `${actor.kind}:${actor.id}`) throw new UnauthorizedException();
          await this.lockActiveActor(m, actor.key);
          return work(m);
        });
      } catch (e) {
        const error = e as { code?: string; driverError?: { code?: string } };
        if (attempt >= 2 || (error.code ?? error.driverError?.code) !== 'ER_LOCK_DEADLOCK') throw e;
      }
    }
  }
  roomView(r: RoomRow, actor: GroupActor): WatchRoom {
    const role =
      r.owner_key === actor.key ? 'OWNER' : r.memberRole === 'ADMIN' ? 'ADMIN' : 'MEMBER';
    const manager = role !== 'MEMBER';
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      ownerLabel: r.ownerLabel,
      role,
      revision: Number(r.revision),
      memberCount: Number(r.memberCount),
      canManageGroups: manager || sqlBoolean(r.can_manage_groups),
      canManageStocks: manager || sqlBoolean(r.can_manage_stocks),
      canManageMembers: manager,
    };
  }
  async room(m: EntityManager, actor: GroupActor, id: string): Promise<WatchRoom> {
    const rows: RoomRow[] = await m.query(
      `SELECT r.*,${actorLabelSql('r.owner_key')} ownerLabel,
      rm.role memberRole,rm.can_manage_groups,rm.can_manage_stocks,
      (SELECT COUNT(*) FROM watchlist_room_members n WHERE n.room_id=r.id AND ${activeActorSql('n.actor_key')}) memberCount
      FROM watchlist_rooms r JOIN watchlist_room_members rm ON rm.room_id=r.id AND rm.actor_key=?
      WHERE r.id=? AND ${activeActorSql('r.owner_key')} FOR UPDATE`,
      [actor.key, id],
    );
    if (!rows[0])
      throw new NotFoundException({
        statusCode: 404,
        code: 'WATCH_SCOPE_NOT_FOUND',
        message: '참여 가능한 공유방을 찾을 수 없습니다.',
      });
    await this.lockActiveActor(m, rows[0].owner_key);
    return this.roomView(rows[0], actor);
  }
  async scope(m: EntityManager, actor: GroupActor, roomId?: string | null): Promise<Scope> {
    if (roomId) {
      const room = await this.room(m, actor, roomId);
      return {
        roomId,
        revision: room.revision,
        room,
        canManageGroups: room.canManageGroups,
        canManageStocks: room.canManageStocks,
        canManageMembers: room.canManageMembers,
      };
    }
    await m.query('INSERT IGNORE INTO watchlist_personal_spaces(actor_key) VALUES (?)', [
      actor.key,
    ]);
    const [row] = await m.query(
      'SELECT revision FROM watchlist_personal_spaces WHERE actor_key=? FOR UPDATE',
      [actor.key],
    );
    return {
      roomId: null,
      revision: Number(row.revision),
      canManageGroups: true,
      canManageStocks: true,
      canManageMembers: false,
    };
  }
  async group(
    m: EntityManager,
    actor: GroupActor,
    id: string,
  ): Promise<{ row: GroupRow; scope: Scope }> {
    const [stub]: GroupRow[] = await m.query(
      'SELECT room_id,owner_key FROM watchlist_groups WHERE id=?',
      [id],
    );
    if (!stub || (!stub.room_id && stub.owner_key !== actor.key))
      throw new NotFoundException({
        statusCode: 404,
        code: 'WATCH_GROUP_NOT_FOUND',
        message: '접근 가능한 그룹을 찾을 수 없습니다.',
      });
    const scope = await this.scope(m, actor, stub.room_id);
    const [row]: GroupRow[] = await m.query(
      `SELECT g.*,(SELECT COUNT(*) FROM watchlist_group_items i WHERE i.group_id=g.id) itemCount FROM watchlist_groups g WHERE g.id=? FOR UPDATE`,
      [id],
    );
    if (!row)
      throw new NotFoundException({
        statusCode: 404,
        code: 'WATCH_GROUP_NOT_FOUND',
        message: '그룹이 삭제되었습니다.',
      });
    return { row, scope };
  }
  require(scope: WatchPermissions, permission: keyof WatchPermissions): void {
    if (!scope[permission]) throw new ForbiddenException('이 작업의 관리 권한이 없습니다.');
  }
  version(actual: number, expected: number): void {
    if (Number(actual) !== expected)
      throw new ConflictException(
        '다른 참여자가 변경했습니다. 최신 목록을 불러온 뒤 다시 편집하세요.',
      );
  }
  async bump(m: EntityManager, actor: GroupActor, roomId: string | null): Promise<void> {
    if (roomId)
      await m.query(
        'UPDATE watchlist_rooms SET revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',
        [roomId],
      );
    else
      await m.query('UPDATE watchlist_personal_spaces SET revision=revision+1 WHERE actor_key=?', [
        actor.key,
      ]);
  }
  async audit(
    m: EntityManager,
    actor: GroupActor,
    action: string,
    roomId: string | null,
    groupId: string | null,
    details: unknown,
  ): Promise<void> {
    await m.query(
      'INSERT INTO watchlist_change_logs(id,actor_key,room_id,group_id,action,details_json) VALUES (?,?,?,?,?,?)',
      [randomUUID(), actor.key, roomId, groupId, action, JSON.stringify(details)],
    );
  }
}
