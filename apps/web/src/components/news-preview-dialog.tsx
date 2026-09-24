import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { NaverHighlightedText } from './naver-highlighted-text';
import './news-preview-dialog.css';

export function NewsPreviewDialog({
  title,
  description,
  naver,
  url,
  onClose,
  children,
}: {
  title: string;
  description: string;
  naver: boolean;
  url: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement;
    if (element.showModal) element.showModal();
    else element.setAttribute('open', '');
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="news-preview"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="news-preview__panel">
        <header>
          <span>뉴스 미리보기</span>
          <button
            type="button"
            className="button button--ghost button--icon"
            aria-label="뉴스 미리보기 닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="news-preview__body">
          <h2 id={titleId}>{naver ? <NaverHighlightedText value={title} /> : title}</h2>
          <div className="news-preview__metadata">{children}</div>

          <p className="news-preview__summary">
            {naver ? <NaverHighlightedText value={description} /> : description}
          </p>
        </div>
        <footer>
          {url ? (
            <a
              className="button button--primary"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              자세히 보기 <ArrowUpRight size={16} aria-hidden="true" />
              <span className="sr-only"> 원문 새 창에서 보기</span>
            </a>
          ) : (
            <span>원문 링크를 확인할 수 없습니다.</span>
          )}
        </footer>
      </div>
    </dialog>
  );
}
