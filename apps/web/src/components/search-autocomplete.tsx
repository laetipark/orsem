import { Building2, ChevronRight, LoaderCircle, Newspaper, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { SearchItem, SearchResults } from '../types';
import { parseRegion } from './region-tabs';
import './search-autocomplete.css';

const RESULT_LIMIT = 5;
const DEBOUNCE_MS = 250;

interface Suggestion {
  item: SearchItem;
  title: string;
  description: string | null;
}

type ResultState =
  | { key: string; status: 'loading' | 'error' }
  | { key: string; status: 'ready'; data: SearchResults };

function newsSuggestion(item: SearchItem): Suggestion | null {
  if (item.type !== 'NEWS' || item.external || !item.url.startsWith('/news/')) return null;
  if (item.translation?.language === 'ko' && item.translation.title.trim()) {
    return {
      item,
      title: item.translation.title.trim(),
      description: item.translation.description?.trim() || null,
    };
  }
  // Korean originals need no translation. Never fall back to an English news title.
  return /[가-힣]/u.test(item.title) ? { item, title: item.title, description: null } : null;
}

export function HeaderSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const id = useId();
  const listId = `${id}-suggestions`;
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const composing = useRef(false);
  const compositionEndedAt = useRef(-Infinity);
  const [input, setInput] = useState(() => new URLSearchParams(location.search).get('q') ?? '');
  const [open, setOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [result, setResult] = useState<ResultState | null>(null);
  const query = input.trim();
  const region = parseRegion(new URLSearchParams(location.search).get('region'));
  const resultKey = JSON.stringify([query, region]);
  const visible = open && !isComposing && query.length > 0 && query.length <= 120;
  const current = result?.key === resultKey ? result : null;
  const data = current?.status === 'ready' ? current.data : null;
  const companies: Suggestion[] = (data?.companies ?? [])
    .filter(
      (item) => item.type === 'COMPANY' && !item.external && item.url.startsWith('/companies/'),
    )
    .slice(0, RESULT_LIMIT)
    .map((item) => ({ item, title: item.title, description: item.subtitle || null }));
  const news = (data?.news ?? [])
    .map(newsSuggestion)
    .filter((item): item is Suggestion => item !== null)
    .slice(0, RESULT_LIMIT);
  const suggestions = [...companies, ...news];
  const active = visible ? suggestions[activeIndex] : undefined;

  function close() {
    generation.current += 1;
    setOpen(false);
    setActiveIndex(-1);
    setResult(null);
  }

  useEffect(() => {
    generation.current += 1;
    setOpen(false);
    setActiveIndex(-1);
    setResult(null);
    if (location.pathname === '/search') {
      setInput(new URLSearchParams(location.search).get('q') ?? '');
    }
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!visible || query.length > 120) return;
    const controller = new AbortController();
    const requestGeneration = ++generation.current;
    setResult({ key: resultKey, status: 'loading' });
    const timer = window.setTimeout(() => {
      void api.search(query, RESULT_LIMIT, region, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setResult({ key: resultKey, status: 'ready', data });
          }
        },
        () => {
          if (!controller.signal.aborted && generation.current === requestGeneration) {
            setResult({ key: resultKey, status: 'error' });
          }
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [visible, input, query, region, resultKey]);

  useEffect(() => {
    const focusSearch = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== '/' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)))
      )
        return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const outsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !formRef.current?.contains(event.target)) close();
    };
    window.addEventListener('keydown', focusSearch);
    document.addEventListener('pointerdown', outsidePointer);
    return () => {
      window.removeEventListener('keydown', focusSearch);
      document.removeEventListener('pointerdown', outsidePointer);
    };
  }, []);

  useEffect(() => {
    if (activeIndex >= 0) {
      document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeIndex, listId]);

  function compositionPending() {
    // Some browsers dispatch the committing Enter just after compositionend.
    return composing.current || performance.now() - compositionEndedAt.current < 60;
  }

  function fullSearch() {
    if (!query || query.length > 120 || compositionPending()) {
      inputRef.current?.focus();
      return;
    }
    const params = new URLSearchParams({ q: query });
    if (region !== 'all') params.set('region', region);
    close();
    void navigate(`/search?${params}`);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }

  function choose(suggestion: Suggestion) {
    close();
    void navigate(suggestion.item.url);
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    fullSearch();
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (
      compositionPending() ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    ) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && query) {
      event.preventDefault();
      setOpen(true);
      if (suggestions.length) {
        setActiveIndex((index) =>
          event.key === 'ArrowDown'
            ? (index + 1) % suggestions.length
            : index <= 0
              ? suggestions.length - 1
              : index - 1,
        );
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
      else fullSearch();
    }
  }

  const loading = visible && (!current || current.status === 'loading');
  const groups = [
    { key: 'companies', label: '종목', icon: Building2, items: companies, offset: 0 },
    { key: 'news', label: '뉴스', icon: Newspaper, items: news, offset: companies.length },
  ];

  return (
    <form
      ref={formRef}
      className="header-search"
      role="search"
      aria-label="종목·뉴스·공시 통합 검색"
      onSubmit={submit}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <Search size={18} aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="종목·뉴스·공시 검색어"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
        aria-describedby={visible ? `${id}-hint` : undefined}
        placeholder="종목·뉴스·공시 검색"
        value={input}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          generation.current += 1;
          setInput(event.target.value);
          setActiveIndex(-1);
          setResult(null);
          setOpen(true);
        }}
        onCompositionStart={() => {
          composing.current = true;
          generation.current += 1;
          setIsComposing(true);
          setActiveIndex(-1);
          setResult(null);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          compositionEndedAt.current = performance.now();
          setInput(event.currentTarget.value);
          setIsComposing(false);
          setOpen(true);
        }}
        onKeyDown={keyDown}
        maxLength={120}
        autoComplete="off"
      />
      <button type="submit" aria-label="통합 검색 실행">
        검색
      </button>
      {visible ? (
        <div className="search-autocomplete__panel">
          <div id={listId} role="listbox" aria-label="종목·뉴스 검색 후보" aria-busy={loading}>
            {data
              ? groups.map(({ key, label, icon: Icon, items, offset }) => (
                  <div key={key} role="group" aria-labelledby={`${id}-${key}`}>
                    <p id={`${id}-${key}`} className="search-autocomplete__heading">
                      <Icon size={15} aria-hidden="true" /> {label}
                      <span>{items.length}</span>
                    </p>
                    {items.length ? (
                      items.map((suggestion, index) => (
                        <div
                          key={suggestion.item.id}
                          id={`${listId}-${offset + index}`}
                          role="option"
                          aria-selected={activeIndex === offset + index}
                          className="search-autocomplete__option"
                          onMouseDown={(event) => event.preventDefault()}
                          onPointerMove={() => setActiveIndex(offset + index)}
                          onClick={() => choose(suggestion)}
                        >
                          <span className="search-autocomplete__copy">
                            <strong>{suggestion.title}</strong>
                            {suggestion.description ? <span>{suggestion.description}</span> : null}
                          </span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </div>
                      ))
                    ) : (
                      <p className="search-autocomplete__empty">
                        일치하는 {label} 검색 결과가 없습니다.
                      </p>
                    )}
                  </div>
                ))
              : null}
          </div>
          <p className="search-autocomplete__status" role="status" aria-live="polite">
            {loading ? (
              <>
                <LoaderCircle size={15} aria-hidden="true" /> 검색 중입니다.
              </>
            ) : current?.status === 'error' ? (
              '검색 후보를 불러오지 못했습니다. 전체 검색에서 다시 확인해 주세요.'
            ) : (
              <span className="sr-only">
                종목 {companies.length}개, 뉴스 {news.length}개 검색 후보
              </span>
            )}
          </p>
          <button type="submit" className="search-autocomplete__all">
            <span>‘{query}’ 전체 검색</span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <span id={`${id}-hint`} className="search-autocomplete__hint">
            ↑↓ 후보 선택 · Enter 열기 · Esc 닫기
          </span>
        </div>
      ) : null}
    </form>
  );
}
