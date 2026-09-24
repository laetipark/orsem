import { Link } from 'react-router-dom';
import { formatDate, formatKst } from '../lib/format';
import type { PersonalFiling } from '../types';
import { NewsCompanyBadges } from './market-news';
import './filing-feed-list.css';

export function FilingFeedList({
  items,
  externalCompanies = false,
}: {
  items: readonly PersonalFiling[];
  externalCompanies?: boolean;
}) {
  return (
    <ul className="filing-feed">
      {items.map((item) => (
        <li className="filing-feed__item" key={item.id}>
          <Link className="filing-feed__headline" to={item.url} title={item.title}>
            <strong>{item.summaryTitle || item.title}</strong>
          </Link>
          <div className="filing-feed__details">
            <NewsCompanyBadges companies={item.relatedCompanies} external={externalCompanies} />
            <div className="filing-feed__meta">
              <span>{item.source === 'SEC' ? 'SEC' : 'OpenDART'}</span>
              {item.eventDate ? (
                <time dateTime={item.eventDate}>거래 {formatDate(item.eventDate)}</time>
              ) : null}
              {item.filingDate ? (
                <time dateTime={item.filingDate}>접수 {formatDate(item.filingDate)}</time>
              ) : item.publishedAt ? (
                <time dateTime={item.publishedAt}>발행 {formatKst(item.publishedAt)}</time>
              ) : (
                <time dateTime={item.firstObservedAt}>수집 {formatKst(item.firstObservedAt)}</time>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
