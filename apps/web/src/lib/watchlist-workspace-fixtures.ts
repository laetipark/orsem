import type { CompanyDetail } from '../types';
import { fixtureGroups } from './company-membership-fixtures';

/** Development-only in-memory state. Never imported by the production request path. */
export function watchlistWorkspaceFixture(
  path: string,
  method: string,
  body: unknown,
  companies: CompanyDetail[],
  now: string,
): { handled: boolean; value?: unknown } {
  const permissions = { canManageGroups: true, canManageStocks: true, canManageMembers: false };
  const view = (g: (typeof fixtureGroups)[number]) => ({
    ...g,
    companyIds: undefined,
    ...permissions,
    isShared: false,
    isFollowing: false,
    canEdit: true,
    itemCount: g.companyIds.size,
    ownerLabel: '나',
    updatedAt: now,
  });
  if (path === '/watchlist-rooms') return { handled: true, value: { items: [] } };
  if (path === '/watchlist-groups') {
    if (method === 'POST') {
      const input = body as { name: string };
      const group: (typeof fixtureGroups)[number] = {
        id: crypto.randomUUID(),
        name: input.name,
        kind: 'PERSONAL',
        roomId: null,
        roomName: null,
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
        items: fixtureGroups.filter((g) => g.kind === 'PERSONAL').map(view),
        revision: 0,
        permissions,
      },
    };
  }
  if (path === '/watchlist-groups/edit' && method === 'PUT') {
    const input = body as { groups: Array<{ id: string; name: string }> };
    for (let i = fixtureGroups.length - 1; i >= 0; i--) {
      const group = fixtureGroups[i]!;
      if (group.kind !== 'PERSONAL') continue;
      const next = input.groups.find((g) => g.id === group.id);
      if (next) group.name = next.name;
      else fixtureGroups.splice(i, 1);
    }
    return { handled: true };
  }
  const route = path.match(/^\/watchlist-groups\/([^/]+)\/(items|edit)$/);
  if (!route) return { handled: false };
  const group = fixtureGroups.find((g) => g.id === route[1]);
  if (!group) throw new Error('그룹을 찾을 수 없습니다.');
  if (method === 'PUT') {
    const input = body as { companyIds: string[]; revision: number };
    if (input.revision !== group.revision) throw new Error('그룹이 변경되었습니다.');
    group.companyIds = new Set(input.companyIds);
    group.revision++;
    return { handled: true };
  }
  const selected = companies.filter((c) => group.companyIds.has(c.id));
  if (route[2] === 'edit')
    return {
      handled: true,
      value: { group: view(group), revision: group.revision, items: selected },
    };
  return {
    handled: true,
    value: {
      group: view(group),
      items: selected.map((company) => ({
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
      nextOffset: null,
      asOf: now,
      windowStartDate: '2026-08-31',
      windowEndDate: '2026-09-06',
    },
  };
}
