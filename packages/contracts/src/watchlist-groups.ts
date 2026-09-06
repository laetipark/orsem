import { z } from 'zod';
import { companySchema } from './schemas';

export const OPERATIONAL_WATCHLIST_GROUP_ID = 'operational';
export const watchlistGroupIdSchema = z.union([
  z.uuid(),
  z.literal(OPERATIONAL_WATCHLIST_GROUP_ID),
]);
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
export const createWatchlistGroupSchema = z.object({ name: nameSchema }).strict();
export const updateWatchlistGroupSchema = z
  .object({ name: nameSchema.optional(), isShared: z.boolean().optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export const watchlistGroupPageQuerySchema = z
  .object({
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
    limit: z.coerce.number().int().min(1).max(21).default(21),
  })
  .strict();
const distinctIds = z
  .array(z.uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
export const reorderWatchlistGroupsSchema = z.object({ ids: distinctIds }).strict();
export const reorderWatchlistGroupItemsSchema = z
  .object({ companyIds: distinctIds.max(21) })
  .strict();
export const addWatchlistGroupItemSchema = z.object({ companyId: z.uuid() }).strict();
export const watchlistGroupSchema = z.object({
  id: watchlistGroupIdSchema,
  name: z.string(),
  kind: z.enum(['PERSONAL', 'ROOM', 'LEGACY']),
  roomId: z.uuid().nullable().optional(),
  revision: z.number().int().nonnegative().optional(),
  canManageGroups: z.boolean().optional(),
  canManageStocks: z.boolean().optional(),
  canManageMembers: z.boolean().optional(),
  isShared: z.boolean(),
  isFollowing: z.boolean(),
  canEdit: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  ownerLabel: z.string(),
  updatedAt: z.iso.datetime(),
});
export type WatchlistGroup = z.infer<typeof watchlistGroupSchema>;
export const watchlistGroupsSchema = z.object({ items: z.array(watchlistGroupSchema) });
export const sharedWatchlistGroupsSchema = watchlistGroupsSchema.extend({
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(),
});
export const companyWatchlistMembershipSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(['PERSONAL', 'ROOM']),
  roomId: z.uuid().nullable(),
  roomName: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  selected: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  canManageStocks: z.boolean(),
});
export type CompanyWatchlistMembership = z.infer<typeof companyWatchlistMembershipSchema>;
export const companyWatchlistMembershipsSchema = z.object({
  companyId: z.uuid(),
  items: z.array(companyWatchlistMembershipSchema),
});
export type CompanyWatchlistMemberships = z.infer<typeof companyWatchlistMembershipsSchema>;
export const saveCompanyWatchlistMembershipsSchema = z
  .object({
    changes: z
      .array(
        z
          .object({
            groupId: z.uuid(),
            revision: z.number().int().nonnegative(),
            selected: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (changes) => new Set(changes.map((change) => change.groupId)).size === changes.length,
      ),
  })
  .strict();
export type SaveCompanyWatchlistMemberships = z.infer<typeof saveCompanyWatchlistMembershipsSchema>;
export const groupDisplayPriceSchema = z.object({
  price: z.string().nullable(),
  currency: z.enum(['KRW', 'USD']).nullable(),
  status: z.enum(['NOT_CONFIGURED', 'WAITING', 'LIVE', 'STALE', 'UNAVAILABLE']),
  basis: z.enum(['LIVE', 'STALE', 'CLOSE', 'NONE']),
  source: z.string().nullable(),
  sessionDate: z.iso.date().nullable(),
  providerAt: z.iso.datetime().nullable(),
  referenceClose: z.number().nullable(),
  referenceDate: z.iso.date().nullable(),
  change: z.number().nullable(),
  changePercent: z.number().nullable(),
});
export type GroupDisplayPrice = z.infer<typeof groupDisplayPriceSchema>;
export const groupActivitySchema = z.object({
  id: z.uuid(),
  kind: z.enum(['FILING', 'EVENT']),
  title: z.string(),
  date: z.iso.date(),
  eventDate: z.iso.date().nullable().optional(),
  url: z.string(),
});
export type GroupActivity = z.infer<typeof groupActivitySchema>;
export const watchlistGroupItemViewSchema = z.object({
  company: companySchema,
  displayPrice: groupDisplayPriceSchema,
  sparkline: z.array(z.object({ sessionDate: z.iso.date(), close: z.number().positive() })).max(20),
  recentActivity: z.object({
    filingCount: z.number().int().nonnegative(),
    eventCount: z.number().int().nonnegative(),
    items: z.array(groupActivitySchema).max(3),
  }),
});
export type WatchlistGroupItemView = z.infer<typeof watchlistGroupItemViewSchema>;
export const watchlistGroupItemsSchema = z.object({
  group: watchlistGroupSchema,
  items: z.array(watchlistGroupItemViewSchema).max(21),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(),
  asOf: z.iso.datetime(),
  windowStartDate: z.iso.date(),
  windowEndDate: z.iso.date(),
});
export type WatchlistGroupItems = z.infer<typeof watchlistGroupItemsSchema>;
