import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor } from './cursor';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

export interface PageQuery {
  cursor?: string;
  limit: number;
}

// The caller filters and orders rows before passing at most limit + 1 results here.
// Only visible rows are mapped; the lookahead row determines whether another page exists.
export function pageRows<Row extends { id: string }, Dto>(
  rows: Row[],
  limit: number,
  mapper: (row: Row) => Dto,
  sortValue: (row: Row) => string,
): CursorPage<Dto> {
  const visible = rows.slice(0, limit);
  return finishPage(rows, limit, visible.map(mapper), sortValue);
}

export function finishPage<Row extends { id: string }, Dto>(
  rows: Row[],
  limit: number,
  items: Dto[],
  sortValue: (row: Row) => string,
): CursorPage<Dto> {
  const hasMore = rows.length > limit;
  const last = rows[Math.min(rows.length, limit) - 1];
  const nextCursor = hasMore && last ? encodeCursor({ sort: sortValue(last), id: last.id }) : null;
  return {
    items,
    nextCursor,
    pageInfo: {
      hasMore,
      nextCursor,
    },
  };
}

export function paginateFixture<T extends { id: string }>(
  rows: T[],
  query: PageQuery,
  sortValue: (row: T) => string,
): CursorPage<T> {
  const cursor = decodeCursor(query.cursor);
  const cursorIndex = cursor ? rows.findIndex((item) => item.id === cursor.id) : -1;
  if (cursor && cursorIndex < 0)
    throw new BadRequestException('페이지 커서가 현재 결과 집합에 속하지 않습니다.');
  const start = cursor ? cursorIndex + 1 : 0;
  return pageRows(rows.slice(start, start + query.limit + 1), query.limit, (row) => row, sortValue);
}
