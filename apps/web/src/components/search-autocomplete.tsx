import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SearchInput } from './search-input';
import { parseRegion } from './region-tabs';
import './search-autocomplete.css';

export function HeaderSearch({ actorKey = '' }: { actorKey?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [input, setInput] = useState(new URLSearchParams(location.search).get('q') ?? '');
  const region = parseRegion(new URLSearchParams(location.search).get('region'));
  useEffect(() => {
    if (location.pathname === '/search')
      setInput(new URLSearchParams(location.search).get('q') ?? '');
  }, [location.pathname, location.search]);
  function search() {
    const q = input.trim();
    if (!q) return;
    const params = new URLSearchParams({ q });
    if (region !== 'all') params.set('region', region);
    void navigate(`/search?${params}`);
  }
  return (
    <form
      className="header-search"
      role="search"
      aria-label="종목·뉴스·공시 통합 검색"
      onSubmit={(event) => {
        event.preventDefault();
        search();
      }}
    >
      <Search size={18} aria-hidden="true" />
      <SearchInput
        value={input}
        onChange={setInput}
        onSelect={(item) => {
          if (item.external) {
            if (/^https:\/\//iu.test(item.url))
              window.open(item.url, '_blank', 'noopener,noreferrer');
          } else void navigate(item.url);
        }}
        onSubmit={search}
        filters={{ region }}
        contextKey={`${actorKey}:${location.pathname}:${location.search}`}
        label="종목·뉴스·공시 검색어"
        placeholder="종목·뉴스·공시 검색"
        shortcut
      />
      <button type="submit" aria-label="통합 검색 실행">
        검색
      </button>
    </form>
  );
}
