import { expect, it } from 'vitest';
import { ApiError } from './api';
import { watchlistAccessDenied } from './watchlist-access';

it.each([
  { status: 401, code: 'UNAUTHORIZED', message: '로그인이 필요합니다.', denied: true },
  { status: 403, code: 'FORBIDDEN', message: '권한이 없습니다.', denied: true },
  { status: 404, code: 'WATCH_SCOPE_NOT_FOUND', message: 'Scope is unavailable', denied: true },
  { status: 404, code: 'WATCH_GROUP_NOT_FOUND', message: 'Group is unavailable', denied: true },
  {
    status: 404,
    code: 'NOT_FOUND',
    message: '참여 가능한 공유방을 찾을 수 없습니다.',
    denied: true,
  },
  { status: 404, code: 'NOT_FOUND', message: '접근 가능한 그룹을 찾을 수 없습니다.', denied: true },
  { status: 404, code: 'NOT_FOUND', message: '그룹이 삭제되었습니다.', denied: true },
  {
    status: 404,
    code: 'NOT_FOUND',
    message: 'Cannot GET /api/v1/watchlist-groups/own/news',
    denied: false,
  },
  { status: 404, code: 'HTTP_ERROR', message: '요청을 처리하지 못했습니다.', denied: false },
  { status: 404, code: 'NOT_FOUND', message: '뉴스를 찾을 수 없습니다.', denied: false },
  {
    status: 404,
    code: 'NOT_FOUND',
    message: '공유방 뉴스 경로를 찾을 수 없습니다.',
    denied: false,
  },
  { status: 500, code: 'WATCH_GROUP_NOT_FOUND', message: '그룹이 삭제되었습니다.', denied: false },
])(
  'classifies $status / $code / $message as access denied=$denied',
  ({ status, code, message, denied }) => {
    expect(watchlistAccessDenied(new ApiError(status, code, message))).toBe(denied);
  },
);

it('does not interpret network or unrelated errors as access loss', () => {
  expect(watchlistAccessDenied(new Error('Failed to fetch'))).toBe(false);
  expect(watchlistAccessDenied({ statusCode: 403 })).toBe(false);
  expect(watchlistAccessDenied(undefined)).toBe(false);
  expect(watchlistAccessDenied(null)).toBe(false);
});
