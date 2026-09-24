import { NaverHighlightedText } from './naver-highlighted-text';
import { companyRegion } from '@orsem/contracts';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { chronologicalNewsItems } from '../lib/news-feed';
import { companyPath } from '../lib/company-path';
import { useMouseDragScroll } from '../lib/use-mouse-drag-scroll';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, ChevronRight, Newspaper } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate, formatKst } from '../lib/format';
import type { SourceFreshness, SourceItem } from '../types';
import { Badge, Card, CardHeader, EmptyState, ErrorState, LoadingState } from './ui';
import { NewsPreviewDialog } from './news-preview-dialog';
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
                PARTIAL: '일부 검색 대기',
                PENDING: '검색 대기',
                UNCONFIGURED: '미설정',
                UNAVAILABLE: '연결 지연',
                LIMIT_REACHED: '한도 소진',
                PAUSED: '검색 중단',
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
    !item.summaryAllowed &&
    (item.rightsMode === 'STORE_METADATA_ONLY' ||
      (item.rightsMode === 'LINK_ONLY' && !item.source.startsWith('NAVER')))
  )
    return '요약 미제공';
  return (
    (translatedMetadata(item)?.description?.trim() || item.description)?.trim() || '요약 미제공'
  );
}

export function NewsCompanyBadges({
  companies = [],
  external = false,
  scroll = false,
}: {
  companies?: SourceItem['relatedCompanies'];
  external?: boolean;
  scroll?: boolean;
}) {
  const drag = useMouseDragScroll();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const measurements = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(2);
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
  const signature = unique
    .map((company) => `${company.id}:${company.nameKo}:${company.nameEn}`)
    .join('|');
  useLayoutEffect(() => {
    const element = container.current;
    const measure = measurements.current;
    if (!element || !measure || scroll) return;
    const fit = () => {
      const width = element.clientWidth;
      if (!width) {
        setVisibleCount(mobile ? 1 : 2);
        return;
      }
      const widths = Array.from(measure.children).map((node) => node.getBoundingClientRect().width);
      const moreWidth = widths.pop() ?? 36;
      if (widths.reduce((sum, value) => sum + value + 4, -4) <= width) {
        setVisibleCount(widths.length);
        return;
      }
      let used = moreWidth;
      let count = 0;
      for (const value of widths) {
        if (used + value + 4 > width) break;
        used += value + 4;
        count++;
      }
      setVisibleCount(count);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [signature, mobile, scroll]);
  if (!unique.length) return null;
  const count = Math.min(visibleCount, unique.length);
  const hidden = unique.length - count;
  const link = (company: (typeof unique)[number]) => (
    <Link
      key={company.id}
      to={companyPath(company)}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      title={`${company.nameKo || company.nameEn} · ${company.stockCode || company.ticker || company.market}`}
    >
      {company.nameKo || company.nameEn || company.ticker || company.stockCode}
    </Link>
  );
  return (
    <div
      ref={container}
      id={id}
      className={`news-company-badges${scroll ? ` news-company-badges--scroll mouse-drag-scroll${drag.dragging ? ' is-dragging' : ''}` : ''}`}
      aria-label="관련 종목"
      role={scroll ? 'region' : undefined}
      tabIndex={scroll ? 0 : undefined}
      data-mouse-scrollable={scroll ? drag.scrollable : undefined}
      {...(scroll ? drag.handlers : {})}
    >
      {!scroll ? (
        <div className="news-company-badges__measure" ref={measurements} aria-hidden="true">
          {unique.map((company) => (
            <span key={company.id}>
              {company.nameKo || company.nameEn || company.ticker || company.stockCode}
            </span>
          ))}
          <span>+{unique.length}</span>
        </div>
      ) : null}
      {(scroll || expanded ? unique : unique.slice(0, count)).map(link)}
      {!scroll && hidden > 0 ? (
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
        </>
      ) : null}
    </div>
  );
}

function NewsMetadata({ item }: { item: NewsListItem }) {
  const naver = item.source.startsWith('NAVER');
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
    <span className="market-news__meta">
      <span className="market-news__publisher">{item.sourceName || '뉴스 출처'}</span>
      {item.sourceKind ? (
        <Badge tone="teal">
          {
            {
              OFFICIAL_DISCLOSURE: '공식 공시',
              OFFICIAL_RELEASE: '공식',
              COMPANY_IR: '기업발표',
              PRESS_RELEASE: '보도자료',
              INDEPENDENT_MEDIA: '언론',
              AGGREGATOR: '집계API',
              UNKNOWN: '유형 미확인',
            }[item.sourceKind]
          }
        </Badge>
      ) : null}
      {item.officialVerification === 'CONFIRMED' ? (
        <Badge tone="teal">공식 자료 연결 확인</Badge>
      ) : item.officialVerification === 'LINKED' ? (
        <Badge>공식 관련자료 후보</Badge>
      ) : null}
      {item.marketRegion ? <Badge>{regionLabels[item.marketRegion]}</Badge> : null}
      {translation ? (
        <Badge tone="blue">{translation.editedAt ? '번역 수정본' : '자동 번역'}</Badge>
      ) : null}
      {!translation &&
      !naver &&
      (item.contentLanguage === 'en' ||
        item.translationStatus === 'PENDING' ||
        item.translationStatus === 'FAILED') ? (
        <Badge>{pendingLabel}</Badge>
      ) : null}
      {item.publishedAt ? (
        <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
      ) : (
        <>
          <span>발행시각 미제공</span>
          {item.firstObservedAt ? (
            <time dateTime={item.firstObservedAt}>최초 확인 {formatKst(item.firstObservedAt)}</time>
          ) : null}
        </>
      )}
      {item.collectedAt ? <span>수집 {formatKst(item.collectedAt)}</span> : null}
      {(item.providerCount ?? 1) > 1 ? <span>수집 경로 {item.providerCount}개</span> : null}
    </span>
  );
}

function NewsCopy({ item }: { item: NewsListItem }) {
  const naver = item.source.startsWith('NAVER');
  const title = newsHeadline(item);
  return (
    <span className="market-news__copy">
      <strong lang={translatedMetadata(item) ? 'ko' : undefined} className="market-news__headline">
        {naver ? <NaverHighlightedText value={title} /> : title}
      </strong>
      <span className="market-news__meta market-news__list-meta">
        <span className="market-news__publisher">{item.sourceName || '뉴스 출처'}</span>
        {item.publishedAt ? (
          <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time>
        ) : (
          <span>발행일 미제공</span>
        )}
      </span>
    </span>
  );
}

function NewsAdditionalSources({ item }: { item: NewsListItem }) {
  const itemUrl = safeNewsUrl(item.url);
  const sources = newsSourceLinks(item);
  const hasAdditionalSources = sources.some((source) => source.url !== itemUrl);
  return (
    <>
      {item.source === 'GDELT' ? (
        <div className="market-news__credit">
          <a href="https://www.gdeltproject.org/" target="_blank" rel="noopener noreferrer">
            데이터 제공 GDELT<span className="sr-only"> 새 창에서 보기</span>
          </a>
        </div>
      ) : null}
      {item.officialReferences?.some(
        (ref) => ref.status !== 'REJECTED' && safeNewsUrl(ref.url ?? ''),
      ) ? (
        <details className="market-news__sources">
          <summary>공식 관련 자료</summary>
          <ul>
            {item.officialReferences
              .filter((ref) => ref.status !== 'REJECTED' && safeNewsUrl(ref.url ?? ''))
              .map((ref) => (
                <li key={`${ref.kind}:${ref.id}`}>
                  <a href={safeNewsUrl(ref.url ?? '')!} target="_blank" rel="noopener noreferrer">
                    {ref.title ?? '공식 자료'} ·{' '}
                    {ref.status === 'CONFIRMED' ? '연결 확인' : '관련 후보'}
                    <ArrowUpRight size={13} aria-hidden="true" />
                  </a>
                </li>
              ))}
          </ul>
        </details>
      ) : null}
      {hasAdditionalSources ? (
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
    </>
  );
}

export function MarketNewsList({
  items,
  externalCompanies = false,
  companyDetail = false,
}: {
  items: NewsListItem[];
  headlineOnly?: boolean;
  externalCompanies?: boolean;
  companyDetail?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [selected, setSelected] = useState<NewsListItem | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const preview =
    selected &&
    items.find(
      (item) => item.id === selected.id && (!item.expiresAt || Date.parse(item.expiresAt) > now),
    );
  return (
    <>
      <ul className={`market-news__list${companyDetail ? ' market-news__list--company' : ''}`}>
        {items
          .filter((item) => !item.expiresAt || Date.parse(item.expiresAt) > now)
          .map((item) => {
            const itemUrl = safeNewsUrl(item.url);
            return (
              <li className="market-news__item" key={item.articleId ?? item.id}>
                <div className="market-news__row">
                  {itemUrl ? (
                    <a
                      className="market-news__link"
                      href={itemUrl}
                      aria-haspopup="dialog"
                      onClick={(event) => {
                        if (
                          event.button !== 0 ||
                          event.ctrlKey ||
                          event.metaKey ||
                          event.shiftKey ||
                          event.altKey
                        )
                          return;
                        event.preventDefault();
                        setSelected(item);
                      }}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <NewsCopy item={item} />
                      <ArrowUpRight size={16} aria-hidden="true" />
                      <span className="sr-only">기사 미리보기</span>
                    </a>
                  ) : (
                    <div className="market-news__link market-news__link--unavailable">
                      <NewsCopy item={item} />
                      <span className="sr-only">안전한 원문 링크가 없습니다.</span>
                    </div>
                  )}
                  <NewsCompanyBadges
                    companies={item.relatedCompanies}
                    external={externalCompanies}
                  />
                </div>
              </li>
            );
          })}
      </ul>
      {preview ? (
        <NewsPreviewDialog
          key={preview.id}
          title={newsHeadline(preview)}
          description={newsDescription(preview)}
          naver={preview.source.startsWith('NAVER')}
          url={safeNewsUrl(preview.url)}
          onClose={() => setSelected(null)}
        >
          <NewsMetadata item={preview} />
          <NewsCompanyBadges companies={preview.relatedCompanies} external={externalCompanies} />
          <NewsAdditionalSources item={preview} />
        </NewsPreviewDialog>
      ) : null}
    </>
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
    gcTime: 0,
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
      {news.data && chronologicalNewsItems([news.data]).length ? (
        <MarketNewsList items={chronologicalNewsItems([news.data], 6)} headlineOnly />
      ) : null}
      {news.data && !chronologicalNewsItems([news.data]).length && !news.isError ? (
        <MarketNewsEmpty />
      ) : null}
    </Card>
  );
}
