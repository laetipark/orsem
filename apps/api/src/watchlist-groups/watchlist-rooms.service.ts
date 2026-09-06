import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  WatchRoom,
  WatchRoomDetail,
  WatchRoomDirectory,
  WatchRoomMember,
} from '@orsem/contracts';
import {
  WatchlistAccessService,
  activeActorSql,
  actorLabelSql,
  sqlBoolean,
  sqlInstant,
  type GroupActor,
  type RoomRow,
} from './watchlist-access.service';

@Injectable()
export class WatchlistRoomsService {
  constructor(private readonly access: WatchlistAccessService) {}
  list(actor: GroupActor): Promise<{ items: WatchRoom[] }> {
    return this.access.transaction(actor, async (m) => {
      const rows: RoomRow[] = await m.query(
        `SELECT r.*,rm.role memberRole,rm.can_manage_groups,rm.can_manage_stocks,
        ${actorLabelSql('r.owner_key')} ownerLabel,
        (SELECT COUNT(*) FROM watchlist_room_members n WHERE n.room_id=r.id AND ${activeActorSql('n.actor_key')}) memberCount
        FROM watchlist_rooms r JOIN watchlist_room_members rm ON rm.room_id=r.id AND rm.actor_key=?
        WHERE ${activeActorSql('r.owner_key')} ORDER BY rm.position,r.created_at,r.id`,
        [actor.key],
      );
      return { items: rows.map((r) => this.access.roomView(r, actor)) };
    });
  }
  directory(actor: GroupActor, offset: number): Promise<WatchRoomDirectory> {
    return this.access.transaction(actor, async (m) => {
      const rows = await m.query(
        `SELECT r.id,r.name,r.description,${actorLabelSql('r.owner_key')} ownerLabel,
        CASE WHEN rm.actor_key IS NOT NULL THEN 'ACTIVE' WHEN req.status='PENDING' THEN 'PENDING' ELSE NULL END requestStatus
        FROM watchlist_rooms r LEFT JOIN watchlist_room_members rm ON rm.room_id=r.id AND rm.actor_key=?
        LEFT JOIN watchlist_room_requests req ON req.room_id=r.id AND req.actor_key=?
        WHERE ${activeActorSql('r.owner_key')} ORDER BY r.created_at DESC,r.id LIMIT 22 OFFSET ?`,
        [actor.key, actor.key, offset],
      );
      return { items: rows.slice(0, 21), nextOffset: rows.length > 21 ? offset + 21 : null };
    });
  }
  create(actor: GroupActor, input: { name: string; description: string }): Promise<WatchRoom> {
    return this.access.transaction(actor, async (m) => {
      const [count] = await m.query('SELECT COUNT(*) n FROM watchlist_rooms WHERE owner_key=?', [
        actor.key,
      ]);
      if (Number(count.n) >= 20)
        throw new ConflictException('공유방은 최대 20개까지 만들 수 있습니다.');
      const id = randomUUID();
      await m.query('INSERT INTO watchlist_rooms(id,owner_key,name,description) VALUES (?,?,?,?)', [
        id,
        actor.key,
        input.name,
        input.description,
      ]);
      await m.query(
        "INSERT INTO watchlist_room_members(room_id,actor_key,role,can_manage_groups,can_manage_stocks,position) SELECT ?,?,'ADMIN',1,1,COALESCE(MAX(position),0)+1 FROM watchlist_room_members WHERE actor_key=?",
        [id, actor.key, actor.key],
      );
      await this.access.audit(m, actor, 'ROOM_CREATED', id, null, input);
      return this.access.room(m, actor, id);
    });
  }
  detail(actor: GroupActor, id: string): Promise<WatchRoomDetail> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      const rows = await m.query(
        `SELECT rm.*,${actorLabelSql('rm.actor_key')} label,${activeActorSql('rm.actor_key')} active,
        r.owner_key FROM watchlist_room_members rm JOIN watchlist_rooms r ON r.id=rm.room_id WHERE rm.room_id=? ORDER BY rm.joined_at,rm.actor_key`,
        [id],
      );
      const members: WatchRoomMember[] = rows.map((r: Record<string, unknown>) => ({
        actorKey: String(r.actor_key),
        label: String(r.label),
        role: r.actor_key === r.owner_key ? 'OWNER' : r.role === 'ADMIN' ? 'ADMIN' : 'MEMBER',
        canManageGroups: sqlBoolean(r.can_manage_groups),
        canManageStocks: sqlBoolean(r.can_manage_stocks),
        active: sqlBoolean(r.active),
      }));
      const requests = room.canManageMembers
        ? await m.query(
            `SELECT actor_key actorKey,${actorLabelSql('q.actor_key')} label,requested_at requestedAt FROM watchlist_room_requests q WHERE room_id=? AND status='PENDING' AND ${activeActorSql('q.actor_key')} ORDER BY requested_at`,
            [id],
          )
        : [];
      return {
        ...room,
        members,
        requests: requests.map(
          (r: { actorKey: string; label: string; requestedAt: Date | string }) => ({
            ...r,
            requestedAt: sqlInstant(r.requestedAt),
          }),
        ),
      };
    });
  }
  request(actor: GroupActor, id: string, cancel = false): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const [room] = await m.query(
        `SELECT id,owner_key FROM watchlist_rooms r WHERE id=? AND ${activeActorSql('r.owner_key')} FOR UPDATE`,
        [id],
      );
      if (!room) throw new NotFoundException('신청할 수 있는 공유방이 없습니다.');
      await this.access.lockActiveActor(m, room.owner_key);
      const [member] = await m.query(
        'SELECT actor_key FROM watchlist_room_members WHERE room_id=? AND actor_key=?',
        [id, actor.key],
      );
      if (member) throw new ConflictException('이미 참여한 방입니다.');
      if (cancel)
        await m.query('DELETE FROM watchlist_room_requests WHERE room_id=? AND actor_key=?', [
          id,
          actor.key,
        ]);
      else
        await m.query(
          "INSERT INTO watchlist_room_requests(room_id,actor_key) VALUES (?,?) ON DUPLICATE KEY UPDATE status='PENDING',requested_at=CURRENT_TIMESTAMP(3)",
          [id, actor.key],
        );
      await this.access.bump(m, actor, id);
      await this.access.audit(
        m,
        actor,
        cancel ? 'REQUEST_CANCELLED' : 'JOIN_REQUESTED',
        id,
        null,
        {},
      );
    });
  }
  review(
    actor: GroupActor,
    id: string,
    target: string,
    approve: boolean,
    revision: number,
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.require(room, 'canManageMembers');
      this.access.version(room.revision, revision);
      const [pending] = await m.query(
        `SELECT actor_key FROM watchlist_room_requests q WHERE room_id=? AND actor_key=? AND status='PENDING' AND ${activeActorSql('q.actor_key')} FOR UPDATE`,
        [id, target],
      );
      if (!pending) throw new ConflictException('대기 중인 참여 신청이 없습니다.');
      if (approve) {
        await this.access.lockActiveActor(m, target);
        const [n] = await m.query(
          'SELECT COUNT(*) n FROM watchlist_room_members rm JOIN watchlist_rooms r ON r.id=rm.room_id WHERE actor_key=? AND r.owner_key<>?',
          [target, target],
        );
        if (Number(n.n) >= 50)
          throw new ConflictException('신청자의 참여 방이 50개에 도달했습니다.');
        await m.query(
          'INSERT INTO watchlist_room_members(room_id,actor_key,position) SELECT ?,?,COALESCE(MAX(position),0)+1 FROM watchlist_room_members WHERE actor_key=?',
          [id, target, target],
        );
      }
      await m.query('UPDATE watchlist_room_requests SET status=? WHERE room_id=? AND actor_key=?', [
        approve ? 'APPROVED' : 'REJECTED',
        id,
        target,
      ]);
      await this.access.bump(m, actor, id);
      await this.access.audit(
        m,
        actor,
        approve ? 'MEMBER_APPROVED' : 'REQUEST_REJECTED',
        id,
        null,
        { target },
      );
    });
  }
  member(
    actor: GroupActor,
    id: string,
    target: string,
    input: {
      role: 'ADMIN' | 'MEMBER';
      canManageGroups: boolean;
      canManageStocks: boolean;
      revision: number;
    },
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.require(room, 'canManageMembers');
      this.access.version(room.revision, input.revision);
      const [row] = await m.query(
        `SELECT rm.*,r.owner_key FROM watchlist_room_members rm JOIN watchlist_rooms r ON r.id=rm.room_id WHERE room_id=? AND actor_key=? FOR UPDATE`,
        [id, target],
      );
      if (!row) throw new NotFoundException('참여자가 없습니다.');
      if (
        row.owner_key === target ||
        (room.role !== 'OWNER' && (row.role === 'ADMIN' || input.role === 'ADMIN'))
      )
        throw new ForbiddenException('관리자 지정·해제는 방장만 할 수 있습니다.');
      await m.query(
        'UPDATE watchlist_room_members SET role=?,can_manage_groups=?,can_manage_stocks=? WHERE room_id=? AND actor_key=?',
        [input.role, input.canManageGroups, input.canManageStocks, id, target],
      );
      await this.access.bump(m, actor, id);
      await this.access.audit(m, actor, 'MEMBER_PERMISSIONS', id, null, { target, ...input });
    });
  }
  removeMember(actor: GroupActor, id: string, target: string, revision: number): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.version(room.revision, revision);
      const [row] = await m.query(
        'SELECT rm.role,r.owner_key FROM watchlist_room_members rm JOIN watchlist_rooms r ON r.id=rm.room_id WHERE room_id=? AND actor_key=? FOR UPDATE',
        [id, target],
      );
      if (!row) throw new NotFoundException();
      if (target === row.owner_key)
        throw new ConflictException('방장을 이전하거나 방을 삭제한 뒤 나갈 수 있습니다.');
      if (target !== actor.key) {
        this.access.require(room, 'canManageMembers');
        if (room.role !== 'OWNER' && row.role === 'ADMIN')
          throw new ForbiddenException('다른 관리자를 내보낼 수 없습니다.');
      }
      await m.query('DELETE FROM watchlist_room_members WHERE room_id=? AND actor_key=?', [
        id,
        target,
      ]);
      await this.access.bump(m, actor, id);
      await this.access.audit(
        m,
        actor,
        target === actor.key ? 'MEMBER_LEFT' : 'MEMBER_REMOVED',
        id,
        null,
        { target },
      );
    });
  }
  update(
    actor: GroupActor,
    id: string,
    input: { name: string; description: string; revision: number },
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.require(room, 'canManageMembers');
      this.access.version(room.revision, input.revision);
      await m.query('UPDATE watchlist_rooms SET name=?,description=? WHERE id=?', [
        input.name,
        input.description,
        id,
      ]);
      await this.access.bump(m, actor, id);
      await this.access.audit(m, actor, 'ROOM_UPDATED', id, null, input);
    });
  }
  transfer(actor: GroupActor, id: string, target: string, revision: number): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.version(room.revision, revision);
      if (room.role !== 'OWNER' || target === actor.key)
        throw new ForbiddenException('방장만 다른 참여자에게 이전할 수 있습니다.');
      const [member] = await m.query(
        `SELECT actor_key FROM watchlist_room_members rm WHERE room_id=? AND actor_key=? AND ${activeActorSql('rm.actor_key')} FOR UPDATE`,
        [id, target],
      );
      if (!member) throw new ConflictException('승인된 방 참여자에게만 이전할 수 있습니다.');
      await this.access.lockActiveActor(m, target);
      await m.query('UPDATE watchlist_rooms SET owner_key=? WHERE id=?', [target, id]);
      await m.query(
        "UPDATE watchlist_room_members SET role='ADMIN',can_manage_groups=1,can_manage_stocks=1 WHERE room_id=? AND actor_key IN (?,?)",
        [id, target, actor.key],
      );
      await this.access.bump(m, actor, id);
      await this.access.audit(m, actor, 'OWNER_TRANSFERRED', id, null, { target });
    });
  }
  remove(actor: GroupActor, id: string, revision: number): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const room = await this.access.room(m, actor, id);
      this.access.version(room.revision, revision);
      if (room.role !== 'OWNER') throw new ForbiddenException('방장만 삭제할 수 있습니다.');
      await this.access.audit(m, actor, 'ROOM_DELETED', id, null, { name: room.name });
      await m.query('DELETE FROM watchlist_rooms WHERE id=?', [id]);
    });
  }
  order(actor: GroupActor, ids: string[]): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      for (const [position, id] of ids.entries()) {
        await this.access.room(m, actor, id);
        await m.query(
          'UPDATE watchlist_room_members SET position=? WHERE room_id=? AND actor_key=?',
          [position, id, actor.key],
        );
      }
    });
  }
}
