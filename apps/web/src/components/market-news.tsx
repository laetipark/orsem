import { NaverHighlightedText } from './naver-highlighted-text';
import { companyRegion } from '@orsem/contracts';
import { useEffect, useId, useState } from 'react';
import { newsItems } from '../lib/news-feed';
import { companyPath } from '../lib/company-path';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronRight, Newspaper } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import type { SourceFreshness, SourceItem } from '../types';
import { Card, CardHeader, EmptyState, ErrorState, LoadingState } from './ui';
import './market-news.css';

export const NEWS_REFRESH_INTERVAL = 60_000;

const statusLabels: Record<SourceFreshness['status'], string> = {
  HEALTHY: '정상',
  DEGRADED: '수집 지연',
  DISABLED: '수집 비활성',
  UNCONFIGURED: '수집 미설정',
  FAILED: '수집 오류',
};

const newsStatusPriority: SourceFreshness['status'][] = [
  'FAILED',
  'DEGRADED',
  'HEALTHY',
  'UNCONFIGURED',
  'DISABLED',
];

export function summarizeNewsFreshness(items: SourceFreshness[]) {
  const sources = items.filter((item) => {
    const id = item.id.toLowerCase();
    return id === 'ir' || id === 'news_rss' || id.startsWith('news_rss:');
  });
  const latest = sources.reduce<string | null>(
    (value, item) =>
      !item.lastSuccessAt || (value && value >= item.lastSuccessAt) ? value : item.lastSuccessAt,
    null,
  );
  const status = newsStatusPriority.find((candidate) =>
    sources.some((item) => item.status === candidate),
  );
  return { latest, sources, status: status ?? null };
}

export function safeNewsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const regionLabels: Record<NonNullable<SourceItem['marketRegion']>, string> = {
  kr: '국내',
  us: '미국',
  global: '글로벌',
  unknown: '지역 미확인',
};

export interface NewsProviderFreshness {
  fetchedAt: string | null;
  status: string;
  nextRequestAt?: string | null;
  reason?: string | null;
}

export function MarketNewsFreshness({
  naver,
  providerOnly = false,
}: {
  naver?: NewsProviderFreshness | null;
  providerOnly?: boolean;
}) {
  const freshness = useQuery({
    queryKey: ['source-freshness'],
    queryFn: api.sourceFreshness,
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
    enabled: !providerOnly,
  });
  const { latest, status } = summarizeNewsFreshness(freshness.data?.items ?? []);
  return (
    <div className="market-news__freshness">
      <span>{providerOnly ? '네이버 관련 뉴스 검색' : '공식 소스 · 네이버 뉴스 순환 검색'}</span>
      {!providerOnly && status ? (
        <>
          <span className={`market-news__status market-news__status--${status.toLowerCase()}`}>
            {statusLabels[status]}
          </span>
          <span>{latest ? `마지막 수집 ${formatKst(latest)}` : '수집 기록 없음'}</span>
        </>
      ) : null}
      {naver ? (
        <>
          <span>
            네이버{' '}
            {(
              {
                AVAILABLE: '정상',
                PENDING: '검색 대기',
                UNCONFIGURED: '미설정',
                UNAVAILABLE: '연결 지연',
                LIMIT_REACHED: '한도 소진',
                EXHAUSTED: '한도 소진',
                BUDGET_EXHAUSTED: '한도 소진',
                DISABLED: '비활성',
              } as Record<string, string>
            )[naver.status] ?? naver.status}
          </span>
          {naver.fetchedAt ? <span>최근 검색 {formatKst(naver.fetchedAt)}</span> : null}
          {naver.nextRequestAt ? <span>다음 확인 {formatKst(naver.nextRequestAt)}</span> : null}
          {naver.reason ? <span>{naver.reason}</span> : null}
        </>
      ) : null}
      {!providerOnly && freshness.isError ? <span>수집 상태를 확인하지 못했습니다.</span> : null}
    </div>
  );
}

export type NewsListItem = Pick<SourceItem, 'id' | 'title' | 'url' | 'source'> &
  Partial<SourceItem>;

