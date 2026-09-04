import { z } from 'zod';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DISCORD_BOT_TOKEN: z.string().min(20),
    DISCORD_APPLICATION_ID: z.string().min(1),
    DISCORD_CHANNEL_ID: z.string().min(1),
    DISCORD_GUILD_ID: z.string().min(1).optional(),
    DISCORD_ALLOWED_USER_IDS: z.string().default(''),
    DISCORD_SERVICE_TOKEN: z.string().min(32),
    ORSEM_INTERNAL_API_URL: z.string().url().default('http://127.0.0.1:3210/api/v1/bots/discord'),
    DISCORD_POLL_INTERVAL_MS: z.coerce.number().int().min(2_000).max(60_000).default(5_000),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && !value.DISCORD_ALLOWED_USER_IDS.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['DISCORD_ALLOWED_USER_IDS'],
        message: 'DISCORD_ALLOWED_USER_IDS is required in production',
      });
    }
  });

export type DiscordBotConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(environment);
  return {
    token: parsed.DISCORD_BOT_TOKEN,
    applicationId: parsed.DISCORD_APPLICATION_ID,
    channelId: parsed.DISCORD_CHANNEL_ID,
    guildId: parsed.DISCORD_GUILD_ID,
    allowedUserIds: new Set(
      parsed.DISCORD_ALLOWED_USER_IDS.split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    serviceToken: parsed.DISCORD_SERVICE_TOKEN,
    apiBaseUrl: parsed.ORSEM_INTERNAL_API_URL.replace(/\/$/, ''),
    pollIntervalMs: parsed.DISCORD_POLL_INTERVAL_MS,
  };
}
