import { SlashCommandBuilder } from 'discord.js';

export const orsemCommand = new SlashCommandBuilder()
  .setName('orsem')
  .setDescription('오르셈 관찰 시스템을 조회합니다')
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
  return [`**오르셈 운영 상태**`, value.summary, `기준: ${value.asOf}`].join('\n');
}

export function formatRecent(value: RecentResponse, heading = '최근 중요 이벤트'): string {
  if (value.items.length === 0) return `**${heading}**\n새 이벤트가 없습니다.`;
  const rows = value.items.map((item) => {
    const link = item.url ? ` · [공식 원문](${item.url})` : '';
    return `• **${item.company}** · ${item.type}\n  ${item.summary}\n  ${item.observedAt}${link}`;
  });
  return [`**${heading}**`, ...rows, '_관찰 정보이며 단독 매매 신호가 아닙니다._'].join('\n');
}
