import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { companyPath } from '../lib/company-path';
import { formatDate, formatKst, formatMoney, formatPercent } from '../lib/format';
import type { RecentCompany } from '../lib/recent-companies';
import { recentCompanyPrice } from '../lib/recent-company-quotes';
import { CompanyAvatar } from './company-avatar';
import { Button, EmptyState } from './ui';

export function RecentStocks({
  actor,
  companies,
  view,
  visible,
  pageSize,
}: {
  actor: string;
  companies: readonly RecentCompany[];
  view: 'grid' | 'list';
  visible: boolean;
  pageSize: number;
}) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const ids = companies.map((company) => company.id);
  const query = useQuery({
    queryKey: ['company-quotes', actor, ids],
    queryFn: ({ signal }) => api.companyQuotes(ids, signal),
    enabled: Boolean(actor) && visible && ids.length > 0,
    refetchInterval: visible && ids.length > 0 ? 60_000 : false,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });
  const totalPages = Math.max(1, Math.ceil(companies.length / pageSize));
  const page = Math.min(
    totalPages - 1,
    Math.max(0, Math.floor(Number(params.get('watchPage')) || 0)),
  );
  const offset = page * pageSize;
  const changePage = (nextPage: number) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('watchPage', String(nextPage));
        return next;
      },
      { replace: true },
    );
  if (!companies.length)
    return (
      <EmptyState
        title="최근 조회한 종목이 없습니다"
        description="종목 상세를 열면 최근 20종목이 이곳에 모입니다."
      />
    );
  return (
    <>
      <p className="watch-recent__note">이 브라우저에서 최근 조회한 20종목 · 최신순</p>
      {query.isError ? (
        <p className="watch-recent__note" role="alert">
          시세를 갱신하지 못했습니다.{' '}
          <button className="text-link" onClick={() => void query.refetch()}>
            다시 불러오기
          </button>
        </p>
      ) : null}
      <div className={`watch-groups__stocks watch-groups__stocks--${view} watch-recent`}>
        {companies.slice(offset, offset + pageSize).map((company) => {
          const price =
            (!query.isError
              ? query.data?.items.find((item) => item.companyId === company.id)?.displayPrice
              : undefined) ?? recentCompanyPrice(undefined, company.market, query.isError);
          return (
            <Link
              key={company.id}
              className="watch-group-stock watch-recent__stock"
              to={companyPath(company)}
              state={{ watchlistReturn: location.pathname + location.search }}
              aria-label={`${company.nameKo} 종목 상세`}
            >
              <div className="watch-group-stock__company">
                <CompanyAvatar company={company} />
                <span>
                  <strong>{company.nameKo}</strong>
                  <small>
                    {company.stockCode ?? company.ticker} · {company.market}
                  </small>
                </span>
              </div>
              <div className="watch-group-stock__quote">
                <strong>
                  {price.price === null ? '—' : formatMoney(price.price, price.currency)}
                </strong>
                <span className="watch-group-stock__basis">
                  {price.sessionDate ? `${formatDate(price.sessionDate)} ` : ''}
                  {
                    {
                      LIVE: '실시간',
                      STALE: '최근 체결',
                      CLOSE: '종가',
                      NONE: query.isPending ? '시세 조회 중' : '시세 대기',
                    }[price.basis]
                  }
                </span>
                <div
                  className="watch-group-stock__change"
                  data-direction={
                    price.changePercent == null || price.changePercent === 0
                      ? 'flat'
                      : price.changePercent > 0
                        ? 'up'
                        : 'down'
                  }
                >
                  <b>
                    {price.change == null
                      ? '—'
                      : `${price.change > 0 ? '+' : ''}${formatMoney(price.change, price.currency)}`}
                  </b>
                  <b>{formatPercent(price.changePercent)}</b>
                </div>
              </div>
              <time className="watch-recent__viewed" dateTime={company.viewedAt}>
                조회 {formatKst(company.viewedAt)}
              </time>
            </Link>
          );
        })}
      </div>
      <footer className="watch-groups__pagination observation-card__pagination">
        <small>
          {offset + 1}–{Math.min(offset + pageSize, companies.length)} / {companies.length}종목
        </small>
        {totalPages > 1 ? (
          <div role="group" aria-label="최근조회 페이지">
            <Button
              size="sm"
              variant="ghost"
              disabled={page === 0}
              onClick={() => changePage(page - 1)}
            >
              이전
            </Button>
            <span aria-live="polite">
              {page + 1} / {totalPages}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={page + 1 >= totalPages}
              onClick={() => changePage(page + 1)}
            >
              다음
            </Button>
          </div>
        ) : null}
      </footer>
    </>
  );
}
