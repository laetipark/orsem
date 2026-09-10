import { z } from 'zod';
import { DisclosureDetailType } from './enums';

export const DEFAULT_NOTIFICATION_FILING_TYPES: DisclosureDetailType[] = ['D001', 'D002', 'D005'];

export const notificationTopicSchema = z.enum([
  'FILINGS',
  'ANALYSIS',
  'CORRECTIONS',
  'NEWS',
  'OPERATIONS',
]);
export type NotificationTopic = z.infer<typeof notificationTopicSchema>;
export const DEFAULT_NOTIFICATION_TOPICS: NotificationTopic[] = [
  'FILINGS',
  'ANALYSIS',
  'CORRECTIONS',
  'NEWS',
];
export const notificationPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    topics: z
      .array(notificationTopicSchema)
      .max(5)
      .refine((items) => new Set(items).size === items.length),
    watchlistOnly: z.boolean(),
    filingTypes: z
      .array(z.enum(DisclosureDetailType))
      .max(5)
      .refine((items) => new Set(items).size === items.length)
      .default(DEFAULT_NOTIFICATION_FILING_TYPES),
  })
  .strict();
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export function isAllowedPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      value.length > 2048
    )
      return false;
    const host = url.hostname;
    return (
      host === 'fcm.googleapis.com' ||
      host === 'android.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      /^[a-z0-9-]+\.push\.services\.mozilla\.com$/u.test(host) ||
      host === 'web.push.apple.com' ||
      /^[a-z0-9-]+\.push\.apple\.com$/u.test(host) ||
      /^[a-z0-9-]+\.notify\.windows\.com$/u.test(host)
    );
  } catch {
    return false;
  }
}

export const pushSubscriptionInputSchema = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine(isAllowedPushEndpoint, 'Unsupported push service endpoint'),
    expirationTime: z.number().int().positive().max(8_640_000_000_000_000).nullable().default(null),
    keys: z
      .object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/u),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
      })
      .strict(),
    deviceName: z.string().trim().min(1).max(80).default('이 브라우저'),
  })
  .strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionInputSchema>;
export const notificationTestSchema = z.object({ subscriptionId: z.string().uuid() }).strict();
export const notificationSettingsSchema = notificationPreferencesSchema.extend({
  pushConfigured: z.boolean(),
  publicKey: z.string().nullable(),
  subscriptions: z.array(
    z.object({
      id: z.string().uuid(),
      deviceName: z.string(),
      createdAt: z.string().datetime(),
      lastSeenAt: z.string().datetime(),
    }),
  ),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const companyNotificationInputSchema = z.object({ enabled: z.boolean() }).strict();
export const companyNotificationSettingsSchema = z.object({
  companyId: z.string().uuid(),
  // Company scope only. Global/topic/device/source gates still apply at delivery.
  enabled: z.boolean(),
  inherited: z.boolean(),
  globalEnabled: z.boolean(),
  pushConfigured: z.boolean(),
  hasActiveSubscription: z.boolean(),
});
export type CompanyNotificationSettings = z.infer<typeof companyNotificationSettingsSchema>;
