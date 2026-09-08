import type { CompanyDetail, CursorPage, PersonalFiling, SourceItem } from '../types';
import {
  roomCreateSchema,
  watchNameSchema,
  watchRevisionSchema,
  type WatchRoom,
} from '@orsem/contracts';
import { ApiError } from './api';
import { fixtureGroups } from './company-membership-fixtures';
import { recentCompanyPrice } from './recent-company-quotes';

type FixtureGroup = (typeof fixtureGroups)[number];
const personalPermissions = {
  canManageGroups: true,
  canManageStocks: true,
  canManageMembers: false,
};
const scopeRevisions = new Map<string, number>();
const fixtureRooms = new Map<string, WatchRoom>();
for (const group of fixtureGroups) {
  if (!group.roomId || fixtureRooms.has(group.roomId)) continue;
  fixtureRooms.set(group.roomId, {
    id: group.roomId,
    name: group.roomName ?? '공유방',
    description: '개발용 공유방 표본',
    ownerLabel: '개발 표본',
    role: group.canManageStocks ? 'ADMIN' : 'MEMBER',
    revision: 0,
    memberCount: 2,
    canManageGroups: group.canManageStocks,
    canManageStocks: group.canManageStocks,
    canManageMembers: false,
  });
}
const scopeKey = (roomId?: string | null) => roomId ?? 'personal';
const revisionFor = (roomId?: string | null) => scopeRevisions.get(scopeKey(roomId)) ?? 0;
const bumpScope = (roomId?: string | null) => {
  const revision = revisionFor(roomId) + 1;
  scopeRevisions.set(scopeKey(roomId), revision);
  const room = roomId ? fixtureRooms.get(roomId) : undefined;
  if (room) room.revision = revision;
};
const invalid = (): never => {
  throw new ApiError(400, 'BAD_REQUEST', '입력 내용을 확인해 주세요.');
};
const record = (body: unknown, keys: string[]) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
  if (Object.keys(body).some((key) => !keys.includes(key))) return invalid();
  return body as Record<string, unknown>;
};
const fixtureId = (value: unknown): string =>
  typeof value === 'string' && value.trim().length > 0 ? value : invalid();
const inputRoomId = (value: unknown) => (value === undefined ? undefined : fixtureId(value));
const inputName = (value: unknown) => {
  const parsed = watchNameSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
};
const inputRevision = (value: unknown) => {
  const parsed = watchRevisionSchema.safeParse(value);
  return parsed.success ? parsed.data : invalid();
};
const verifyRevision = (expected: number, actual: number) => {
  if (expected !== actual)
    throw new ApiError(409, 'REVISION_CONFLICT', '목록이 변경되었습니다. 새로 불러와 주세요.');
};

interface FixtureContext {
  searchParams: URLSearchParams;
  authenticated: boolean;
  news: (companyIds: string[]) => CursorPage<SourceItem>;
  filings: (companyIds: string[]) => PersonalFiling[];
}

