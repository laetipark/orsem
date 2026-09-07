import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  companySchema,
  type Company,
  type CompanyWatchlistMemberships,
  type SaveCompanyWatchlistMemberships,
  type WatchlistGroup,
  type WatchlistGroupItems,
} from '@orsem/contracts';
import {
  WatchlistAccessService,
  activeActorSql,
  sqlBoolean,
  sqlInstant,
  type GroupActor,
  type GroupRow,
  type Scope,
} from './watchlist-access.service';
import { CompanyObservationService } from './company-observation.service';
export { groupActor, type GroupActor } from './watchlist-access.service';
const marks = (ids: unknown[]) => ids.map(() => '?').join(',');
const companyFields =
  'c.id,c.market,c.corp_code corpCode,c.stock_code stockCode,c.ticker,c.cik,c.name_ko nameKo,c.name_en nameEn,c.is_listed isListed,c.updated_at updatedAt';
const companyView = (r: Record<string, unknown>): Company =>
  companySchema.parse({
    ...r,
    isListed: sqlBoolean(r.isListed),
    updatedAt: sqlInstant(r.updatedAt as Date | string),
  });

@Injectable()
export class WatchlistGroupsService {
  constructor(
    private readonly access: WatchlistAccessService,
    private readonly observations: CompanyObservationService,
  ) {}
  private view(row: GroupRow, scope: Scope): WatchlistGroup {
    return {
      id: row.id,
      name: row.name,
      kind: row.room_id ? 'ROOM' : 'PERSONAL',
      roomId: row.room_id,
      revision: Number(row.revision),
      isShared: Boolean(row.room_id),
      isFollowing: false,
      canEdit: scope.canManageGroups && scope.canManageStocks,
      canManageGroups: scope.canManageGroups,
      canManageStocks: scope.canManageStocks,
      canManageMembers: scope.canManageMembers,
      itemCount: Number(row.itemCount),
      ownerLabel: scope.room?.ownerLabel ?? '나',
      updatedAt: sqlInstant(row.updated_at),
    };
  }
  private rows(m: EntityManager, actor: GroupActor, roomId?: string | null): Promise<GroupRow[]> {
    return m.query(
      `SELECT g.*,(SELECT COUNT(*) FROM watchlist_group_items i WHERE i.group_id=g.id) itemCount FROM watchlist_groups g WHERE ${roomId ? 'g.room_id=?' : 'g.room_id IS NULL AND g.owner_key=?'} ORDER BY g.position,g.id`,
      [roomId ?? actor.key],
    );
  }
  list(actor: GroupActor, roomId?: string) {
    return this.access.transaction(actor, async (m) => {
      const scope = await this.access.scope(m, actor, roomId);
      return {
        items: (await this.rows(m, actor, roomId)).map((r) => this.view(r, scope)),
        revision: scope.revision,
        permissions: {
          canManageGroups: scope.canManageGroups,
          canManageStocks: scope.canManageStocks,
          canManageMembers: scope.canManageMembers,
        },
      };
    });
  }
  newsScope(actor: GroupActor, id: string, companyId?: string) {
    return this.access.transaction(actor, async (m) => {
      const { row, scope } = await this.access.group(m, actor, id);
      // Reading the group feed never requires stock-management permission.
      const rows: Record<string, unknown>[] = await m.query(
        `SELECT ${companyFields} FROM watchlist_group_items i JOIN companies c ON c.id=i.company_id WHERE i.group_id=? ORDER BY i.position,i.id LIMIT 200`,
        [id],
      );
      const companies = rows.map(companyView);
      if (companyId && !companies.some((company) => company.id === companyId))
        throw new BadRequestException('이 그룹에 없는 종목입니다. 전체 소식을 다시 선택해 주세요.');
      return {
        group: this.view(row, scope),
        companies,
        selectedCompanies: companyId
          ? companies.filter((company) => company.id === companyId)
          : companies,
      };
    });
  }
  private async requireCompany(m: EntityManager, companyId: string): Promise<void> {
    const rows = await m.query('SELECT id FROM companies WHERE id=?', [companyId]);
    if (!rows.length) throw new NotFoundException('종목을 찾을 수 없습니다.');
  }
  companyMemberships(actor: GroupActor, companyId: string): Promise<CompanyWatchlistMemberships> {
    return this.access.transaction(actor, async (m) => {
      await this.requireCompany(m, companyId);
      const rows: Array<
        GroupRow & { roomName: string | null; selected: unknown; canManageStocks: unknown }
      > = await m.query(
        `SELECT g.*,r.name roomName,
        (SELECT COUNT(*) FROM watchlist_group_items i WHERE i.group_id=g.id) itemCount,
        EXISTS(SELECT 1 FROM watchlist_group_items i WHERE i.group_id=g.id AND i.company_id=?) selected,
        CASE WHEN g.room_id IS NULL OR r.owner_key=? OR rm.role='ADMIN' OR rm.can_manage_stocks=1 THEN 1 ELSE 0 END canManageStocks
        FROM watchlist_groups g
        LEFT JOIN watchlist_rooms r ON r.id=g.room_id
        LEFT JOIN watchlist_room_members rm ON rm.room_id=r.id AND rm.actor_key=?
        WHERE (g.room_id IS NULL AND g.owner_key=?)
        OR (g.room_id IS NOT NULL AND rm.actor_key IS NOT NULL AND ${activeActorSql('r.owner_key')})
        ORDER BY g.room_id IS NOT NULL,rm.position,r.created_at,r.id,g.position,g.id`,
        [companyId, actor.key, actor.key, actor.key],
      );
      return {
        companyId,
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.room_id ? 'ROOM' : 'PERSONAL',
          roomId: row.room_id,
          roomName: row.roomName,
          revision: Number(row.revision),
          selected: sqlBoolean(row.selected),
          itemCount: Number(row.itemCount),
          canManageStocks: sqlBoolean(row.canManageStocks),
        })),
      };
    });
  }
  saveCompanyMemberships(
    actor: GroupActor,
    companyId: string,
    input: SaveCompanyWatchlistMemberships,
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      await this.requireCompany(m, companyId);
      const pending: Array<{
        row: GroupRow;
        scope: Scope;
        before: string[];
        after: string[];
        selected: boolean;
        position: number;
      }> = [];
      // Validate and lock every group before changing any membership.
      for (const change of [...input.changes].sort((a, b) => a.groupId.localeCompare(b.groupId))) {
        const { row, scope } = await this.access.group(m, actor, change.groupId);
        this.access.require(scope, 'canManageStocks');
        this.access.version(row.revision, change.revision);
        // Match the locked group revision even when an earlier read opened an MVCC snapshot.
        const items: Array<{ company_id: string; position: number }> = await m.query(
          'SELECT company_id,position FROM watchlist_group_items WHERE group_id=? ORDER BY position,id FOR UPDATE',
          [row.id],
        );
        const before = items.map((item) => item.company_id);
        if (before.includes(companyId) === change.selected) continue;
        if (change.selected && before.length >= 200)
          throw new ConflictException('그룹에는 최대 200개 종목까지 등록할 수 있습니다.');
        pending.push({
          row,
          scope,
          before,
          after: change.selected ? [...before, companyId] : before.filter((id) => id !== companyId),
          selected: change.selected,
          position: Math.max(-1, ...items.map((item) => Number(item.position))) + 1,
        });
      }
      for (const change of pending) {
        if (change.selected)
          await m.query(
            'INSERT INTO watchlist_group_items(id,group_id,company_id,position) VALUES (?,?,?,?)',
            [randomUUID(), change.row.id, companyId, change.position],
          );
        else
          await m.query('DELETE FROM watchlist_group_items WHERE group_id=? AND company_id=?', [
            change.row.id,
            companyId,
          ]);
        await this.completeItemsChange(
          m,
          actor,
          change.row,
          change.scope,
          change.before,
          change.after,
        );
      }
    });
  }
  async create(
    actor: GroupActor,
    input: { name: string; roomId?: string },
  ): Promise<WatchlistGroup> {
    return this.access.transaction(actor, async (m) => {
      const scope = await this.access.scope(m, actor, input.roomId);
      this.access.require(scope, 'canManageGroups');
      const rows = await this.rows(m, actor, input.roomId);
      if (rows.length >= 20) throw new ConflictException('공간당 그룹은 최대 20개입니다.');
      const id = randomUUID();
      await m.query(
        'INSERT INTO watchlist_groups(id,owner_key,room_id,name,position) VALUES (?,?,?,?,?)',
        [id, actor.key, input.roomId ?? null, input.name, rows.length],
      );
      await this.access.bump(m, actor, scope.roomId);
      await this.access.audit(m, actor, 'GROUP_CREATED', scope.roomId, id, { name: input.name });
      const { row } = await this.access.group(m, actor, id);
      return this.view(row, scope);
    });
  }
  saveGroups(
    actor: GroupActor,
    input: { roomId?: string; revision: number; groups: Array<{ id: string; name: string }> },
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const scope = await this.access.scope(m, actor, input.roomId);
      this.access.require(scope, 'canManageGroups');
      this.access.version(scope.revision, input.revision);
      const old = await this.rows(m, actor, input.roomId),
        ids = new Set(input.groups.map((g) => g.id));
      if (input.groups.some((g) => !old.some((r) => r.id === g.id)))
        throw new NotFoundException('이 공간에 없는 그룹입니다.');
      for (const row of old.filter((r) => !ids.has(r.id))) {
        if (Number(row.itemCount) > 0) this.access.require(scope, 'canManageStocks');
        await m.query('DELETE FROM watchlist_groups WHERE id=?', [row.id]);
      }
      for (const [position, g] of input.groups.entries())
        await m.query(
          'UPDATE watchlist_groups SET name=?,position=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',
          [g.name, position, g.id],
        );
      await this.access.bump(m, actor, scope.roomId);
      await this.access.audit(m, actor, 'GROUPS_SAVED', scope.roomId, null, {
        before: old.map((r) => ({ id: r.id, name: r.name })),
        after: input.groups,
      });
    });
  }
  editItems(actor: GroupActor, id: string) {
    return this.access.transaction(actor, async (m) => {
      const { row, scope } = await this.access.group(m, actor, id);
      this.access.require(scope, 'canManageStocks');
      const rows: Record<string, unknown>[] = await m.query(
        `SELECT ${companyFields} FROM watchlist_group_items i JOIN companies c ON c.id=i.company_id WHERE i.group_id=? ORDER BY i.position,i.id LIMIT 200`,
        [id],
      );
      return {
        group: this.view(row, scope),
        revision: Number(row.revision),
        items: rows.map(companyView),
      };
    });
  }
  private async writeItems(
    m: EntityManager,
    actor: GroupActor,
    row: GroupRow,
    scope: Scope,
    companyIds: string[],
  ): Promise<void> {
    if (companyIds.length > 200 || new Set(companyIds).size !== companyIds.length)
      throw new ConflictException('종목은 중복 없이 최대 200개까지 등록할 수 있습니다.');
    if (companyIds.length) {
      const [{ n }] = await m.query(
        `SELECT COUNT(*) n FROM companies WHERE id IN (${marks(companyIds)})`,
        companyIds,
      );
      if (Number(n) !== companyIds.length)
        throw new NotFoundException('존재하지 않는 종목이 있습니다.');
    }
    const before = await m.query(
      'SELECT company_id FROM watchlist_group_items WHERE group_id=? ORDER BY position,id',
      [row.id],
    );
    await m.query(
      `DELETE FROM watchlist_group_items WHERE group_id=?${companyIds.length ? ` AND company_id NOT IN (${marks(companyIds)})` : ''}`,
      [row.id, ...companyIds],
    );
    for (const [position, companyId] of companyIds.entries())
      await m.query(
        'INSERT INTO watchlist_group_items(id,group_id,company_id,position) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE position=VALUES(position)',
        [randomUUID(), row.id, companyId, position],
      );
    await this.completeItemsChange(
      m,
      actor,
      row,
      scope,
      before.map((r: { company_id: string }) => r.company_id),
      companyIds,
    );
  }
  private async completeItemsChange(
    m: EntityManager,
    actor: GroupActor,
    row: GroupRow,
    scope: Scope,
    before: string[],
    after: string[],
  ): Promise<void> {
    await m.query(
      'UPDATE watchlist_groups SET revision=revision+1,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?',
      [row.id],
    );
    await this.access.bump(m, actor, scope.roomId);
    await this.access.audit(m, actor, 'GROUP_ITEMS_SAVED', scope.roomId, row.id, {
      before,
      after,
    });
  }
  saveItems(
    actor: GroupActor,
    id: string,
    input: { revision: number; companyIds: string[] },
  ): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const { row, scope } = await this.access.group(m, actor, id);
      this.access.require(scope, 'canManageStocks');
      this.access.version(row.revision, input.revision);
      await this.writeItems(m, actor, row, scope, input.companyIds);
    });
  }
  addItem(actor: GroupActor, id: string, companyId: string, revision: number): Promise<void> {
    return this.access.transaction(actor, async (m) => {
      const { row, scope } = await this.access.group(m, actor, id);
      this.access.require(scope, 'canManageStocks');
      this.access.version(row.revision, revision);
      const old: Array<{ company_id: string }> = await m.query(
        'SELECT company_id FROM watchlist_group_items WHERE group_id=? ORDER BY position,id',
        [id],
      );
      if (old.some((i) => i.company_id === companyId))
        throw new ConflictException('이미 등록된 종목입니다.');
      await this.writeItems(m, actor, row, scope, [...old.map((i) => i.company_id), companyId]);
    });
  }
  copy(
    actor: GroupActor,
    id: string,
    input: { roomId: string; revision: number },
  ): Promise<WatchlistGroup> {
    return this.access.transaction(actor, async (m) => {
      const { row } = await this.access.group(m, actor, id);
      if (row.room_id) throw new ConflictException('개인 그룹만 공유방에 복사할 수 있습니다.');
      this.access.version(row.revision, input.revision);
      const scope = await this.access.scope(m, actor, input.roomId);
      this.access.require(scope, 'canManageGroups');
      this.access.require(scope, 'canManageStocks');
      const rows = await this.rows(m, actor, input.roomId);
      if (rows.length >= 20) throw new ConflictException('공간당 그룹은 최대 20개입니다.');
      const newId = randomUUID();
      await m.query(
        'INSERT INTO watchlist_groups(id,owner_key,room_id,name,position) VALUES (?,?,?,?,?)',
        [newId, actor.key, input.roomId, row.name, rows.length],
      );
      await m.query(
        'INSERT INTO watchlist_group_items(id,group_id,company_id,position) SELECT UUID(),?,company_id,position FROM watchlist_group_items WHERE group_id=?',
        [newId, id],
      );
      await this.access.bump(m, actor, scope.roomId);
      await this.access.audit(m, actor, 'GROUP_COPIED', scope.roomId, newId, { sourceGroupId: id });
      const copied = await this.access.group(m, actor, newId);
      return this.view(copied.row, scope);
    });
  }
  async items(
    actor: GroupActor,
    id: string,
    page: { offset: number; limit: number },
  ): Promise<WatchlistGroupItems> {
    return this.access.transaction(actor, async (m) => {
      const { row, scope } = await this.access.group(m, actor, id);
      const rows: Record<string, unknown>[] = await m.query(
        `SELECT ${companyFields} FROM watchlist_group_items i JOIN companies c ON c.id=i.company_id WHERE i.group_id=? ORDER BY i.position,i.id LIMIT ? OFFSET ?`,
        [id, page.limit, page.offset],
      );
      const observed = await this.observations.observe(m, rows.map(companyView));
      return {
        ...observed,
        group: this.view(row, scope),
        total: Number(row.itemCount),
        nextOffset:
          page.offset + rows.length < Number(row.itemCount) ? page.offset + rows.length : null,
      };
    });
  }
  retired(): never {
    throw new GoneException('공유방 기능으로 변경되었습니다. 화면을 새로고침하세요.');
  }
}
