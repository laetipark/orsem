import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Building2, ChevronRight, FileText, Newspaper, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ReactNode } from 'react';
import { RegionTabs, useRegion } from '../components/region-tabs';
import { api } from '../lib/api';
import { displayDomainText } from '../lib/domain-labels';
import { formatDate, formatKst } from '../lib/format';
import type { SearchItem, SearchResults } from '../types';
import { RightsBadge } from '../components/domain-badges';
import { TranslatedText } from '../components/translated-text';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
} from '../components/ui';
import './search-page.css';

const groups = [
  { key: 'companies', title: '종목', icon: Building2 },
  { key: 'news', title: '뉴스', icon: Newspaper },
  { key: 'filings', title: '공시', icon: FileText },
] as const;
type Group = (typeof groups)[number]['key'];
const sourceNames: Record<string, string> = {
  OPENDART: 'OpenDART',
  DART: 'OpenDART',
  SEC: 'SEC EDGAR',
  NAVER: '네이버 뉴스',
  NEWS_RSS: '시장 뉴스 RSS',
  IR: '기업 IR',
  GDELT: 'GDELT',
  TOSS: '토스증권',
  TOSS_KR: '토스증권',
  TOSS_US: '토스증권',
};

function ResultRow({ item }: { item: SearchItem }) {
  const Icon = item.type === 'COMPANY' ? Building2 : item.type === 'NEWS' ? Newspaper : FileText;
  const content = (
    <>
      <span className="search-result__icon">
        <Icon size={19} aria-hidden="true" />
      </span>
      <span className="search-result__copy">
        <TranslatedText
          title={item.title}
          translation={item.type === 'NEWS' ? item.translation : null}
        />
        <span>{displayDomainText(item.subtitle)}</span>
        {item.type !== 'COMPANY' ? (
          <span className="search-result__meta">
            {item.source ? <Badge>{sourceNames[item.source] ?? item.source}</Badge> : null}
            {item.rightsMode ? <RightsBadge status={item.rightsMode} /> : null}
            {item.rceptDate ? (
              <span>접수 {formatDate(item.rceptDate)}</span>
            ) : item.publishedAt ? (
              <span>게시 {formatKst(item.publishedAt)}</span>
            ) : null}
            {item.firstObservedAt ? <span>최초 확인 {formatKst(item.firstObservedAt)}</span> : null}
          </span>
        ) : null}
      </span>
      {item.external ? (
        <ArrowUpRight size={18} aria-label="원문 새 창에서 보기" />
      ) : (
        <ChevronRight size={18} aria-hidden="true" />
      )}
    </>
  );
  return item.external ? (
    <a
      className="search-result"
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      {content}
    </a>
  ) : (
    <Link className="search-result" to={item.url}>
      {content}
    </Link>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const { region } = useRegion();
  const query = (params.get('q') ?? '').trim();
  const selected = params.get('type') ?? 'all';
  const limit = params.get('limit') === '10' ? 10 : 5;
  const result = useQuery({
    queryKey: ['search', query, limit, region],
    queryFn: () => api.search(query, limit, region),
    enabled: query.length > 0 && query.length <= 120,
  });
  const changeGroup = (value: Group | 'all') =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === 'all') next.delete('type');
      else next.set('type', value);
      return next;
    });
  if (!query)
    return (
      <div className="page-stack">
        <RegionTabs />
        <EmptyState
          title="무엇을 찾고 계신가요?"
          description="상단 검색창에 기업명, 종목코드, 티커 또는 뉴스·공시 제목을 입력해 주세요."
        />
      </div>
    );
  if (query.length > 120) return <ErrorState message="검색어는 120자 이내로 입력해 주세요." />;
  const data = result.data;
  const hasResults = data && groups.some(({ key }) => data[key].length > 0);
  const visibleGroups = groups.filter(
    ({ key }) =>
      selected === 'all' || !groups.some((group) => group.key === selected) || key === selected,
  );
  return (
    <div className="page-stack search-page">
      <div className="search-heading">
        <Search size={21} aria-hidden="true" />
        <div>
          <h2>‘{query}’ 검색 결과</h2>
          <p>수집된 종목 정보와 뉴스·공시에서 찾습니다. 뉴스와 공시는 원문으로 연결됩니다.</p>
        </div>
      </div>
      <RegionTabs />
      <div className="search-tabs" role="group" aria-label="검색 분류">
        <Button
          variant={selected === 'all' ? 'primary' : 'secondary'}
          aria-pressed={selected === 'all'}
          onClick={() => changeGroup('all')}
        >
          전체
        </Button>
        {groups.map(({ key, title }) => (
          <Button
            key={key}
            variant={selected === key ? 'primary' : 'secondary'}
            aria-pressed={selected === key}
            onClick={() => changeGroup(key)}
          >
            {title}
            {data ? (
              <span>
                {data[key].length}
                {data.hasMore[key] ? '+' : ''}
              </span>
            ) : null}
          </Button>
        ))}
      </div>
      {result.isPending ? <LoadingState label="종목·뉴스·공시를 찾고 있습니다." /> : null}
      {result.isError ? (
        <ErrorState message={result.error.message} onRetry={() => void result.refetch()} />
      ) : null}
      {data && !hasResults ? (
        <EmptyState
          title="검색 결과가 없습니다"
          description="기업의 영문명이나 티커로도 검색해 보세요. 아직 수집하지 않은 뉴스와 공시는 표시되지 않습니다."
        />
      ) : null}
      {data && hasResults
        ? visibleGroups.map(({ key, title, icon: Icon }) => (
            <SearchGroup
              key={key}
              group={key}
              title={title}
              data={data}
              icon={<Icon size={19} aria-hidden="true" />}
            />
          ))
        : null}
      {data && hasResults && visibleGroups.some(({ key }) => data.hasMore[key]) ? (
        limit < 10 ? (
          <Button
            variant="secondary"
            className="search-expand"
            onClick={() =>
              setParams((current) => {
                const next = new URLSearchParams(current);
                next.set('limit', '10');
                return next;
              })
            }
          >
            검색 결과 더 보기
          </Button>
        ) : (
          <p className="search-limit">
            각 분류에서 최대 10개를 표시합니다. 찾는 결과가 없다면 검색어를 더 구체적으로 입력해
            주세요.
          </p>
        )
      ) : null}
    </div>
  );
}

function SearchGroup({
  group,
  title,
  data,
  icon,
}: {
  group: Group;
  title: string;
  data: SearchResults;
  icon: ReactNode;
}) {
  return (
    <Card className="search-group">
      <CardHeader>
        <h2>
          {icon}
          {title}
          <Badge>
            {data[group].length}
            {data.hasMore[group] ? '+' : ''}
          </Badge>
        </h2>
      </CardHeader>
      {data[group].length ? (
        <div>
          {data[group].map((item) => (
            <ResultRow key={`${item.type}-${item.id}`} item={item} />
          ))}
        </div>
      ) : (
        <p className="search-group__empty">일치하는 {title} 정보가 없습니다.</p>
      )}
    </Card>
  );
}
