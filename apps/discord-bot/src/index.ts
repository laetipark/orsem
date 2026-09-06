import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import { resolve } from 'node:path';
import { OrsemBotApiClient, type DiscordDelivery } from './api-client';
import {
  formatRecent,
  formatMarket,
  formatNews,
  formatStatus,
  orsemCommand,
  type RecentResponse,
  type MarketResponse,
  type NewsResponse,
  type StatusResponse,
} from './commands';
import { loadConfig } from './config';

try {
  process.loadEnvFile(resolve(__dirname, '../../../.env'));
} catch {
  // 운영에서는 로컬 .env 파일 없이 환경 변수를 주입할 수 있습니다.
}

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new OrsemBotApiClient(config.apiBaseUrl, config.serviceToken);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (readyClient) => {
    void (async () => {
      const rest = new REST({ version: '10' }).setToken(config.token);
      const body = [orsemCommand.toJSON()];
      const route = config.guildId
        ? Routes.applicationGuildCommands(config.applicationId, config.guildId)
        : Routes.applicationCommands(config.applicationId);
      await rest.put(route, { body });
      console.info(`[orsem-discord] ready as ${readyClient.user.tag}`);
      startOutboxPoller(client, api, config.channelId, config.pollIntervalMs);
    })().catch((error: unknown) => {
      console.error(
        '[orsem-discord] initialization failed',
        error instanceof Error ? error.message : error,
      );
      process.exitCode = 1;
    });
  });

  client.on(Events.InteractionCreate, (interaction) => {
    void (async () => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'orsem') return;
      if (config.allowedUserIds.size > 0 && !config.allowedUserIds.has(interaction.user.id)) {
        await interaction.reply({
          content: '허용된 관리자만 사용할 수 있습니다.',
          ephemeral: true,
        });
        return;
      }
      await handleCommand(interaction, api);
    })().catch((error: unknown) => {
      console.error(
        '[orsem-discord] interaction failed',
        error instanceof Error ? error.message : error,
      );
    });
  });

  await client.login(config.token);
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  api: OrsemBotApiClient,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  try {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'status') {
      const value = await api.command<StatusResponse>('status');
      await interaction.editReply(formatStatus(value));
      return;
    }
    if (subcommand === 'recent') {
      const limit = String(interaction.options.getInteger('limit') ?? 5);
      const value = await api.command<RecentResponse>('recent', { limit });
      await interaction.editReply(formatRecent(value));
      return;
    }
    if (subcommand === 'market') {
      const region = interaction.options.getString('region', true);
      const value = await api.command<MarketResponse>('market', { region });
      await interaction.editReply({ content: formatMarket(value), allowedMentions: { parse: [] } });
      return;
    }
    if (subcommand === 'news') {
      const region = interaction.options.getString('region') ?? 'all';
      const limit = String(interaction.options.getInteger('limit') ?? 5);
      const value = await api.command<NewsResponse>('news', { region, limit });
      const messages = formatNews(value);
      await interaction.editReply({ content: messages[0]!, allowedMentions: { parse: [] } });
      for (const content of messages.slice(1)) {
        await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
      }
      return;
    }
    const query = interaction.options.getString('query', true);
    const value = await api.command<RecentResponse>('company', { q: query });
    await interaction.editReply(formatRecent(value, `${query} 최근 이벤트`));
  } catch (error) {
    const message = error instanceof Error ? error.message : '알 수 없는 오류';
    console.error('[orsem-discord] command failed', message);
    await interaction.editReply('조회에 실패했습니다. 운영 화면에서 수집기 상태를 확인해 주세요.');
  }
}

function startOutboxPoller(
  client: Client,
  api: OrsemBotApiClient,
  channelId: string,
  intervalMs: number,
): void {
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased() || channel.type === ChannelType.DM || !('guildId' in channel)) {
        throw new Error(`Configured channel ${channelId} is not a guild text channel`);
      }
      for (const delivery of await api.pull()) {
        await deliver(channel as GuildTextBasedChannel, delivery, api);
      }
    } catch (error) {
      console.error(
        '[orsem-discord] outbox poll failed',
        error instanceof Error ? error.message : error,
      );
    } finally {
      running = false;
    }
  };
  void poll();
  setInterval(() => void poll(), intervalMs).unref();
}

async function deliver(
  channel: GuildTextBasedChannel,
  delivery: DiscordDelivery,
  api: OrsemBotApiClient,
): Promise<void> {
  try {
    let message;
    if (delivery.operation === 'EDIT' && delivery.externalMessageId && 'messages' in channel) {
      try {
        const existing = await channel.messages.fetch(delivery.externalMessageId);
        message = await existing.edit({
          content: delivery.content,
          allowedMentions: { parse: [] },
        });
      } catch {
        message = await channel.send({ content: delivery.content, allowedMentions: { parse: [] } });
      }
    } else {
      message = await channel.send({ content: delivery.content, allowedMentions: { parse: [] } });
    }
    await api.acknowledge(delivery.deliveryId, { ok: true, externalMessageId: message.id });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await api.acknowledge(delivery.deliveryId, { ok: false, error: reason.slice(0, 500) });
  }
}

void main().catch((error) => {
  console.error('[orsem-discord] fatal', error);
  process.exitCode = 1;
});
