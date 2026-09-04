import { ArrowRight, Clock3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EventSummary } from '../types';
import { formatDate, formatKst } from '../lib/format';
import { CompanyAvatar } from './company-avatar';
import { TranslatedText } from './translated-text';
import {
  DirectionBadge,
  EventStateBadge,
  EventTypeBadge,
  EvidenceBadge,
  NatureBadge,
  PriorityBadge,
} from './domain-badges';
import './event-company.css';

export function EventCompanyIdentity({
  event,
}: {
  event: Pick<EventSummary, 'companyName' | 'stockCode' | 'ticker' | 'market'>;
}) {
  return (
    <span className="event-company">
      <CompanyAvatar
        className="event-company__avatar"
        company={{
          nameKo: event.companyName,
          stockCode: event.stockCode,
          ticker: event.ticker ?? null,
          market: event.market,
        }}
      />
      <span className="event-company__copy">
        <strong className="event-company__name">{event.companyName}</strong>
        <span className="event-company__symbol mono">
          {event.stockCode ?? event.ticker ?? event.market}
        </span>
      </span>
    </span>
  );
}

export function EventCompactRow({ event }: { event: EventSummary }) {
  return (
    <Link className="event-row" to={`/events/${event.id}`}>
      <div className="event-row__topline">
        <EventCompanyIdentity event={event} />
        <PriorityBadge priority={event.priority} />
      </div>
      <div className="event-row__badges">
        <EventTypeBadge type={event.detailType} />
        {event.detailType !== 'SEC' ? <NatureBadge nature={event.nature} /> : null}
      </div>
      {event.detailType === 'NEWS' ? (
        <TranslatedText
          title={event.title}
          description={event.summary}
          translation={event.translation}
        />
      ) : (
        <p>{event.summary}</p>
      )}
      <div className="event-row__meta">
        {event.detailType !== 'SEC' ? (
          <span>
            <Clock3 size={13} aria-hidden="true" /> 사건 {formatDate(event.eventAt)}
          </span>
        ) : null}
        <span>
          {event.rceptDate
            ? `접수 ${formatDate(event.rceptDate)}`
            : `게시 ${formatKst(event.publishedAt)}`}
        </span>
      </div>
      <ArrowRight className="event-row__arrow" size={18} aria-hidden="true" />
    </Link>
  );
}

export function EventMobileCard({ event }: { event: EventSummary }) {
  return (
    <Link className="event-mobile-card" to={`/events/${event.id}`}>
      <div className="event-mobile-card__head">
        <EventCompanyIdentity event={event} />
        <PriorityBadge priority={event.priority} />
      </div>
      <div className="event-mobile-card__badges">
        <EventTypeBadge type={event.detailType} />
        <EventStateBadge
          submissionKind={event.submissionKind}
          effectiveState={event.effectiveState}
        />
        <EvidenceBadge grade={event.evidenceGrade} />
      </div>
      {event.detailType === 'NEWS' ? (
        <TranslatedText
          title={event.title}
          description={event.summary}
          translation={event.translation}
        />
      ) : (
        <p>{event.summary}</p>
      )}
      <dl className="inline-facts">
        {event.detailType !== 'SEC' ? (
          <>
            <div>
              <dt>성격</dt>
              <dd>
                <NatureBadge nature={event.nature} />
              </dd>
            </div>
            <div>
              <dt>방향</dt>
              <dd>
                <DirectionBadge direction={event.direction} />
              </dd>
            </div>
            <div>
              <dt>사건일</dt>
              <dd>{formatDate(event.eventAt)}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>내용</dt>
            <dd>공시 접수 메타데이터</dd>
          </div>
        )}
        <div>
          <dt>{event.rceptDate ? '공시 접수일' : '게시 시각'}</dt>
          <dd>{event.rceptDate ? formatDate(event.rceptDate) : formatKst(event.publishedAt)}</dd>
        </div>
      </dl>
    </Link>
  );
}
