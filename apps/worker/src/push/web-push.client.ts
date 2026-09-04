import { Inject, Injectable } from '@nestjs/common';
import { isAllowedPushEndpoint } from '@orsem/contracts';
import type { PushSubscriptionEntity } from '@orsem/database';
import * as webPush from 'web-push';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import { pushMessageIsSafe, type PushMessage } from './push-policy';

export const WEB_PUSH_SEND = Symbol('WEB_PUSH_SEND');
export type WebPushSend = typeof webPush.sendNotification;
export const defaultWebPushSend: WebPushSend = (subscription, payload, options) =>
  webPush.sendNotification(subscription, payload, options);

export class PushRequestError extends Error {
  constructor(
    readonly statusCode: number | null,
    readonly retryAfter: string | null,
  ) {
    super(statusCode === null ? 'Web Push request failed.' : `Web Push HTTP ${statusCode}.`);
  }
}

@Injectable()
export class WebPushClient {
  constructor(
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    @Inject(WEB_PUSH_SEND) private readonly sendNotification: WebPushSend,
  ) {}
  get enabled(): boolean {
    return this.config.webPush.enabled;
  }

  async send(
    subscription: PushSubscriptionEntity,
    payload: PushMessage,
    ttl: number,
  ): Promise<void> {
    const config = this.config.webPush;
    if (!config.enabled || !config.subject || !config.publicKey || !config.privateKey)
      throw new PushRequestError(null, null);
    if (!isAllowedPushEndpoint(subscription.endpoint) || !pushMessageIsSafe(payload))
      throw new PushRequestError(400, null);
    try {
      const result = await this.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: config.subject,
            publicKey: config.publicKey,
            privateKey: config.privateKey,
          },
          TTL: Math.max(0, Math.min(86400, Math.floor(ttl))),
          timeout: Math.min(this.config.httpTimeoutMs, 15_000),
          urgency: 'normal',
          contentEncoding: 'aes128gcm',
        },
      );
      // web-push uses node:https.request and does not follow redirect responses.
      // Treat every non-2xx response, including redirects, as a failed send.
      if (result.statusCode < 200 || result.statusCode >= 300)
        throw new PushRequestError(result.statusCode, null);
    } catch (error) {
      if (error instanceof PushRequestError) throw error;
      const row = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
      const status = typeof row.statusCode === 'number' ? row.statusCode : null;
      const headers =
        row.headers && typeof row.headers === 'object'
          ? (row.headers as Record<string, unknown>)
          : {};
      const retryAfter = typeof headers['retry-after'] === 'string' ? headers['retry-after'] : null;
      // Never surface endpoint URLs, keys, response bodies, or raw network errors.
      throw new PushRequestError(status, retryAfter);
    }
  }
}
