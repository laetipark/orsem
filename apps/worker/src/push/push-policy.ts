import { AlertStatus, EventState, EventType, SubmissionKind } from '@orsem/contracts';
import type { AlertEntity, EventClusterEntity } from '@orsem/database';

export type PushTopic = 'FILINGS' | 'ANALYSIS' | 'CORRECTIONS' | 'NEWS' | 'OPERATIONS' | 'TEST';
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}
export const PUSH_MAX_AGE_MS = 24 * 60 * 60_000;

export function pushTopicForAlert(
  alert: AlertEntity,
  event: EventClusterEntity | null,
  submissionKind: string | null,
): PushTopic | null {
  if (alert.status === AlertStatus.CANCELLED) return null;
  const phase = alert.payloadJson.phase;
  if (alert.eventClusterId === null) return phase === 'OPERATIONAL' ? 'OPERATIONS' : null;
  if (!event || event.state === EventState.CANCELLED || event.state === EventState.SUPERSEDED)
    return null;
  if (phase !== 'DETECTED' && phase !== 'PARSED') return null;
  if (
    event.canonicalEventType === EventType.CORRECTION ||
    new Set<string>([
      SubmissionKind.CORRECTION,
      SubmissionKind.ATTACHMENT_CORRECTION,
      SubmissionKind.WITHDRAWAL,
    ]).has(submissionKind ?? '')
  )
    return 'CORRECTIONS';
  return phase === 'PARSED' ? 'ANALYSIS' : 'FILINGS';
}

export function isRecentPushEvent(at: Date, now: Date): boolean {
  return (
    Number.isFinite(at.getTime()) &&
    at.getTime() >= now.getTime() - PUSH_MAX_AGE_MS &&
    at.getTime() <= now.getTime()
  );
}

export function pushPreferenceAllows(input: {
  ownerKey: string;
  subscriptionOwnerKey: string;
  ownerAuthorized: boolean;
  enabled: boolean;
  topics: readonly string[];
  topic: PushTopic;
  watchlistOnly: boolean;
  watchlisted: boolean;
}): boolean {
  if (!input.ownerAuthorized || !input.enabled || input.ownerKey !== input.subscriptionOwnerKey)
    return false;
  if (input.topic === 'TEST') return true;
  if (!input.topics.includes(input.topic)) return false;
  if (input.topic === 'OPERATIONS') return input.ownerKey.startsWith('ADMIN:');
  return !input.watchlistOnly || input.watchlisted;
}

function shortText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? Array.from(value.replace(/[\r\n\t]+/gu, ' ').trim())
        .slice(0, max)
        .join('')
    : '';
}

export function alertPushMessage(alert: AlertEntity, topic: PushTopic): PushMessage {
  const labels: Record<PushTopic, string> = {
    FILINGS: '새 공시',
    ANALYSIS: '공시 분석 완료',
    CORRECTIONS: '정정·철회 공시',
    NEWS: '새 뉴스',
    OPERATIONS: '운영 상태 알림',
    TEST: '테스트 알림',
  };
  const company = shortText(alert.payloadJson.companyName, 30);
  const summary =
    shortText(alert.payloadJson.summary, 160) || shortText(alert.payloadJson.reportName, 160);
  return {
    title: `오름셈 · ${labels[topic]}${company ? ` · ${company}` : ''}`,
    body:
      topic === 'OPERATIONS'
        ? '연결 상태가 변경되었습니다. 운영 화면에서 확인해 주세요.'
        : summary || '새 관찰 결과를 확인해 주세요.',
    url: topic === 'OPERATIONS' ? '/operations' : `/events/${alert.eventClusterId}`,
    tag: `alert-${alert.id}`,
  };
}

export function newsPushMessage(id: string, title: string): PushMessage {
  return {
    title: '오름셈 · 새 뉴스',
    body: shortText(title, 160),
    url: `/search?type=news&q=${encodeURIComponent(shortText(title, 100))}`,
    tag: `news-${id}`,
  };
}

export function pushMessageIsSafe(payload: unknown): payload is PushMessage {
  if (!payload || typeof payload !== 'object') return false;
  const row = payload as Record<string, unknown>;
  return (
    Object.keys(row).every((key) => ['title', 'body', 'url', 'tag'].includes(key)) &&
    typeof row.title === 'string' &&
    row.title.length > 0 &&
    row.title.length <= 300 &&
    typeof row.body === 'string' &&
    row.body.length <= 600 &&
    typeof row.tag === 'string' &&
    /^[a-zA-Z0-9:_-]{1,180}$/u.test(row.tag) &&
    typeof row.url === 'string' &&
    row.url.length <= 1600 &&
    /^\/(?:events\/[a-f0-9-]{36}|operations|notifications|settings\/notifications|search\?type=news&q=[^\s#]*)$/u.test(
      row.url,
    ) &&
    !row.url.includes('\\') &&
    !Array.from(row.url).some((character) => character.charCodeAt(0) < 32)
  );
}