/** Development-only in-memory state. Never imported by the production request path. */
export function watchlistWorkspaceFixture(
  path: string,
  method: string,
  body: unknown,
  companies: CompanyDetail[],
  now: string,
  context: FixtureContext,
): { handled: boolean; value?: unknown } {
  if (!/^\/watchlist-(?:groups|rooms)(?:\/|$)/u.test(path)) return { handled: false };
  if (!context.authenticated) throw new ApiError(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
  const readScope = (roomId?: string | null) => {
    const room = roomId ? fixtureRooms.get(roomId) : null;
    if (roomId && !room)
      throw new ApiError(404, 'WATCH_SCOPE_NOT_FOUND', '참여 가능한 공유방을 찾을 수 없습니다.');
    return {
      room,
      groups: fixtureGroups.filter((g) => (roomId ? g.roomId === roomId : g.kind === 'PERSONAL')),
      permissions: room
        ? {
            canManageGroups: room.canManageGroups,
            canManageStocks: room.canManageStocks,
            canManageMembers: room.canManageMembers,
          }
        : personalPermissions,
    };
  };
  const requireManagement = (roomId?: string | null) => {
    const scope = readScope(roomId);
    if (!scope.permissions.canManageGroups)
      throw new ApiError(403, 'FORBIDDEN', '공유방을 수정할 수 없습니다.');
    return scope;
  };
  const view = (g: FixtureGroup) => ({
    ...g,
    companyIds: undefined,
    ...readScope(g.roomId).permissions,
    isShared: g.kind === 'ROOM',
    isFollowing: false,
    canEdit: g.canManageStocks,
    itemCount: g.companyIds.size,
    ownerLabel: g.roomName ?? '나',
    updatedAt: now,
  });
  const createGroup = (name: string, roomId?: string, companyIds = new Set<string>()) => {
    const scope = requireManagement(roomId);
    if (scope.groups.length >= 20)
      throw new ApiError(409, 'CONFLICT', '공간당 그룹은 최대 20개입니다.');
    const group: FixtureGroup = {
      id: crypto.randomUUID(),
      name,
      kind: scope.room ? 'ROOM' : 'PERSONAL',
      roomId: scope.room?.id ?? null,
      roomName: scope.room?.name ?? null,
      revision: 0,
      selected: false,
      itemCount: companyIds.size,
      canManageStocks: scope.permissions.canManageStocks,
      companyIds: new Set(companyIds),
    };
    fixtureGroups.push(group);
    bumpScope(roomId);
    return view(group);
  };
  if (path === '/watchlist-rooms' && method === 'POST') {
    const parsed = roomCreateSchema.safeParse(body);
    if (!parsed.success) return invalid();
    if ([...fixtureRooms.values()].filter((room) => room.role === 'OWNER').length >= 20)
      throw new ApiError(409, 'CONFLICT', '공유방은 최대 20개까지 만들 수 있습니다.');
    const room: WatchRoom = {
      ...parsed.data,
      id: crypto.randomUUID(),
      ownerLabel: '나',
      role: 'OWNER',
      revision: 0,
      memberCount: 1,
      canManageGroups: true,
      canManageStocks: true,
      canManageMembers: true,
    };
    fixtureRooms.set(room.id, room);
    return { handled: true, value: { ...room } };
  }
  if (path === '/watchlist-rooms' && method === 'GET')
    return {
      handled: true,
      value: { items: [...fixtureRooms.values()].map((room) => ({ ...room })) },
    };
  if (path === '/watchlist-groups') {
    if (method === 'POST') {
      const input = record(body, ['name', 'roomId']);
      return {
        handled: true,
        value: createGroup(inputName(input.name), inputRoomId(input.roomId)),
      };
    }
    if (method !== 'GET') return { handled: false };
    const requestedRoomId = context.searchParams.get('roomId');
    const scope = readScope(requestedRoomId);
    return {
      handled: true,
      value: {
        items: scope.groups.map(view),
        revision: revisionFor(requestedRoomId),
        permissions: scope.permissions,
      },
    };
  }
  if (path === '/watchlist-groups/edit' && method === 'PUT') {
    const input = record(body, ['roomId', 'revision', 'groups']);
    const roomId = inputRoomId(input.roomId);
    const revision = inputRevision(input.revision);
    if (!Array.isArray(input.groups) || input.groups.length > 20) return invalid();
    const changes = input.groups.map((value: unknown) => {
      const group = record(value, ['id', 'name']);
      return { id: fixtureId(group.id), name: inputName(group.name) };
    });
    if (new Set(changes.map((group) => group.id)).size !== changes.length) return invalid();
    const scope = requireManagement(roomId);
    verifyRevision(revisionFor(roomId), revision);
    if (changes.some((change) => !scope.groups.some((group) => group.id === change.id)))
      throw new ApiError(404, 'NOT_FOUND', '이 공간에 없는 그룹입니다.');
    const retained = new Set(changes.map((change) => change.id));
    if (
      !scope.permissions.canManageStocks &&
      scope.groups.some((group) => !retained.has(group.id) && group.companyIds.size > 0)
    )
      throw new ApiError(403, 'FORBIDDEN', '종목이 있는 그룹을 삭제할 권한이 없습니다.');
    // Validate the complete batch before applying names, deletion or order.
    const ordered = changes.map((change) => {
      const group = scope.groups.find((group) => group.id === change.id)!;
      group.name = change.name;
      group.revision++;
      return group;
    });
    const previous = new Set(scope.groups);
    const next: FixtureGroup[] = [];
    let inserted = false;
    for (const group of fixtureGroups) {
      if (!previous.has(group)) next.push(group);
      else if (!inserted) {
        next.push(...ordered);
        inserted = true;
      }
    }
    fixtureGroups.splice(0, fixtureGroups.length, ...next);
    bumpScope(roomId);
    return { handled: true };
  }
  const route = path.match(/^\/watchlist-groups\/([^/]+)\/(items|edit|news|filings|copy|quotes)$/);
  if (!route) return { handled: false };
  const group = fixtureGroups.find((g) => g.id === decodeURIComponent(route[1]!));
  if (!group) throw new ApiError(404, 'NOT_FOUND', '그룹을 찾을 수 없습니다.');
  if (route[2] === 'copy' && method === 'POST') {
    const input = record(body, ['roomId', 'revision']);
    const roomId = fixtureId(input.roomId);
    const revision = inputRevision(input.revision);
    if (group.kind !== 'PERSONAL')
      throw new ApiError(409, 'CONFLICT', '개인 그룹만 공유방에 복사할 수 있습니다.');
    verifyRevision(group.revision, revision);
    const scope = requireManagement(roomId);
    if (!scope.permissions.canManageStocks)
      throw new ApiError(403, 'FORBIDDEN', '종목을 복사할 권한이 없습니다.');
    return { handled: true, value: createGroup(group.name, roomId, group.companyIds) };
  }
  if (method === 'PUT' && route[2] === 'edit') {
    if (!group.canManageStocks) throw new ApiError(403, 'FORBIDDEN', '읽기 전용 그룹입니다.');
    const input = body as { companyIds: string[]; revision: number };
    if (input.revision !== group.revision)
      throw new ApiError(409, 'REVISION_CONFLICT', '그룹이 변경되었습니다.');
    group.companyIds = new Set(input.companyIds);
    group.revision++;
    bumpScope(group.roomId);
    return { handled: true };
  }
  if (method !== 'GET' || route[2] === 'copy') return { handled: false };
  const selected = [...group.companyIds]
    .map((id) => companies.find((c) => c.id === id))
    .filter((company): company is CompanyDetail => Boolean(company));
  if (route[2] === 'quotes') {
    readScope(group.roomId);
    return {
      handled: true,
      value: {
        asOf: new Date().toISOString(),
        items: selected.slice(0, 200).map((company) => ({
          companyId: company.id,
          displayPrice: recentCompanyPrice(undefined, company.market, true),
        })),
      },
    };
  }
  if (route[2] === 'news' || route[2] === 'filings') {
    const companyId = context.searchParams.get('companyId');
    if (companyId && !selected.some((company) => company.id === companyId))
      throw new ApiError(
        400,
        'BAD_REQUEST',
        '이 그룹에 없는 종목입니다. 전체 소식을 다시 선택해 주세요.',
      );
    const ids = selected
      .filter((company) => !companyId || company.id === companyId)
      .map((c) => c.id);
    return {
      handled: true,
      value: {
        ...(route[2] === 'news'
          ? { ...context.news(ids), providerGroups: [], naver: null }
          : { items: context.filings(ids) }),
        group: view(group),
        companies: selected.map(
          ({ id, nameKo, nameEn, market, stockCode, ticker, corpCode, cik, isListed }) => ({
            id,
            nameKo,
            nameEn,
            market,
            stockCode,
            ticker,
            corpCode,
            cik,
            isListed,
            updatedAt: now,
          }),
        ),
        companyCount: ids.length,
        asOf: now,
      },
    };
  }
  if (route[2] === 'edit')
    return {
      handled: true,
      value: { group: view(group), revision: group.revision, items: selected },
    };
  const offset = Math.max(0, Number.parseInt(context.searchParams.get('offset') ?? '0', 10) || 0);
  const limit = Math.min(
    21,
    Math.max(1, Number.parseInt(context.searchParams.get('limit') ?? '20', 10) || 20),
  );
  return {
    handled: true,
    value: {
      group: view(group),
      items: selected.slice(offset, offset + limit).map((company) => ({
        company,
        displayPrice: {
          price: null,
          currency: company.stockCode ? 'KRW' : 'USD',
          status: 'UNAVAILABLE',
          basis: 'NONE',
          source: null,
          sessionDate: null,
          providerAt: null,
          referenceClose: null,
          referenceDate: null,
          change: null,
          changePercent: null,
        },
        sparkline: [],
        recentActivity: { filingCount: 0, eventCount: 0, items: [] },
      })),
      total: selected.length,
      nextOffset: offset + limit < selected.length ? offset + limit : null,
      asOf: now,
      windowStartDate: '2026-08-31',
      windowEndDate: '2026-09-06',
    },
  };
}
