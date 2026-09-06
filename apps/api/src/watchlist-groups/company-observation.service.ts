import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { type Company, type GroupActivity, type WatchlistGroupItems } from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  groupDisplayPrice,
  marketDate,
  recentKstWindow,
  type StoredGroupClose,
} from './watchlist-group-observations';
import { sqlBoolean } from './watchlist-access.service';
const marks = (ids: unknown[]) => ids.map(() => '?').join(',');
const number = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
@Injectable()
export class CompanyObservationService {
  constructor(
    private readonly database: DatabaseRuntimeService,
    private readonly sessions: SessionRuntimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  async observe(manager: EntityManager, companies: Company[], now = new Date()) {
    const window = recentKstWindow(now),
      ids = companies.map((c) => c.id);
    const configured = Boolean(this.config.tossClientId && this.config.tossClientSecret);
    const [cache, closes, activity] = await Promise.all([
      configured
        ? this.sessions.readMarketQuotes(ids)
        : Promise.resolve({ available: false, values: ids.map(() => null) }),
      this.closes(manager, ids, now),
      this.activity(manager, ids, window),
    ]);
    return {
      asOf: now.toISOString(),
      windowStartDate: window.start,
      windowEndDate: window.end,
      items: companies.map((company, index) => {
        const bars = closes.get(company.id) ?? [];
        return {
          company,
          displayPrice: groupDisplayPrice(
            company,
            { available: cache.available, value: cache.values[index] ?? null },
            bars,
            configured,
            now,
          ),
          sparkline: bars.slice(0, 20).reverse(),
          recentActivity: activity.get(company.id) ?? { filingCount: 0, eventCount: 0, items: [] },
        };
      }),
    };
  }
  async price(company: Company, cached: { available: boolean; value: string | null }, now: Date) {
    const bars = await this.closes(this.database.requireDataSource().manager, [company.id], now);
    return groupDisplayPrice(
      company,
      cached,
      bars.get(company.id) ?? [],
      Boolean(this.config.tossClientId && this.config.tossClientSecret),
      now,
    );
  }
  async recent(companyId: string, limit = 3) {
    const window = recentKstWindow(new Date());
    const values = await this.activity(
      this.database.requireDataSource().manager,
      [companyId],
      window,
      limit,
    );
    return {
      windowStartDate: window.start,
      windowEndDate: window.end,
      ...(values.get(companyId) ?? { filingCount: 0, eventCount: 0, items: [] }),
    };
  }
  async closes(
    manager: EntityManager,
    ids: string[],
    now: Date,
  ): Promise<Map<string, StoredGroupClose[]>> {
    if (!ids.length) return new Map();
    // The feed has no final-bar flag: include only prior market dates, even after today's close.
    // This matches the existing previousDailyCloses safety boundary and avoids partial daily bars.
    const rows: Array<{ company_id: string; session_date: string; close: string }> =
      await manager.query(
        `WITH sessions AS (
      SELECT b.company_id,b.session_date,b.close,b.bar_at,b.id,
      ROW_NUMBER() OVER(PARTITION BY b.company_id,b.session_date ORDER BY b.bar_at DESC,b.id DESC) sessionRow
      FROM price_bars b JOIN companies c ON c.id=b.company_id
      WHERE b.company_id IN (${marks(ids)}) AND b.interval='1d' AND b.rights_mode='PRIVATE_DISPLAY_ONLY' AND b.close>0
      AND ((c.market IN ('KRX','KOSPI','KOSDAQ','KONEX') AND b.source='TOSS_KR' AND b.currency='KRW' AND b.session_date<?)
        OR (c.market IN ('NASDAQ','NYSE','AMEX') AND b.source='TOSS_US' AND b.currency='USD' AND b.session_date<?))
      ), ranked AS (SELECT company_id,session_date,close,ROW_NUMBER() OVER(PARTITION BY company_id ORDER BY session_date DESC) rn FROM sessions WHERE sessionRow=1)
      SELECT company_id,session_date,close FROM ranked WHERE rn<=21 ORDER BY company_id,session_date DESC`,
        [...ids, marketDate(now), marketDate(now, 'us')],
      );
    const map = new Map<string, StoredGroupClose[]>();
    for (const row of rows) {
      const bars = map.get(row.company_id) ?? [];
      bars.push({ sessionDate: row.session_date, close: Number(row.close) });
      map.set(row.company_id, bars);
    }
    return map;
  }
  async activity(
    manager: EntityManager,
    ids: string[],
    window: ReturnType<typeof recentKstWindow>,
    limit = 3,
  ): Promise<Map<string, WatchlistGroupItems['items'][number]['recentActivity']>> {
    if (!ids.length) return new Map();
    const startUtc = window.startInstant.replace('T', ' ').replace('Z', '');
    const endUtc = window.endInstant.replace('T', ' ').replace('Z', '');
    const rows: Array<{
      id: string;
      company_id: string;
      kind: GroupActivity['kind'];
      title: string;
      date: string;
      url: string;
      kindCount: string;
      eventDate: string | null;
      displayable: number | boolean | string;
    }> = await manager.query(
      `WITH scoped AS (SELECT id FROM companies WHERE id IN (${marks(ids)})),
      recent_filings AS (
        SELECT f.id,f.company_id,'FILING' kind,f.report_name title,f.rcept_date date,CONCAT('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=',f.rcept_no) url,NULL eventDate
        FROM filings f JOIN scoped c ON c.id=f.company_id WHERE f.source='OPENDART' AND f.rcept_date BETWEEN ? AND ?
        UNION ALL
        SELECT DISTINCT s.id,e.company_id,'FILING',s.title,DATE(CONVERT_TZ(s.published_at,'+00:00','+09:00')),s.url,NULL
        FROM source_items s JOIN event_cluster_items ei ON ei.item_id=s.id AND ei.item_type='SOURCE_ITEM'
        JOIN event_clusters e ON e.id=ei.event_cluster_id JOIN scoped c ON c.id=e.company_id
        WHERE s.source='SEC' AND s.rights_mode='OFFICIAL_PUBLIC_DATA' AND s.published_at>=? AND s.published_at<?
      ), event_links AS (
        SELECT e.id,e.company_id,COALESCE(f.report_name,s.title) title,
          COALESCE(f.rcept_date,DATE(CONVERT_TZ(COALESCE(s.published_at,e.published_at),'+00:00','+09:00'))) date,
          DATE(CONVERT_TZ(e.occurred_at,'+00:00','+09:00')) eventDate,COALESCE(f.id,s.id) sourceId
        FROM event_clusters e JOIN scoped c ON c.id=e.company_id JOIN event_cluster_items ei ON ei.event_cluster_id=e.id
        LEFT JOIN filings f ON ei.item_type='FILING' AND f.id=ei.item_id AND f.source='OPENDART'
        LEFT JOIN news_items ni ON ei.item_type='NEWS_ITEM' AND ni.id=ei.item_id
        LEFT JOIN source_items s ON ((ei.item_type='SOURCE_ITEM' AND s.id=ei.item_id) OR s.id=ni.source_item_id)
          AND s.source<>'NAVER' AND ((s.rights_mode='OFFICIAL_PUBLIC_DATA' AND (s.source_policy_json IS NULL OR
            (JSON_UNQUOTE(JSON_EXTRACT(s.source_policy_json,'$.displayAllowed'))='true'
              AND JSON_UNQUOTE(JSON_EXTRACT(s.source_policy_json,'$.metadataStorageAllowed'))='true'))) OR
            (s.rights_mode IN ('PRIVATE_DISPLAY_ONLY','STORE_METADATA_ONLY','LINK_ONLY')
              AND JSON_UNQUOTE(JSON_EXTRACT(s.source_policy_json,'$.displayAllowed'))='true'
              AND JSON_UNQUOTE(JSON_EXTRACT(s.source_policy_json,'$.metadataStorageAllowed'))='true'))
        WHERE (f.rcept_date BETWEEN ? AND ?) OR (s.id IS NOT NULL AND COALESCE(s.published_at,e.published_at)>=? AND COALESCE(s.published_at,e.published_at)<?)
      ), recent_events AS (
        SELECT id,company_id,'EVENT' kind,MAX(title) title,MAX(date) date,CONCAT('/events/',id) url,MAX(eventDate) eventDate
        FROM event_links GROUP BY id,company_id
      ), activity AS (
        SELECT f.*,NOT EXISTS(SELECT 1 FROM event_links el WHERE el.company_id=f.company_id AND el.sourceId=f.id) displayable FROM recent_filings f
        UNION ALL SELECT e.*,1 displayable FROM recent_events e
      ), ranked AS (
        SELECT *,COUNT(*) OVER(PARTITION BY company_id,kind) kindCount,ROW_NUMBER() OVER(PARTITION BY company_id,kind ORDER BY displayable DESC,date DESC,id DESC) rn FROM activity
      ) SELECT id,company_id,kind,title,date,url,eventDate,displayable,kindCount FROM ranked WHERE rn<=? ORDER BY date DESC,id DESC`,
      [
        ...ids,
        window.start,
        window.end,
        startUtc,
        endUtc,
        window.start,
        window.end,
        startUtc,
        endUtc,
        limit,
      ],
    );
    const result = new Map<string, WatchlistGroupItems['items'][number]['recentActivity']>();
    for (const row of rows) {
      const value = result.get(row.company_id) ?? { filingCount: 0, eventCount: 0, items: [] };
      if (row.kind === 'FILING') value.filingCount = number(row.kindCount);
      else value.eventCount = number(row.kindCount);
      let url = `/companies/${row.company_id}`;
      if (row.kind === 'EVENT') url = `/events/${row.id}`;
      else {
        try {
          const parsed = new URL(row.url);
          if (
            parsed.protocol === 'https:' &&
            !parsed.username &&
            !parsed.password &&
            !parsed.port &&
            ((parsed.hostname === 'dart.fss.or.kr' &&
              parsed.pathname === '/dsaf001/main.do' &&
              /^\d{14}$/.test(parsed.searchParams.get('rcpNo') ?? '')) ||
              (['www.sec.gov', 'sec.gov'].includes(parsed.hostname) &&
                parsed.pathname.startsWith('/Archives/')))
          )
            url = parsed.toString();
        } catch {
          /* An invalid legacy source link falls back to the company page. */
        }
      }
      if (sqlBoolean(row.displayable))
        value.items.push({
          id: row.id,
          kind: row.kind,
          title: row.title,
          date: row.date,
          eventDate: row.eventDate ?? null,
          url,
        });
      result.set(row.company_id, value);
    }
    for (const value of result.values())
      value.items = value.items
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
        .slice(0, limit);
    return result;
  }
}
