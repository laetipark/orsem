import { financialNumber } from '../lib/company-fields';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Search } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { companyPath } from '../lib/company-path';
import { formatDate, formatMoney, formatPercent } from '../lib/format';
import { CompanyAvatar } from '../components/company-avatar';
import { SearchInput } from '../components/search-input';
import { RegionTabs, parseRegion } from '../components/region-tabs';
import { Button, EmptyState, ErrorState, LoadingState } from '../components/ui';
import './companies-page.css';

export function CompaniesPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '',
    region = parseRegion(params.get('region'));
  const cursor = params.get('cursor');
  const [input, setInput] = useState(q);
  useEffect(() => setInput(q), [q]);
  const query = useQuery({
    queryKey: ['companies', q, region, cursor],
    queryFn: ({ signal }) => api.companies(q, region, cursor, signal),
  });
  return (
    <div className="page-stack companies-page">
      <div className="page-lead companies-page__lead">
        <p>주식과 ETF를 찾고, 가격과 새로운 소식을 확인하세요.</p>
        <Link className="text-link" to="/watchlist">
          내 관심 종목 <ArrowRight size={15} />
        </Link>
      </div>
      <section className="companies-directory" aria-label="종목 목록">
        <div className="companies-directory__tools">
          <RegionTabs />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setParams((current) => {
                const next = new URLSearchParams(current);
                next.set('q', input.trim());
                next.delete('cursor');
                return next;
              });
            }}
          >
            <SearchInput
              value={input}
              onChange={setInput}
              label="종목 검색"
              placeholder="종목명, 종목번호 또는 티커"
              filters={{ kind: 'companies', region }}
              onSelect={(item) => {
                if (item.type === 'COMPANY') void navigate(item.url);
              }}
            />
            <Button type="submit" variant="secondary">
              <Search size={16} />
              <span>검색</span>
            </Button>
          </form>
        </div>
        <div className="companies-directory__caption">
          <span>{q ? `‘${q}’ 검색 결과` : '상장 종목 · 이름순'}</span>
          <small>종목별 최근 거래일 종가 · 토스증권</small>
        </div>
        {query.isPending ? (
          <LoadingState label="종목을 불러오고 있습니다." />
        ) : query.isError ? (
          <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
        ) : query.data.items.length ? (
          <>
            <div className="companies-directory__table">
              <table>
                <thead>
                  <tr>
                    <th scope="col">종목</th>
                    <th scope="col">최근 종가</th>
                    <th scope="col">등락률</th>
                    <th scope="col">거래량</th>
                    <th scope="col">시가총액</th>
                    <th scope="col">시세 기준일</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((company) => {
                    const quote = company.quote;
                    return (
                      <tr key={company.id}>
                        <th scope="row">
                          <Link to={companyPath(company)} className="companies-directory__identity">
                            <CompanyAvatar company={company} />
                            <span>
                              <strong>{company.nameKo || company.nameEn}</strong>
                              <small>
                                {company.stockCode || company.ticker || '코드 확인 대기'} ·{' '}
                                {company.market}
                              </small>
                            </span>
                          </Link>
                        </th>
                        <td>
                          {quote?.price && quote.currency ? (
                            formatMoney(quote.price, quote.currency)
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td
                          className={
                            (quote?.changePercent ?? 0) > 0
                              ? 'positive'
                              : (quote?.changePercent ?? 0) < 0
                                ? 'negative'
                                : ''
                          }
                          title={
                            quote?.referenceDate
                              ? `${formatDate(quote.referenceDate)} 종가 대비`
                              : '비교 종가 확인 대기'
                          }
                        >
                          {formatPercent(quote?.changePercent)}
                        </td>
                        <td>
                          {quote?.volume != null ? `${financialNumber(quote.volume)}주` : '—'}
                        </td>
                        <td
                          title={
                            quote?.capBasisDate
                              ? `${formatDate(quote.capBasisDate)} 금융위원회 자료`
                              : '공식 시총 자료 연결 대기'
                          }
                        >
                          {quote?.marketCap
                            ? `${financialNumber(quote.marketCap, true)}${['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'].includes(company.market) ? '원' : ' USD'}`
                            : '—'}
                        </td>
                        <td>{quote?.basisDate ? formatDate(quote.basisDate) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="companies-directory__pagination">
              <span>공식 시총 자료는 확인된 종목부터 표시합니다.</span>
              {cursor ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setParams((current) => {
                      const next = new URLSearchParams(current);
                      next.delete('cursor');
                      return next;
                    })
                  }
                >
                  처음으로
                </Button>
              ) : null}
              {query.data.nextCursor ? (
                <Button
                  variant="secondary"
                  onClick={() =>
                    setParams((current) => {
                      const next = new URLSearchParams(current);
                      next.set('cursor', query.data.nextCursor!);
                      return next;
                    })
                  }
                >
                  다음 <ArrowRight size={14} />
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            title="검색된 종목이 없습니다"
            description="기업명이나 종목번호, 티커를 바꿔 검색해 보세요."
          />
        )}
      </section>
    </div>
  );
}
