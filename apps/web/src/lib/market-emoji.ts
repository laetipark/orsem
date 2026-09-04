const assetEmojis: Readonly<Record<string, string>> = {
  gold: '🟡',
  silver: '⚪',
  wti: '🛢️',
  btc: '🪙',
  eth: '💎',
};

export function marketEmoji(id: string): string | null {
  return assetEmojis[id] ?? null;
}
