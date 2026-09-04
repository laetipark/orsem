import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = {
  DISCORD_BOT_TOKEN: 'discord-token-long-enough',
  DISCORD_APPLICATION_ID: 'application-id',
  DISCORD_CHANNEL_ID: 'channel-id',
  DISCORD_SERVICE_TOKEN: 'service-token-with-at-least-32-characters',
};

describe('Discord configuration', () => {
  it('fails closed without an operator allowlist in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      /DISCORD_ALLOWED_USER_IDS/,
    );
  });

  it('parses an explicit production allowlist', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      DISCORD_ALLOWED_USER_IDS: 'operator-1,operator-2',
    });
    expect(config.allowedUserIds).toEqual(new Set(['operator-1', 'operator-2']));
  });
});
