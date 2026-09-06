import { useState } from 'react';
import './article-language.css';

export type ArticleLanguage = 'translation' | 'original';

export function useArticleLanguage(articleId: string) {
  const [selection, setSelection] = useState({
    articleId,
    language: 'translation' as ArticleLanguage,
  });
  if (selection.articleId !== articleId) {
    setSelection({ articleId, language: 'translation' });
  }
  const language = selection.articleId === articleId ? selection.language : 'translation';
  const selectLanguage = (next: ArticleLanguage) => setSelection({ articleId, language: next });
  return [language, selectLanguage] as const;
}

export function ArticleLanguageSwitch({
  language,
  onChange,
}: {
  language: ArticleLanguage;
  onChange: (language: ArticleLanguage) => void;
}) {
  return (
    <div className="article-language" role="group" aria-label="기사 언어">
      <button
        type="button"
        aria-pressed={language === 'translation'}
        onClick={() => onChange('translation')}
      >
        번역
      </button>
      <button
        type="button"
        aria-pressed={language === 'original'}
        onClick={() => onChange('original')}
      >
        원문
      </button>
    </div>
  );
}
