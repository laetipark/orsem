import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronDown, Search, Settings2, Star, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { RegionTabs, useRegion } from '../components/region-tabs';
import { formatKst, formatMoney, formatPercent } from '../lib/format';
import { priorityLabels } from '../lib/domain-labels';
import type { CompanySummary, Priority, Session, WatchlistItem, WatchlistQuote } from '../types';
import { PriorityBadge } from '../components/domain-badges';
import { CompanyAvatar } from '../components/company-avatar';
import { ObservationDisclaimer } from '../components/disclaimer';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../components/ui';
import './watchlist-page.css';

export function WatchlistContent({
  items,
  onRemove,
  onUpdate,
  busyId,
  readOnly = false,
  quotes = [],
}: {
  items: WatchlistItem[];
  onRemove: (id: string) => void;
  onUpdate: (
    id: string,
    patch: Partial<Pick<WatchlistItem, 'priority' | 'realtimeAlerts' | 'digestAlerts'>>,
  ) => void;
  busyId: string | null;
  readOnly?: boolean;
  quotes?: WatchlistQuote[];
}) {
  if (!items.length) {
    return (
      <EmptyState
        title="아직 관심기업이 없습니다"
        description={
          readOnly
            ? '관리자가 관심기업을 등록하면 이곳에서 확인할 수 있습니다. 위 검색으로 기업 정보를 먼저 찾아볼 수 있습니다.'
            : '기업명이나 종목코드로 찾아 추가하면 공시·뉴스 우선순위 큐를 한곳에서 관측할 수 있습니다. 추가 자체는 투자 판단이나 자동 주문을 만들지 않습니다.'
        }
      />
    );
  }
  return (
    <div className="watchlist-grid">
      {items.map((item) => {
        const price = quotes.find((quote) => quote.companyId === item.id);
        const changePercent =
          price?.changePercent != null && Number.isFinite(Number(price.changePercent))
            ? Number(price.changePercent)
            : null;
        return (
          <article className="watchlist-card" key={item.id}>
            <div className="watchlist-card__head">
              <CompanyAvatar company={item} className="watchlist-card__icon" />
              <div>
                <strong>{item.nameKo}</strong>
                <span>{item.nameEn}</span>
              </div>
            </div>
            <div className="watchlist-card__meta">
              <span>{item.market}</span>
              <code>{item.stockCode ?? item.ticker}</code>
              {item.priority ? <PriorityBadge priority={item.priority} /> : null}
            </div>
            <div className="watchlist-card__price">
              <span className="watchlist-card__price-label">현재가</span>
              <strong>
                {price?.quote ? formatMoney(price.quote.price, price.quote.currency) : '—'}
              </strong>
              <div
                className="watchlist-card__change"
                data-direction={
                  changePercent === null || changePercent === 0
                    ? 'flat'
                    : changePercent > 0
                      ? 'up'
                      : 'down'
                }
              >
                <b>{formatPercent(changePercent)}</b>
                <span>
                  {price?.referenceDate
                    ? `전일 종가 대비 · ${price.referenceDate}`
                    : '비교 기준 없음'}
                </span>
              </div>
              <span className="watchlist-card__quote-time">
                {price?.quote ? formatKst(price.quote.providerAt) : '아직 수집된 시세가 없습니다'}
                {price?.status === 'STALE' ? ' · 지연된 시세' : null}
                {price?.status === 'NOT_CONFIGURED' ? ' · 연결 미설정' : null}
                {price?.status === 'UNAVAILABLE' ? ' · 시세 이용 불가' : null}
              </span>
            </div>
            <p>{item.note || `${item.sector} · 공시와 공식 원문 중심으로 관측 중`}</p>
            {!readOnly ? (
              <details className="watchlist-card__settings">
                <summary>
                  <Settings2 size={14} /> 관리 설정 <ChevronDown size={14} />
                </summary>
                <div className="watchlist-card__policy">
                  <label>
                    우선순위
                    <Select
                      value={item.priority ?? 'P2'}
                      disabled={busyId === item.id}
                      onChange={(event) =>
                        onUpdate(item.id, { priority: event.target.value as Priority })
                      }
                      aria-label={`${item.nameKo} 알림 우선순위`}
                    >
                      <option value="P1">{priorityLabels.P1}</option>
                      <option value="P2">{priorityLabels.P2}</option>
                    </Select>
                  </label>
                  <label className="check-control">
                    <input
                      type="checkbox"
                      checked={item.realtimeAlerts}
                      disabled={busyId === item.id}
                      onChange={(event) =>
                        onUpdate(item.id, { realtimeAlerts: event.target.checked })
                      }
                    />
                    실시간 외부 알림
                  </label>
                  <label className="check-control">
                    <input
                      type="checkbox"
                      checked={item.digestAlerts}
                      disabled={busyId === item.id}
                      onChange={(event) =>
                        onUpdate(item.id, { digestAlerts: event.target.checked })
                      }
                    />
                    요약 알림
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(item.id)}
                    disabled={busyId === item.id}
                    aria-label={`${item.nameKo} 관심기업에서 제거`}
                  >
                    <Trash2 size={14} /> 관심기업에서 제거
                  </Button>
                </div>
              </details>
            ) : null}
            <div className="watchlist-card__foot">
              <span>최근 이벤트 {formatKst(item.lastEventAt)}</span>
              <Link to={`/companies/${item.id}`}>
                기업 보기 <ArrowRight size={14} />
              </Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function WatchlistPage() {
  const session = useOutletContext<Session | undefined>();
  const isAdmin = session?.user?.role === 'ADMIN';
  const { region } = useRegion();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('cursor');
  const cursorHistory = useRef(new Map<string, string | null>());
  function changePage(nextCursor: string | null) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (nextCursor) next.set('cursor', nextCursor);
      else next.delete('cursor');
      return next;
    });
  }
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newPriority, setNewPriority] = useState<'P1' | 'P2'>('P2');
  const [newRealtimeAlerts, setNewRealtimeAlerts] = useState(true);
  const [newDigestAlerts, setNewDigestAlerts] = useState(false);
  const queryClient = useQueryClient();
  const watchlist = useQuery({
    queryKey: ['watchlist', region, cursor],
    queryFn: () => api.watchlist(region, cursor),
  });
  const quoteIds = watchlist.data?.items.map((item) => item.id) ?? [];
  const quotes = useQuery({
    queryKey: ['watchlist-quotes', quoteIds],
    queryFn: () => api.watchlistQuotes(quoteIds),
    enabled: quoteIds.length > 0,
    refetchInterval: 60_000,
  });
  const search = useQuery({
    queryKey: ['companies', query, region],
    queryFn: () => api.companies(query, region),
    enabled: query.length > 0,
  });
  const add = useMutation({
    mutationFn: (companyId: string) =>
      api.addWatchlist({
        companyId,
        priority: newPriority,
        realtimeAlerts: newRealtimeAlerts,
        digestAlerts: newDigestAlerts,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
  const remove = useMutation({
    mutationFn: (companyId: string) => api.removeWatchlist(companyId),
    onMutate: (companyId) => setBusyId(companyId),
    onSettled: async () => {
      setBusyId(null);
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
  const update = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<Pick<WatchlistItem, 'priority' | 'realtimeAlerts' | 'digestAlerts'>>;
    }) => api.updateWatchlist(id, patch),
    onMutate: ({ id }) => setBusyId(id),
    onSettled: async () => {
      setBusyId(null);
      await queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setQuery(input.trim());
  }

  const existingIds = new Set(watchlist.data?.items.map((item) => item.id) ?? []);

  return (
    <div className="page-stack">
      <div className="page-lead">
        <div>
          <p>
            {isAdmin
              ? '직접 관련 기업만 좁게 관리합니다. 시장 전체 공시는 이벤트 탐색에서 계속 수집됩니다.'
              : '관리자가 등록한 관심기업을 조회합니다. 기업 검색으로 다른 기업의 관측 정보도 확인할 수 있습니다.'}
          </p>
        </div>
      </div>
      <RegionTabs onChange={() => cursorHistory.current.clear()} />
      <Card className="watchlist-search-card">
        <CardHeader>
          <div>
            <span className="section-kicker">COMPANIES</span>
            <h2>{isAdmin ? '관심기업 찾기' : '기업 찾기'}</h2>
          </div>
        </CardHeader>
        <CardContent>
          <form className="company-search" onSubmit={submit}>
            <label>
              <Search size={17} />
              <Input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="삼성전자 · 005930 · MSFT"
                aria-label="관심기업 검색"
              />
            </label>
            <Button type="submit" disabled={!input.trim()}>
              <Search size={16} /> 검색
            </Button>
          </form>
          {isAdmin ? (
            <div className="watchlist-add-policy" aria-label="새 관심기업 알림 정책">
              <label>
                추가 우선순위
                <Select
                  value={newPriority}
                  onChange={(event) => setNewPriority(event.target.value as 'P1' | 'P2')}
                >
                  <option value="P1">{priorityLabels.P1}</option>
                  <option value="P2">{priorityLabels.P2}</option>
                </Select>
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={newRealtimeAlerts}
                  onChange={(event) => setNewRealtimeAlerts(event.target.checked)}
                />
                외부 실시간 알림
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={newDigestAlerts}
                  onChange={(event) => setNewDigestAlerts(event.target.checked)}
                />
                요약 알림
              </label>
            </div>
          ) : null}
          {search.isFetching ? (
            <p className="search-hint">기업 마스터를 검색하는 중입니다…</p>
          ) : null}
          {search.data ? (
            <div className="company-results">
              {search.data.items.length ? (
                search.data.items.map((company: CompanySummary) => (
                  <div className="company-result" key={company.id}>
                    <div>
                      <strong>{company.nameKo}</strong>
                      <span>
                        {company.market} · <code>{company.stockCode ?? company.ticker}</code> ·{' '}
                        {company.sector}
                      </span>
                    </div>
                    {company.priority ? (
                      <PriorityBadge priority={company.priority} />
                    ) : (
                      <Badge>우선순위 없음</Badge>
                    )}
                    {isAdmin ? (
                      <Button
                        size="sm"
                        variant={existingIds.has(company.id) ? 'secondary' : 'primary'}
                        disabled={existingIds.has(company.id) || add.isPending}
                        onClick={() => add.mutate(company.id)}
                      >
                        <Star size={15} /> {existingIds.has(company.id) ? '추가됨' : '관심 추가'}
                      </Button>
                    ) : (
                      <Link className="text-link" to={`/companies/${company.id}`}>
                        기업 보기 <ArrowRight size={14} />
                      </Link>
                    )}
                  </div>
                ))
              ) : (
                <p className="search-hint">일치하는 기업을 찾지 못했습니다.</p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <span className="section-kicker">WATCHLIST</span>
            <h2>관심기업</h2>
          </div>
        </CardHeader>
        <CardContent>
          {watchlist.isPending ? <LoadingState label="관심기업을 불러오는 중입니다." /> : null}
          {watchlist.isError ? (
            <ErrorState
              message={watchlist.error.message}
              onRetry={() => void watchlist.refetch()}
            />
          ) : null}
          {quotes.isError ? (
            <p className="form-error" role="status">
              시세를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.
            </p>
          ) : null}
          {watchlist.data ? (
            <WatchlistContent
              items={watchlist.data.items}
              onRemove={(id) => remove.mutate(id)}
              onUpdate={(id, patch) => update.mutate({ id, patch })}
              busyId={busyId}
              readOnly={!isAdmin}
              quotes={quotes.data?.items}
            />
          ) : null}
        </CardContent>
      </Card>
      {watchlist.data ? (
        <div className="cursor-pagination">
          <Button
            variant="secondary"
            size="sm"
            disabled={!cursor}
            onClick={() => {
              changePage(cursor ? (cursorHistory.current.get(cursor) ?? null) : null);
            }}
          >
            <ArrowLeft size={15} /> 이전
          </Button>
          <span>현재 조회 {watchlist.data.items.length}곳</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={!watchlist.data.nextCursor}
            onClick={() => {
              if (watchlist.data.nextCursor)
                cursorHistory.current.set(watchlist.data.nextCursor, cursor);
              changePage(watchlist.data.nextCursor);
            }}
          >
            다음 <ArrowRight size={15} />
          </Button>
        </div>
      ) : null}
      <ObservationDisclaimer compact />
    </div>
  );
}