function newsSourceLinks(item: NewsListItem) {
  const seen = new Set<string>();
  return (item.sources ?? []).flatMap((source) => {
    const url = safeNewsUrl(source.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ ...source, url }];
  });
}

function translatedMetadata(item: NewsListItem) {
  return !item.source.startsWith('NAVER') &&
    item.rightsMode !== 'STORE_METADATA_ONLY' &&
    item.rightsMode !== 'LINK_ONLY'
    ? item.translation
    : null;
}

/** Presentation never replaces the actual headline with a generated summary. */
export function newsHeadline(item: NewsListItem): string {
  return translatedMetadata(item)?.title?.trim() || item.title;
}

export function newsDescription(item: NewsListItem): string {
  if (
    item.rightsMode === 'STORE_METADATA_ONLY' ||
    (item.rightsMode === 'LINK_ONLY' && !item.source.startsWith('NAVER'))
  )
    return '요약 미제공';
  return (
    (translatedMetadata(item)?.description?.trim() || item.description)?.trim() || '요약 미제공'
  );
}

export function NewsCompanyBadges({
  companies = [],
}: {
  companies?: SourceItem['relatedCompanies'];
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const unique = [
    ...new Map(
      companies
        .filter((company) => {
          const region = companyRegion(company.market);
          return region === 'kr'
            ? /^[0-9A-Z]{6}$/u.test(company.stockCode ?? '')
            : region === 'us' && /^[A-Z][A-Z0-9.-]{0,14}$/u.test(company.ticker ?? '');
        })
        .map((company) => [company.id, company]),
    ).values(),
  ];
  if (!unique.length) return null;
  const count = mobile ? 1 : 2;
  const hidden = unique.length - count;
  const link = (company: (typeof unique)[number]) => (
    <Link
      key={company.id}
      to={companyPath(company)}
      title={`${company.nameKo || company.nameEn} · ${company.stockCode || company.ticker || company.market}`}
    >
      {company.nameKo || company.nameEn || company.ticker || company.stockCode}
    </Link>
  );
  return (
    <div className="news-company-badges" aria-label="관련 종목">
      {unique.slice(0, count).map(link)}
      {hidden > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={expanded ? '관련 종목 접기' : `관련 종목 ${hidden}개 더 보기`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '접기' : `+${hidden}`}
          </button>
          {expanded ? (
            <div className="news-company-badges__more" id={id}>
              {unique.slice(count).map(link)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NewsCopy({ item }: { item: NewsListItem }) {
  const naver = item.source.startsWith('NAVER');
  const title = newsHeadline(item),
    description = newsDescription(item);
  const translation = translatedMetadata(item);
  const pendingLabel =
    item.translationStatus === 'FAILED'
      ? '원문 · 번역 실패'
      : item.translationStatus === 'UNAVAILABLE'
        ? '원문 · 번역 미제공'
        : item.translationStatus === 'PENDING'
          ? '원문 · 번역 대기'
          : '원문';
  return (
    <span className="market-news__copy">
      <strong
        lang={translation ? 'ko' : undefined}
        className="market-news__headline"
        title={naver ? undefined : title}
      >
        {naver ? <NaverHighlightedText value={title} /> : title}
      </strong>
      <span
        lang={translation?.description ? 'ko' : undefined}
        className="market-news__description"
        title={naver ? undefined : description}
      >
        {naver ? <NaverHighlightedText value={description} /> : description}
      </span>
      <span className="market-news__meta">
        <span className="market-news__publisher">{item.sourceName || '뉴스 출처'}</span>
        {item.marketRegion ? <span>{regionLabels[item.marketRegion]}</span> : null}
        {translation ? <span>{translation.editedAt ? '번역 수정본' : '자동 번역'}</span> : null}
        {!translation &&
        !naver &&
        (item.contentLanguage === 'en' ||
          item.translationStatus === 'PENDING' ||
          item.translationStatus === 'FAILED') ? (
          <span>{pendingLabel}</span>
        ) : null}
        {item.publishedAt ? (
          <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
        ) : (
          <>
            <span>발행시각 미제공</span>
            {item.firstObservedAt ? (
              <time dateTime={item.firstObservedAt}>
                최초 확인 {formatKst(item.firstObservedAt)}
              </time>
            ) : null}
          </>
        )}
        {item.collectedAt ? <span>수집 {formatKst(item.collectedAt)}</span> : null}
        {(item.sourceCount ?? 1) > 1 ? <span>{item.sourceCount}개 출처에서 확인</span> : null}
      </span>
    </span>
  );
}

export function MarketNewsList({
  items,
  headlineOnly = false,
}: {
  items: NewsListItem[];
  headlineOnly?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <ul className="market-news__list">
      {items
        .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
        .map((item) => {
          const itemUrl = safeNewsUrl(item.url);
          const sources = newsSourceLinks(item);
          const hasAdditionalSources = sources.some((source) => source.url !== itemUrl);
          return (
            <li className="market-news__item" key={item.articleId ?? item.id}>
              <div className="market-news__row">
                {itemUrl ? (
                  <a
                    className="market-news__link"
                    href={itemUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <NewsCopy item={item} />
                    <ArrowUpRight size={16} aria-hidden="true" />
                    <span className="sr-only">원문 새 창에서 보기</span>
                  </a>
                ) : (
                  <div className="market-news__link market-news__link--unavailable">
                    <NewsCopy item={item} />
                    <span className="sr-only">안전한 원문 링크가 없습니다.</span>
                  </div>
                )}
                <NewsCompanyBadges companies={item.relatedCompanies} />
              </div>
              {item.source === 'GDELT' ? (
                <div className="market-news__credit">
                  <a href="https://www.gdeltproject.org/" target="_blank" rel="noopener noreferrer">
                    데이터 제공 GDELT<span className="sr-only"> 새 창에서 보기</span>
                  </a>
                </div>
              ) : null}
              {!headlineOnly && hasAdditionalSources ? (
                <details className="market-news__sources">
                  <summary>연결된 원문 출처 {sources.length}개</summary>
                  <ul>
                    {sources.map((source) => (
                      <li key={`${source.id}:${source.url}`}>
                        <a href={source.url} target="_blank" rel="noopener noreferrer">
                          {source.sourceName || source.source}
                          <ArrowUpRight size={13} aria-hidden="true" />
                          <span className="sr-only">새 창에서 보기</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </li>
          );
        })}
    </ul>
  );
}

export function MarketNewsEmpty() {
  return (
    <EmptyState
      title="아직 수집된 시장 뉴스가 없습니다"
      description="공식 소스와 네이버 검색에서 확인된 제목·요약을 표시하고 기사 원문으로 연결합니다."
    />
  );
}

export function DashboardNews() {
  const news = useQuery({
    queryKey: ['news', 'market', 'latest', 6],
    queryFn: ({ signal }) => api.news({ limit: 6, scope: 'market' }, signal),
    refetchInterval: NEWS_REFRESH_INTERVAL,
    staleTime: 30_000,
  });

  return (
    <Card className="market-news market-news--compact" aria-labelledby="dashboard-news-title">
      <CardHeader>
        <div className="market-news__heading">
          <h2 id="dashboard-news-title">
            <Newspaper size={19} aria-hidden="true" /> 시장 뉴스
          </h2>
          <div className="market-news__heading-meta">
            <span className="market-news__scope">증시 · 금리 · 환율</span>
            <MarketNewsFreshness naver={news.data?.naver} />
          </div>
        </div>
        <Link className="text-link" to="/news?scope=market">
          전체 보기 <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </CardHeader>
      {news.isPending ? <LoadingState label="시장 뉴스를 불러오는 중입니다." /> : null}
      {news.isError ? (
        <ErrorState
          message={
            news.data ? '새 목록을 불러오지 못해 이전 뉴스를 표시합니다.' : news.error.message
          }
          onRetry={() => void news.refetch()}
        />
      ) : null}
      {news.data && newsItems([news.data]).length ? (
        <MarketNewsList items={newsItems([news.data], 6)} headlineOnly />
      ) : null}
      {news.data && !newsItems([news.data]).length && !news.isError ? <MarketNewsEmpty /> : null}
    </Card>
  );
}
