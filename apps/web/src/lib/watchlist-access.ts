import { ApiError } from './api';

const missingAccessCodes = new Set(['WATCH_SCOPE_NOT_FOUND', 'WATCH_GROUP_NOT_FOUND']);
// Compatibility with servers deployed before structured watchlist access codes.
const missingAccessMessages = new Set([
  '참여 가능한 공유방을 찾을 수 없습니다.',
  '접근 가능한 그룹을 찾을 수 없습니다.',
  '그룹이 삭제되었습니다.',
]);

/** A missing route/resource is not evidence that the user's watchlist access changed. */
export function watchlistAccessDenied(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.statusCode === 401 || error.statusCode === 403) return true;
  return (
    error.statusCode === 404 &&
    (missingAccessCodes.has(error.code) || missingAccessMessages.has(error.message))
  );
}
