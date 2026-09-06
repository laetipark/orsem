import type {
  CompanyWatchlistMembership,
  CompanyWatchlistMemberships,
  SaveCompanyWatchlistMemberships,
} from '@orsem/contracts';
import { ApiError } from './api';

export const fixtureGroups: Array<CompanyWatchlistMembership & { companyIds: Set<string> }> = [
  {
    id: 'fixture-personal-semiconductors',
    name: '반도체',
    kind: 'PERSONAL',
    roomId: null,
    roomName: null,
    revision: 1,
    selected: false,
    itemCount: 1,
    canManageStocks: true,
    companyIds: new Set(['company-samsung']),
  },
  {
    id: 'fixture-personal-growth',
    name: '성장주',
    kind: 'PERSONAL',
    roomId: null,
    roomName: null,
    revision: 1,
    selected: false,
    itemCount: 1,
    canManageStocks: true,
    companyIds: new Set(['company-msft']),
  },
  {
    id: 'fixture-room-tech',
    name: '해외 기술주',
    kind: 'ROOM',
    roomId: 'fixture-room',
    roomName: '함께 보는 종목',
    revision: 3,
    selected: false,
    itemCount: 1,
    canManageStocks: true,
    companyIds: new Set(['company-msft']),
  },
  {
    id: 'fixture-room-stable',
    name: '우량주',
    kind: 'ROOM',
    roomId: 'fixture-readonly-room',
    roomName: '공유 리서치',
    revision: 2,
    selected: false,
    itemCount: 1,
    canManageStocks: false,
    companyIds: new Set(['company-samsung']),
  },
];

export function companyMembershipFixture(
  companyId: string,
  input?: SaveCompanyWatchlistMemberships,
): CompanyWatchlistMemberships {
  if (input) {
    // Validate the complete batch before modifying fixture state, matching the API transaction.
    for (const change of input.changes) {
      const group = fixtureGroups.find((g) => g.id === change.groupId);
      if (!group) throw new ApiError(404, 'NOT_FOUND', '그룹을 찾을 수 없습니다.');
      if (!group.canManageStocks) throw new ApiError(403, 'FORBIDDEN', '읽기 전용 그룹입니다.');
      if (group.revision !== change.revision)
        throw new ApiError(409, 'REVISION_CONFLICT', '그룹이 변경되었습니다.');
    }
    for (const change of input.changes) {
      const group = fixtureGroups.find((g) => g.id === change.groupId)!;
      if (change.selected) group.companyIds.add(companyId);
      else group.companyIds.delete(companyId);
      group.revision += 1;
    }
  }
  return {
    companyId,
    items: fixtureGroups.map(({ companyIds, ...group }) => ({
      ...group,
      selected: companyIds.has(companyId),
      itemCount: companyIds.size,
    })),
  };
}
