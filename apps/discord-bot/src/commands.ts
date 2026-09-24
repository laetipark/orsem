import { SlashCommandBuilder } from 'discord.js';
import { displayDisclosureText } from '@orsem/contracts';

export const orsemCommand = new SlashCommandBuilder()
  .setName('orsem')
  .setDescription('오르셈 관찰 시스템을 조회합니다')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('market')
      .setDescription('매월 갱신되는 국내·미국 시가총액 상위 20개 종목을 조회합니다')
      .addStringOption((option) =>
        option
          .setName('region')
          .setDescription('시장')
          .setRequired(true)
          .addChoices({ name: '국내', value: 'kr' }, { name: '미국', value: 'us' }),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('news')
      .setDescription('시장 상위 종목의 뉴스 제목·요약과 원문을 조회합니다')
      .addStringOption((option) =>
        option
          .setName('region')
          .setDescription('시장')
          .addChoices(
            { name: '전체', value: 'all' },
            { name: '국내', value: 'kr' },
            { name: '미국', value: 'us' },
          ),
      )
      .addIntegerOption((option) =>
        option.setName('limit').setDescription('표시 개수').setMinValue(1).setMaxValue(5),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('status').setDescription('수집기와 검토 큐 상태를 확인합니다'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('recent')
      .setDescription('최근 중요 이벤트를 확인합니다')
      .addIntegerOption((option) =>
        option.setName('limit').setDescription('표시 개수').setMinValue(1).setMaxValue(10),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('company')
      .setDescription('회사별 최근 이벤트를 조회합니다')
      .addStringOption((option) =>
        option.setName('query').setDescription('회사명 또는 종목코드').setRequired(true),
      ),
  );

export interface StatusResponse {
  summary: string;
  asOf: string;
}

export interface RecentResponse {
  items: Array<{
    company: string;
    type: string;
    summary: string;
    observedAt: string;
    url?: string;
  }>;
}

export function formatStatus(value: StatusResponse): string {
  return [`**오르셈 운영 상태**`, value.summary, `기준: ${formatKst(value.asOf)}`].join('\n');
}

export function formatRecent(value: RecentResponse, heading = '최근 중요 이벤트'): string {
  if (value.items.length === 0) return `**${heading}**\n새 이벤트가 없습니다.`;
  const rows = value.items.map((item) => {
    const url = safeUrl(item.url);
    const link = url ? ` · 공식 원문 <${url}>` : '';
    return `• **${line(item.company, 60)}** · ${line(displayDisclosureText(item.type), 40)}\n  ${line(displayDisclosureText(item.summary), 160)}\n  ${formatKst(item.observedAt)}${link}`;
  });
  return [`**${heading}**`, ...rows, '_관찰 정보이며 단독 매매 신호가 아닙니다._'].join('\n');
}

export interface MarketResponse {
  region: 'kr' | 'us';
  label: string;
  basisDate: string | null;
  selectionMonth?: string | null;
  nextRefreshAt?: string | null;
  refreshCadence?: 'MONTHLY';
  sourceName?: string | null;
  status?: string;
  reason?: string | null;
  items: Array<{
    rank: number;
    id: string;
    nameKo: string;
    market: string;
    stockCode: string | null;
    ticker: string | null;
  }>;
}

export interface NewsResponse {
  items: Array<{
    title: string;
    description: string | null;
    url: string;
    sourceName: string;
    publishedAt: string | null;
    translationStatus?: 'PENDING' | 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';
    relatedCompanies: Array<{ nameKo: string; stockCode: string | null; ticker: string | null }>;
  }>;
}

function line(value: string, max: number): string {
  const text = value
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .replace(/([\\`*_~|[\]()<>])/gu, '\\$1');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function safeUrl(value: string | undefined): string | null {
  try {
    if (!value || !/^https?:\/\//iu.test(value) || /[\s\\<>]/u.test(value)) return null;
    const url = new URL(value);
    return !url.username && !url.password && url.href.length <= 1500 ? url.href : null;
  } catch {
    return null;
  }
}

export function formatKst(value: string | null): string {
  if (!value) return '발행 시각 미제공';
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value} KST`;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value.endsWith(' KST') ? value : '발행 시각 미제공';
  return `${new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)} KST`;
}

export function formatMarket(value: MarketResponse): string {
  const rows = value.items
    .filter((item) => item.rank >= 1 && item.rank <= 20)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 20);
  return [
    `**${value.region === 'kr' ? '국내' : '미국'} 시가총액 상위 20**`,
    `기준일: ${value.basisDate ?? '확인 대기'} · 월간 갱신`,
    ...(value.selectionMonth ? [`선정 월: ${value.selectionMonth}`] : []),
    ...(value.nextRefreshAt ? [`다음 갱신: ${formatKst(value.nextRefreshAt)}`] : []),
    ...(value.sourceName ? [`출처: ${line(value.sourceName, 60)}`] : []),
    ...(value.status !== 'AVAILABLE' && value.reason ? [line(value.reason, 100)] : []),
    ...rows.map(
      (item) =>
        `${item.rank}. ${line(item.nameKo, 48)} (${line(item.stockCode ?? item.ticker ?? '', 16)})`,
    ),
    ...(!rows.length ? ['확정된 시장 목록이 없습니다.'] : []),
  ].join('\n');
}

export function formatNews(value: NewsResponse): string[] {
  const messages = value.items.slice(0, 5).flatMap((item) => {
    const url = safeUrl(item.url);
    if (!url) return [];
    const compact = url.length > 1000;
    const companies = item.relatedCompanies
      .slice(0, 2)
      .map((company) => company.nameKo)
      .join(', ');
    const more =
      item.relatedCompanies.length > 2 ? ` 외 ${item.relatedCompanies.length - 2}개` : '';
    const status =
      item.translationStatus === 'PENDING'
        ? ' · 원문, 번역 대기'
        : item.translationStatus === 'FAILED'
          ? ' · 원문, 번역 실패'
          : '';
    return [
      [
        `**${line(item.title, compact ? 80 : 180)}**`,
        line(item.description?.trim() || '요약 미제공', compact ? 100 : 240),
        ...(companies ? [`관련 종목: ${line(companies + more, compact ? 50 : 100)}`] : []),
        `${line(item.sourceName, 35)} · ${formatKst(item.publishedAt)}${status}`,
        `원문 <${url}>`,
      ].join('\n'),
    ];
  });
  return messages.length ? messages : ['시장 상위 종목 뉴스\n표시할 뉴스가 없습니다.'];
}
