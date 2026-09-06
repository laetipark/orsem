import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api';
import type { SearchItem, SearchResults } from '../types';
import './search-autocomplete.css';

type Filters = NonNullable<Parameters<typeof api.suggestions>[1]>;
interface Props {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (item: SearchItem) => void;
  onSubmit?: () => void;
  filters?: Filters;
  contextKey?: string;
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  shortcut?: boolean;
}

export function SearchInput({
  value,
  onChange,
  onSelect,
  onSubmit,
  filters = {},
  contextKey = '',
  label,
  placeholder,
  disabled,
  className = '',
  shortcut = false,
}: Props) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const composing = useRef(false);
  const compositionEnd = useRef(-Infinity);
  const [ime, setIme] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<{
    key: string;
    data?: SearchResults;
    error?: boolean;
  } | null>(null);
  const query = value.trim();
  const filterKey = JSON.stringify(filters);
  const key = JSON.stringify([query, filterKey, contextKey]);
  const visible = open && !disabled && !ime && query.length > 0 && query.length <= 120;
  const current = result?.key === key ? result : null;
  const safe = (item: SearchItem) =>
    item.external
      ? /^https:\/\/[^/\s@]+(?:\/|$)/iu.test(item.url)
      : /^\/(companies|news)\/(?:[A-Z]+:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\?[^#]*)?$/u.test(
          item.url,
        );
  const groups = [
    {
      label: '종목',
      items:
        filters.kind === 'news'
          ? []
          : (current?.data?.companies ?? [])
              .filter((item) => item.type === 'COMPANY' && safe(item))
              .slice(0, 5),
    },
    {
      label: '뉴스',
      items: ['companies', 'events'].includes(filters.kind ?? '')
        ? []
        : (current?.data?.news ?? [])
            .filter((item) => item.type === 'NEWS' && safe(item))
            .slice(0, 5),
    },
  ];
  const items = groups.flatMap((group) => group.items);
  const selected = visible ? items[active] : undefined;
  function close() {
    generation.current++;
    setOpen(false);
    setActive(-1);
  }
  function pending() {
    return composing.current || performance.now() - compositionEnd.current < 60;
  }
  function submit() {
    if (pending() || !query) return;
    close();
    onSubmit?.();
  }
  function choose(item: SearchItem) {
    if (pending()) return;
    close();
    onChange(
      item.type === 'COMPANY'
        ? (item.company?.nameKo ?? item.title)
        : (item.translation?.title ?? item.title),
    );
    onSelect?.(item);
  }

  useEffect(() => {
    generation.current++;
    setResult(null);
    setActive(-1);
  }, [contextKey, filterKey]);
  useEffect(() => {
    close();
  }, [contextKey]);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    const version = ++generation.current;
    const timer = window.setTimeout(() => {
      void api.suggestions(query, JSON.parse(filterKey) as Filters, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted && generation.current === version)
            setResult({ key, data });
        },
        () => {
          if (!controller.signal.aborted && generation.current === version)
            setResult({ key, error: true });
        },
      );
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [visible, value, query, filterKey, key]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    };
    const focus = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (
        !shortcut ||
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
      input.current?.focus();
      input.current?.select();
    };
    // Block an IME-committing Enter even when a parent form receives submit directly.
    const preventCompositionSubmit = (event: Event) => {
      if (pending() && container.current?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const form = container.current?.closest('form');
    form?.addEventListener('submit', preventCompositionSubmit, true);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', focus);
    return () => {
      form?.removeEventListener('submit', preventCompositionSubmit, true);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', focus);
    };
  }, [shortcut]);
  useEffect(() => {
    if (active >= 0)
      document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, id]);
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (pending() || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (items.length)
        setActive((index) =>
          event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : index <= 0
              ? items.length - 1
              : index - 1,
        );
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (selected) choose(selected);
      else if (onSubmit) submit();
      else input.current?.form?.requestSubmit();
    }
  }
  return (
    <div
      ref={container}
      className={`search-input ${className}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) close();
      }}
    >
      <input
        className="input"
        ref={input}
        type="search"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? `${id}-list` : undefined}
        aria-activedescendant={selected ? `${id}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={120}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(event) => {
          generation.current++;
          onChange(event.target.value);
          setResult(null);
          setActive(-1);
          setOpen(true);
        }}
        onCompositionStart={() => {
          composing.current = true;
          generation.current++;
          setIme(true);
          setResult(null);
          setActive(-1);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          compositionEnd.current = performance.now();
          onChange(event.currentTarget.value);
          setIme(false);
          setOpen(true);
        }}
        onKeyDown={keyDown}
      />
      {visible ? (
        <div className="search-autocomplete__panel">
          <div id={`${id}-list`} role="listbox" aria-label={`${label} 후보`} aria-busy={!current}>
            {groups
              .filter((group) => group.items.length)
              .map((group) => (
                <div
                  key={group.label}
                  role="group"
                  aria-label={`${group.label} ${group.items.length}`}
                >
                  <div className="search-autocomplete__heading">
                    {group.label} <span>{group.items.length}</span>
                  </div>
                  {group.items.map((item) => {
                    const index = items.indexOf(item);
                    return (
                      <div
                        key={`${item.type}:${item.id}`}
                        id={`${id}-${index}`}
                        role="option"
                        aria-selected={active === index}
                        className="search-autocomplete__option"
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerMove={() => setActive(index)}
                        onClick={() => choose(item)}
                      >
                        <span className="search-autocomplete__copy">
                          <strong>{item.translation?.title ?? item.title}</strong>
                          <span>
                            {item.type === 'COMPANY'
                              ? item.subtitle
                              : (item.translation?.description ??
                                item.description ??
                                '요약 미제공')}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
          </div>
          <p className="search-autocomplete__status" role="status">
            {!current
              ? '검색 중입니다.'
              : current.error
                ? '검색 후보를 불러오지 못했습니다.'
                : !items.length
                  ? '일치하는 검색 후보가 없습니다.'
                  : `${items.length}개 검색 후보`}
          </p>
          {onSubmit ? (
            <button type="button" className="search-autocomplete__all" onClick={submit}>
              ‘{query}’ 검색
            </button>
          ) : null}
          <span className="search-autocomplete__hint">↑↓ 선택 · Enter 확인 · Esc 닫기</span>
        </div>
      ) : null}
    </div>
  );
}
