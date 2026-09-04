import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowLeft, ArrowRight, FilterX, Search } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventFilters } from '../lib/api';
import { formatDate, formatKst } from '../lib/format';
import { disclosureLabels, priorityLabels } from '../lib/domain-labels';
import type { EventSummary } from '../types';
import { RegionTabs, parseRegion } from '../components/region-tabs';
import { DataTable } from '../components/data-table';
import {
  DirectionBadge,
  EventStateBadge,
  EventTypeBadge,
  EvidenceBadge,
  NatureBadge,
  PriorityBadge,
  RightsBadge,
} from '../components/domain-badges';
import {
  EventCompanyIdentity,
  EventMobileCard,
  hasObservedOwnershipSemantics,
} from '../components/event-row';
import { TranslatedText } from '../components/translated-text';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Select,
} from '../components/ui';

function filtersFromSearch(params: URLSearchParams): EventFilters {
  return {
    q: params.get('q') ?? '',
    region: parseRegion(params.get('region')),
    detailType: params.get('detailType') ?? '',
    priority: params.get('priority') ?? '',
    classificationStatus: params.get('classificationStatus') ?? '',
    cursor: params.get('cursor'),
    limit: 20,
  };
}

export function EventsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = filtersFromSearch(searchParams);
  const [queryInput, setQueryInput] = useState(filters.q ?? '');
  useEffect(() => setQueryInput(filters.q ?? ''), [filters.q]);
  const cursorHistory = useRef(new Map<string, string | null>());
  const events = useQuery({
    queryKey: ['events', filters],
    queryFn: () => api.events(filters),
  });

  function updateFilter(key: string, value: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete('cursor');
      return next;
    });
    cursorHistory.current.clear();
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    updateFilter('q', queryInput.trim());
  }

  function clearFilters() {
    setQueryInput('');
    setSearchParams({});
    cursorHistory.current.clear();
  }

  function nextPage() {
    if (!events.data?.nextCursor) return;
    cursorHistory.current.set(events.data.nextCursor, filters.cursor ?? null);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('cursor', events.data.nextCursor ?? '');
      return next;
    });
  }

  function previousPage() {
    const previous = filters.cursor ? cursorHistory.current.get(filters.cursor) : null;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (previous) next.set('cursor', previous);
      else next.delete('cursor');
      return next;
    });
  }

  const columns = useMemo<Array<ColumnDef<EventSummary>>>(
    () => [
      {
        id: 'company',
        header: '기업',
        cell: ({ row }) => (
          <Link className="table-company" to={`/companies/${row.original.companyId}`}>
            <EventCompanyIdentity event={row.original} />
          </Link>
        ),
      },
      {
        id: 'event',
        header: '공시·이벤트',
        cell: ({ row }) => (
          <Link className="table-event" to={`/events/${row.original.id}`}>
            <span>
              <EventTypeBadge type={row.original.detailType} />
              <PriorityBadge priority={row.original.priority} />
            </span>
            <TranslatedText
              title={row.original.title}
              description={row.original.summary}
              translation={row.original.detailType === 'NEWS' ? row.original.translation : null}
            />
          </Link>
        ),
      },
      {
        id: 'classification',
        header: '분류',
        cell: ({ row }) =>
          !hasObservedOwnershipSemantics(row.original.detailType) ? (
            <span>
              {row.original.detailType === 'D003'
                ? '권유 주요내용'
                : row.original.detailType === 'D004'
                  ? '공개매수 주요내용'
                  : row.original.detailType === 'D005'
                    ? '향후 거래계획 · 실제 체결 아님'
                    : row.original.detailType === 'NEWS'
                      ? '기업 뉴스'
                      : '공시 접수'}
            </span>
          ) : (
            <div className="cell-stack">
              <NatureBadge nature={row.original.nature} />
              <DirectionBadge direction={row.original.direction} />
            </div>
          ),
      },
      {
        id: 'dates',
        header: '기준일 / 공시',
        cell: ({ row }) => (
          <div className="cell-dates">
            <span>
              {row.original.detailType === 'D005' && row.original.eventAt
                ? `계획 시작 ${formatDate(row.original.eventAt)}`
                : hasObservedOwnershipSemantics(row.original.detailType)
                  ? formatDate(row.original.eventAt)
                  : '—'}
            </span>
            <small>
              {row.original.rceptDate
                ? `접수 ${formatDate(row.original.rceptDate)}`
                : formatKst(row.original.publishedAt)}
            </small>
          </div>
        ),
      },
      {
        id: 'evidence',
        header: '근거·상태',
        cell: ({ row }) => (
          <div className="cell-stack">
            <EvidenceBadge grade={row.original.evidenceGrade} />
            <EventStateBadge
              submissionKind={row.original.submissionKind}
              effectiveState={row.original.effectiveState}
            />
            <RightsBadge status={row.original.rightsMode} />
          </div>
        ),
      },
    ],
    [],
  );

  const hasFilters = Boolean(
    filters.q ||
    filters.detailType ||
    filters.priority ||
    filters.classificationStatus ||
    filters.region !== 'all',
  );

  return (
    <div className="page-stack">
      <div className="page-lead">
        <div>
          <p>공시 유형과 사건 성격을 구분합니다. SEC는 공시 접수 메타데이터를 표시합니다.</p>
        </div>
      </div>
      <RegionTabs onChange={() => cursorHistory.current.clear()} />
      <Card className="filter-card">
        <form className="filter-form" onSubmit={submitSearch}>
          <label className="search-field">
            <span className="sr-only">기업명, 종목코드 또는 제목 검색</span>
            <Search size={17} aria-hidden="true" />
            <Input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              placeholder="기업명 · 종목코드 · 공시 제목"
            />
          </label>
          <Select
            aria-label="공시 유형"
            value={filters.detailType}
            onChange={(event) => updateFilter('detailType', event.target.value)}
          >
            <option value="">모든 유형</option>
            <option value="D001">{disclosureLabels.D001}</option>
            <option value="D002">{disclosureLabels.D002}</option>
            <option value="D003">{disclosureLabels.D003}</option>
            <option value="D004">{disclosureLabels.D004}</option>
            <option value="D005">{disclosureLabels.D005}</option>
            <option value="SEC">{disclosureLabels.SEC}</option>
            <option value="NEWS">{disclosureLabels.NEWS}</option>
          </Select>
          <Select
            aria-label="우선순위"
            value={filters.priority}
            onChange={(event) => updateFilter('priority', event.target.value)}
          >
            <option value="">모든 우선순위</option>
            <option value="P1">{priorityLabels.P1}</option>
            <option value="P2">{priorityLabels.P2}</option>
            <option value="P3">{priorityLabels.P3}</option>
            <option value="P4">{priorityLabels.P4}</option>
          </Select>
          <Select
            aria-label="분류 검증 상태"
            value={filters.classificationStatus}
            onChange={(event) => updateFilter('classificationStatus', event.target.value)}
          >
            <option value="">모든 검증 상태</option>
            <option value="RULE_CONFIRMED">규칙 확인</option>
            <option value="AI_CONFIRMED">AI 확인</option>
            <option value="AI_SUGGESTED">AI 제안</option>
            <option value="REVIEW_REQUIRED">사람 검토 필요</option>
          </Select>
          <Button type="submit" size="sm">
            <Search size={15} /> 검색
          </Button>
          {hasFilters ? (
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
              <FilterX size={15} /> 초기화
            </Button>
          ) : null}
        </form>
      </Card>

      {events.isPending ? <LoadingState label="이벤트를 조회하는 중입니다." /> : null}
      {events.isError ? (
        <ErrorState message={events.error.message} onRetry={() => void events.refetch()} />
      ) : null}
      {events.data ? (
        <>
          <div className="desktop-events-table">
            <DataTable
              data={events.data.items}
              columns={columns}
              emptyMessage="조건에 맞는 이벤트가 없습니다."
            />
          </div>
          <div className="mobile-events-list">
            {events.data.items.length ? (
              events.data.items.map((event) => <EventMobileCard key={event.id} event={event} />)
            ) : (
              <EmptyState
                title="조건에 맞는 이벤트가 없습니다"
                description="검색어나 공시 유형 필터를 조정해 보세요."
              />
            )}
          </div>
          <div className="cursor-pagination">
            <Button variant="secondary" size="sm" onClick={previousPage} disabled={!filters.cursor}>
              <ArrowLeft size={15} /> 이전
            </Button>
            <span>현재 조회 {events.data.items.length}건</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={nextPage}
              disabled={!events.data.nextCursor}
            >
              다음 <ArrowRight size={15} />
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
