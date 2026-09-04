import { z } from 'zod';

const deliverySchema = z.object({
  deliveryId: z.string(),
  alertId: z.string(),
  operation: z.enum(['SEND', 'EDIT', 'FOLLOW_UP']).default('SEND'),
  stage: z.enum(['DETECTED', 'ENRICHED', 'DIGEST']),
  content: z.string().min(1).max(2_000),
  externalMessageId: z.string().nullable().optional(),
});

const pullSchema = z.object({
  items: z.array(deliverySchema),
  leaseSeconds: z.number().int().positive(),
});

export type DiscordDelivery = z.infer<typeof deliverySchema>;

export class OrsemBotApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async command<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.request<T>(url, { method: 'GET' });
  }

  async pull(): Promise<DiscordDelivery[]> {
    const result = await this.request<unknown>(new URL(`${this.baseUrl}/outbox/pull`), {
      method: 'POST',
      body: JSON.stringify({ limit: 10, leaseSeconds: 60 }),
    });
    return pullSchema.parse(result).items;
  }

  async acknowledge(
    deliveryId: string,
    result: { ok: true; externalMessageId: string } | { ok: false; error: string },
  ): Promise<void> {
    await this.request(new URL(`${this.baseUrl}/outbox/${encodeURIComponent(deliveryId)}/ack`), {
      method: 'POST',
      body: JSON.stringify(result),
    });
  }

  private async request<T>(url: URL, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Orsem API ${response.status}: ${message.slice(0, 240)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
