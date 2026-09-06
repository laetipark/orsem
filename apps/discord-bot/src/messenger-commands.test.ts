import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function bridge() {
  const requests: Array<{ method: string; path: string; payload: unknown }> = [];
  const listeners: Record<string, (message: unknown) => void> = {};
  const context: Record<string, unknown> = {
    BotManager: {
      getCurrentBot: () => ({
        addListener: (name: string, listener: (message: unknown) => void) => {
          listeners[name] = listener;
        },
      }),
    },
    Event: { MESSAGE: 'message' },
    Database: {
      exists: () => true,
      readObject: (file: string) =>
        file.includes('config')
          ? { apiBaseUrl: 'https://example.com/api/v1/bots/messenger' }
          : {
              deviceId: 'device',
              deviceToken: 'private-token',
              boundRoom: 'bound',
              boundAuthorHash: 'admin',
              seenDeliveryIds: [],
            },
      writeObject: vi.fn(),
    },
    setInterval: vi.fn(),
    console: { info: vi.fn() },
  };
  runInNewContext(
    readFileSync(resolve(__dirname, '../../../integrations/messengerbot-r/orsem-api2.js'), 'utf8'),
    context,
  );
  context.requestJson = (
    method: string,
    path: string,
    payload: unknown,
    _token: string,
    callback: (error: null, result: unknown) => void,
  ) => {
    requests.push({ method, path, payload });
    callback(null, { message: '서버 메타데이터 응답' });
  };
  return { requests, onMessage: listeners.message! };
}

describe('MessengerBotR regional commands', () => {
  it.each([
    ['/오르셈 시장 국내', 'MARKET', 'kr'],
    ['/오르셈 시장 미국', 'MARKET', 'us'],
    ['/오르셈 시장', 'MARKET', 'kr'],
    ['/오르셈 뉴스', 'NEWS', 'all'],
    ['/오르셈 뉴스 미국', 'NEWS', 'us'],
    ['/오르셈 뉴스 한국', 'NEWS', 'kr'],
    ['/오르셈 종목 0000D0', 'COMPANY', '0000D0'],
  ])('routes %s with no network or message delivery', (content, command, query) => {
    const { requests, onMessage } = bridge();
    const reply = vi.fn();
    onMessage({ content, room: 'bound', author: { hash: 'admin' }, reply });
    expect(requests).toEqual([
      { method: 'POST', path: '/command', payload: { deviceId: 'device', command, query } },
    ]);
    expect(reply).toHaveBeenCalledWith('서버 메타데이터 응답');
  });

  it('preserves bound sender/room authorization and rejects unsupported market scope', () => {
    const { requests, onMessage } = bridge();
    const reply = vi.fn();
    onMessage({ content: '/오르셈 뉴스', room: 'other', author: { hash: 'admin' }, reply });
    onMessage({ content: '/오르셈 뉴스', room: 'bound', author: { hash: 'other' }, reply });
    onMessage({ content: '/오르셈 시장 전체', room: 'bound', author: { hash: 'admin' }, reply });
    expect(requests).toEqual([]);
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('연결된 관리자'));
    expect(reply).toHaveBeenCalledWith(expect.stringContaining('/오르셈 시장'));
  });
});
