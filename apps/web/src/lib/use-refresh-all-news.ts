import { hashKey, useQueryClient, type InfiniteData, type QueryKey } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

type CursorPage = { nextCursor?: string | null };

/** Refreshes the existing news cache from its first page through its final stored cursor. */
export function useRefreshAllNews<Page extends CursorPage>({
  queryKey,
  fetchPage,
  enabled = true,
}: {
  queryKey: QueryKey;
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page>;
  enabled?: boolean;
}) {
  const client = useQueryClient();
  const scope = hashKey(queryKey);
  const current = useRef({ scope, queryKey, fetchPage, enabled });
  current.current = { scope, queryKey, fetchPage, enabled };
  const active = useRef<{ scope: string; controller: AbortController } | null>(null);
  const [state, setState] = useState<{
    scope: string;
    isRefreshing: boolean;
    error: Error | null;
  }>({ scope, isRefreshing: false, error: null });

  useEffect(() => {
    setState({ scope, isRefreshing: false, error: null });
    return () => {
      active.current?.controller.abort();
      active.current = null;
    };
  }, [scope, enabled]);

  const refreshAll = useCallback(async () => {
    const config = current.current;
    if (!config.enabled || config.scope !== scope || active.current?.scope === scope) return;
    active.current?.controller.abort();
    const operation = { scope, controller: new AbortController() };
    active.current = operation;
    const { signal } = operation.controller;
    const cancelled = () =>
      signal.aborted || current.current.scope !== scope || !current.current.enabled;
    setState({ scope, isRefreshing: true, error: null });
    try {
      await client.cancelQueries({ queryKey: config.queryKey, exact: true });
      const pages: Page[] = [];
      const pageParams: Array<string | null> = [];
      const seen = new Set<string | null>();
      let cursor: string | null = null;
      while (!cancelled()) {
        if (seen.has(cursor)) throw new Error('뉴스 페이지가 반복되어 조회를 중단했습니다.');
        seen.add(cursor);
        const page = await config.fetchPage(cursor, signal);
        if (cancelled()) return;
        pages.push(page);
        pageParams.push(cursor);
        client.setQueryData<InfiniteData<Page, string | null>>(config.queryKey, {
          pages: [...pages],
          pageParams: [...pageParams],
        });
        cursor = page.nextCursor ?? null;
        if (cursor === null) break;
      }
    } catch (error) {
      if (!cancelled()) {
        setState({
          scope,
          isRefreshing: false,
          error: error instanceof Error ? error : new Error('뉴스를 불러오지 못했습니다.'),
        });
      }
    } finally {
      if (active.current === operation) {
        active.current = null;
        setState((previous) =>
          previous.scope === scope ? { ...previous, isRefreshing: false } : previous,
        );
      }
    }
  }, [client, scope]);

  return {
    refreshAll,
    isRefreshing: enabled && state.scope === scope && state.isRefreshing,
    error: enabled && state.scope === scope ? state.error : null,
  };
}
