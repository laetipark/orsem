import { z } from 'zod';

export const watchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((s) => Array.from(s).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
export const watchRevisionSchema = z.number().int().nonnegative();
export const watchScopeSchema = z.object({ roomId: z.uuid().optional() }).strict();
export const roomCreateSchema = z
  .object({ name: watchNameSchema, description: z.string().trim().max(500).default('') })
  .strict();
export const roomUpdateSchema = roomCreateSchema.extend({ revision: watchRevisionSchema });
export const roomMemberUpdateSchema = z
  .object({
    role: z.enum(['ADMIN', 'MEMBER']),
    canManageGroups: z.boolean(),
    canManageStocks: z.boolean(),
    revision: watchRevisionSchema,
  })
  .strict();
export const watchActorKeySchema = z.string().regex(/^(ADMIN|MEMBER):[0-9a-f-]{36}$/i);
export const watchIdsSchema = z
  .array(z.uuid())
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length);
export const groupCreateV2Schema = z
  .object({ name: watchNameSchema, roomId: z.uuid().optional() })
  .strict();
export const groupSaveSchema = watchScopeSchema
  .extend({
    revision: watchRevisionSchema,
    groups: z.array(z.object({ id: z.uuid(), name: watchNameSchema }).strict()).max(20),
  })
  .refine((v) => new Set(v.groups.map((g) => g.id)).size === v.groups.length);
export const groupItemsSaveSchema = z
  .object({ revision: watchRevisionSchema, companyIds: watchIdsSchema })
  .strict();
export const groupCopySchema = z
  .object({ roomId: z.uuid(), revision: watchRevisionSchema })
  .strict();
export interface WatchPermissions {
  canManageGroups: boolean;
  canManageStocks: boolean;
  canManageMembers: boolean;
}
export interface WatchRoom extends WatchPermissions {
  id: string;
  name: string;
  description: string;
  ownerLabel: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  revision: number;
  memberCount: number;
}
export interface WatchRoomMember {
  actorKey: string;
  label: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  canManageGroups: boolean;
  canManageStocks: boolean;
  active: boolean;
}
export interface WatchRoomDetail extends WatchRoom {
  members: WatchRoomMember[];
  requests: Array<{ actorKey: string; label: string; requestedAt: string }>;
}
export interface WatchRoomDirectory {
  items: Array<{
    id: string;
    name: string;
    description: string;
    ownerLabel: string;
    requestStatus: 'PENDING' | 'ACTIVE' | null;
  }>;
  nextOffset: number | null;
}
