import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Languages, Newspaper } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/ui';
import { safeNewsUrl } from '../components/market-news';
import { api } from '../lib/api';
import { formatKst } from '../lib/format';
import type { NewsContentBlock } from '../types';
import './news-detail-page.css';

const sourceKindLabels: Record<string, string> = {
  OFFICIAL_RELEASE: '공식 기관 발표',
  COMPANY_IR: '기업 IR',
};

function ContentBlocks({ blocks, language }: { blocks: NewsContentBlock[]; language: string }) {
  return (
    <div className="news-detail__body" lang={language}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === 'HEADING') {
          const Heading = `h${block.level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
          return <Heading key={key}>{block.text}</Heading>;
        }
        if (block.type === 'LIST') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${key}-${itemIndex}`}>{item}</li>
              ))}
            </List>
          );
        }
        if (block.type === 'QUOTE') return <blockquote key={key}>{block.text}</blockquote>;
        return <p key={key}>{block.text}</p>;
      })}
    </div>
  );
}

export function NewsDetailPage() {
  const { id = '' } = useParams();
  const news = useQuery({
    queryKey: ['news-detail', id],
    queryFn: () => api.newsDetail(id),
    enabled: Boolean(id),
  });

  if (news.isPending) return <LoadingState label="뉴스 본문을 불러오는 중입니다." />;
  if (news.isError)
    return <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />;

  const data = news.data;
  const originalUrl = safeNewsUrl(data.url);
  const original = data.content?.original ?? null;
  const translation = data.content?.translation ?? null;
  const displayedBlocks = translation?.blocks ?? original?.blocks ?? [];
  const displayedLanguage =
    translation?.language ?? original?.language ?? data.contentLanguage ?? 'ko';

  return (
    <div className="page-stack news-detail">
      <Link className="back-link" to="/news">
        <ArrowLeft size={15} aria-hidden="true" /> 뉴스 목록
      </Link>

      <article className="news-detail__article">
        <header className="news-detail__header">
          <div className="news-detail__kicker">
            <Newspaper size={17} aria-hidden="true" />
            <span>{data.sourceName || data.publisherId || '뉴스 출처'}</span>
            {data.sourceKind ? (
              <span>{sourceKindLabels[data.sourceKind] ?? '검토된 뉴스'}</span>
            ) : null}
          </div>
          <h1 lang={data.translation ? 'ko' : undefined}>
            {data.translation?.title ?? data.title}
          </h1>
          {data.translation ? (
            <p className="news-detail__original-title" lang="en">
              {data.title}
            </p>
          ) : null}
          <div className="news-detail__meta">
            {data.author ? <span>작성 {data.author}</span> : null}
            {data.publishedAt ? (
              <time dateTime={data.publishedAt}>발행 {formatKst(data.publishedAt)}</time>
            ) : (
              <span>발행시각 미제공</span>
            )}
            <time dateTime={data.firstObservedAt}>최초 확인 {formatKst(data.firstObservedAt)}</time>
          </div>
          {originalUrl ? (
            <a
              className="button button--secondary button--sm"
              href={originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              원문 사이트 <ArrowUpRight size={15} aria-hidden="true" />
            </a>
          ) : null}
        </header>

        {translation ? (
          <div className="news-detail__translation-note">
            <Languages size={17} aria-hidden="true" />
            <span>한국어 자동 번역본입니다. 중요한 내용은 원문과 함께 확인하세요.</span>
          </div>
        ) : null}

        {displayedBlocks.length ? (
          <ContentBlocks blocks={displayedBlocks} language={displayedLanguage} />
        ) : (
          <p className="news-detail__empty">표시할 수 있는 본문이 없습니다.</p>
        )}

        {translation && original ? (
          <details className="news-detail__original">
            <summary>영문 원문 펼치기</summary>
            <ContentBlocks blocks={original.blocks} language={original.language} />
          </details>
        ) : null}

        {data.content ? (
          <footer className="news-detail__content-meta">
            <span>본문 수집 {formatKst(data.content.original.fetchedAt)}</span>
            {translation ? <span>번역 {formatKst(translation.translatedAt)}</span> : null}
          </footer>
        ) : null}
      </article>
    </div>
  );
}
