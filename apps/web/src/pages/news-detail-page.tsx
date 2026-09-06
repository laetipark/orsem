import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Languages, Newspaper } from 'lucide-react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { Button, ErrorState, LoadingState } from '../components/ui';
import { NewsContentBlocks } from '../components/news-content-blocks';
import { ArticleLanguageSwitch, useArticleLanguage } from '../components/article-language';
import { safeNewsUrl } from '../components/market-news';
import { api, ApiError } from '../lib/api';
import { formatKst } from '../lib/format';
import type { Session } from '../types';
import './news-detail-page.css';

const NewsTranslationEditor = lazy(() =>
  import('../components/news-translation-editor').then((module) => ({
    default: module.NewsTranslationEditor,
  })),
);

const sourceKindLabels: Record<string, string> = {
  OFFICIAL_RELEASE: '공식 기관 발표',
  COMPANY_IR: '기업 IR',
};

export function NewsDetailPage() {
  const { id = '' } = useParams();
  const session = useOutletContext<Session | null>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [language, setLanguage] = useArticleLanguage(id);
  const news = useQuery({
    queryKey: ['news-detail', id],
    queryFn: ({ signal }) => api.newsDetail(id, signal),
    enabled: Boolean(id),
  });
  const isAdmin =
    import.meta.env.VITE_NEWS_TRANSLATION_EDITOR_ENABLED === 'true' &&
    session?.user?.role === 'ADMIN';
  const isEditing = isAdmin && editingId === id;
  const renderEditor = (lookupId: string, reviewRequired = false) =>
    session?.user ? (
      <Suspense fallback={<LoadingState label="번역 편집기를 준비하는 중입니다." />}>
        <NewsTranslationEditor
          key={`${session.user.id}:${id}`}
          articleId={lookupId}
          userId={session.user.id}
          reviewRequired={reviewRequired}
          onClose={() => setEditingId((current) => (current === id ? null : current))}
          onSaved={() => {
            setEditingId((current) => (current === id ? null : current));
            setLanguage('translation');
            setSavedId(id);
          }}
        />
      </Suspense>
    ) : null;

  if (news.isPending) return <LoadingState label="뉴스 본문을 불러오는 중입니다." />;
  if (news.isError) {
    const canReview = isAdmin && news.error instanceof ApiError && news.error.statusCode === 404;
    return (
      <div className={`page-stack news-detail${isEditing ? ' news-detail--editing' : ''}`}>
        <Link className="back-link" to="/news">
          <ArrowLeft size={15} aria-hidden="true" /> 뉴스 목록
        </Link>
        <ErrorState message={news.error.message} onRetry={() => void news.refetch()} />
        {canReview ? (
          <>
            <p>원문이 변경된 기사는 관리자가 원문과 번역을 다시 확인한 뒤 저장할 수 있습니다.</p>
            {isEditing ? (
              renderEditor(id, true)
            ) : (
              <Button type="button" variant="secondary" onClick={() => setEditingId(id)}>
                원문 확인·번역 수정
              </Button>
            )}
          </>
        ) : null}
      </div>
    );
  }

  const data = news.data;
  const originalUrl = safeNewsUrl(data.url);
  const original = data.content?.original ?? null;
  const translation = data.content?.translation ?? null;
  const hasTranslation = original?.language !== 'ko' && Boolean(translation && data.translation);
  const showTranslation = hasTranslation && language === 'translation';
  const displayedBlocks = (showTranslation ? translation?.blocks : original?.blocks) ?? [];
  const displayedLanguage = showTranslation
    ? 'ko'
    : (original?.language ?? data.contentLanguage ?? 'ko');
  const displayedTitle = showTranslation ? data.translation!.title : data.title;
  const description = showTranslation ? data.translation!.description : data.description;

  return (
    <div className={`page-stack news-detail${isEditing ? ' news-detail--editing' : ''}`}>
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
          <h1 lang={displayedLanguage}>{displayedTitle}</h1>
          {hasTranslation ? (
            <ArticleLanguageSwitch language={language} onChange={setLanguage} />
          ) : null}
          {description?.trim() && description !== displayedTitle ? (
            <p className="news-detail__summary" lang={displayedLanguage}>
              {description}
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
          {isAdmin && original?.language === 'en' && translation ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isEditing}
              onClick={() => {
                setEditingId(id);
                setSavedId(null);
              }}
            >
              번역 수정
            </Button>
          ) : null}
        </header>

        {savedId === id ? (
          <p className="news-detail__saved" role="status">
            번역을 저장했습니다.
          </p>
        ) : null}
        {isEditing ? (
          renderEditor(data.id)
        ) : (
          <>
            {showTranslation ? (
              <div className="news-detail__translation-note">
                <Languages size={17} aria-hidden="true" />
                <span>
                  {translation?.editedAt
                    ? '관리자가 수정한 한국어 번역본입니다. 원문과 함께 확인하세요.'
                    : '한국어 자동 번역본입니다. 중요한 내용은 원문과 함께 확인하세요.'}
                </span>
              </div>
            ) : null}

            {displayedBlocks.length ? (
              <NewsContentBlocks
                blocks={displayedBlocks}
                language={displayedLanguage}
                markdown={showTranslation && translation?.format === 'MARKDOWN'}
              />
            ) : (
              <p className="news-detail__empty">표시할 수 있는 본문이 없습니다.</p>
            )}

            {data.content ? (
              <footer className="news-detail__content-meta">
                <span>본문 수집 {formatKst(data.content.original.fetchedAt)}</span>
                {translation ? <span>번역 {formatKst(translation.translatedAt)}</span> : null}
                {translation?.editedAt ? <span>수정 {formatKst(translation.editedAt)}</span> : null}
                {translation?.provider === 'AZURE' ? <span>Microsoft Translator</span> : null}
              </footer>
            ) : null}
          </>
        )}
      </article>
    </div>
  );
}
