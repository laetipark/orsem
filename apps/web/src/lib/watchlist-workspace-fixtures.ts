import type { CompanyDetail, CursorPage, PersonalFiling, SourceItem } from '../types';
import { ApiError } from './api';
import { fixtureGroups } from './company-membership-fixtures';

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
  const permissions = { canManageGroups: true, canManageStocks: true, canManageMembers: false };
  const groupPermissions = (g: (typeof fixtureGroups)[number]) => ({
    canManageGroups: g.canManageStocks,
    canManageStocks: g.canManageStocks,
    canManageMembers: false,
  });
  const view = (g: (typeof fixtureGroups)[number]) => ({
    ...g,
    companyIds: undefined,
    ...groupPermissions(g),
    isShared: g.kind === 'ROOM',
    isFollowing: false,
    canEdit: g.canManageStocks,
    itemCount: g.companyIds.size,
    ownerLabel: g.roomName ?? '나',
    updatedAt: now,
  });
  if (path === '/watchlist-rooms')
    return {
      handled: true,
      value: {
        items: [...new Set(fixtureGroups.map((g) => g.roomId).filter(Boolean))].map((id) => {
          const group = fixtureGroups.find((g) => g.roomId === id)!;
          return {
            id,
            name: group.roomName,
            description: '개발용 공유방 표본',
            ownerLabel: '개발 표본',
            role: group.canManageStocks ? 'ADMIN' : 'MEMBER',
            revision: 0,
            memberCount: 2,
            ...groupPermissions(group),
          };
        }),
      },
    };
  if (path === '/watchlist-groups') {
    const requestedRoomId = context.searchParams.get('roomId');
    const scopeGroups = fixtureGroups.filter((g) =>
      requestedRoomId ? g.roomId === requestedRoomId : g.kind === 'PERSONAL',
    );
    if (requestedRoomId && !scopeGroups.length)
      throw new ApiError(403, 'FORBIDDEN', '공유방을 조회할 수 없습니다.');
    if (method === 'POST') {
      const input = body as { name: string; roomId?: string };
      const room = input.roomId ? fixtureGroups.find((g) => g.roomId === input.roomId) : null;
      if (input.roomId && !room?.canManageStocks)
        throw new ApiError(403, 'FORBIDDEN', '공유방을 수정할 수 없습니다.');
      const group: (typeof fixtureGroups)[number] = {
        id: crypto.randomUUID(),
        name: input.name,
        kind: room ? 'ROOM' : 'PERSONAL',
        roomId: room?.roomId ?? null,
        roomName: room?.roomName ?? null,
        revision: 0,
        selected: false,
        itemCount: 0,
        canManageStocks: true,
        companyIds: new Set(),
      };
      fixtureGroups.push(group);
      return { handled: true, value: view(group) };
    }
    return {
      handled: true,
      value: {
        items: scopeGroups.map(view),
        revision: 0,
        permissions: scopeGroups[0] ? groupPermissions(scopeGroups[0]) : permissions,
      },
    };
  }
  if (path === '/watchlist-groups/edit' && method === 'PUT') {
    const input = body as { roomId?: string; groups: Array<{ id: string; name: string }> };
    const room = input.roomId ? fixtureGroups.find((g) => g.roomId === input.roomId) : null;
    if (input.roomId && !room?.canManageStocks)
      throw new ApiError(403, 'FORBIDDEN', '공유방을 수정할 수 없습니다.');
    for (let i = fixtureGroups.length - 1; i >= 0; i--) {
      const group = fixtureGroups[i]!;
      if (input.roomId ? group.roomId !== input.roomId : group.kind !== 'PERSONAL') continue;
      const next = input.groups.find((g) => g.id === group.id);
      if (next) group.name = next.name;
      else fixtureGroups.splice(i, 1);
    }
    return { handled: true };
  }
  const route = path.match(/^\/watchlist-groups\/([^/]+)\/(items|edit|news|filings)$/);
  if (!route) return { handled: false };
  const group = fixtureGroups.find((g) => g.id === decodeURIComponent(route[1]!));
  if (!group) throw new ApiError(404, 'NOT_FOUND', '그룹을 찾을 수 없습니다.');
  if (method === 'PUT') {
    if (!group.canManageStocks) throw new ApiError(403, 'FORBIDDEN', '읽기 전용 그룹입니다.');
    const input = body as { companyIds: string[]; revision: number };
    if (input.revision !== group.revision)
      throw new ApiError(409, 'REVISION_CONFLICT', '그룹이 변경되었습니다.');
    group.companyIds = new Set(input.companyIds);
    group.revision++;
    return { handled: true };
  }
  const selected = [...group.companyIds]
    .map((id) => companies.find((c) => c.id === id))
    .filter((company): company is CompanyDetail => Boolean(company));
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
