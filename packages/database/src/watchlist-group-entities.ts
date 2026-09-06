import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

abstract class GroupRow {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt!: Date;
}
@Entity({ name: 'watchlist_groups' })
@Index('ix_watchlist_groups_owner', ['ownerKey', 'position'])
@Index('ix_watchlist_groups_shared', ['isShared', 'updatedAt'])
export class WatchlistGroupEntity extends GroupRow {
  @Column({ name: 'owner_key', type: 'varchar', length: 48 }) ownerKey!: string;
  @Column({ type: 'varchar', length: 80 }) name!: string;
  @Column({ name: 'is_shared', type: 'boolean', default: false }) isShared!: boolean;
  @Column({ name: 'room_id', type: 'char', length: 36, nullable: true }) roomId!: string | null;
  @Column({ type: 'int', unsigned: true, default: 0 }) revision!: number;
  @Column({ type: 'int', unsigned: true, default: 0 }) position!: number;
}
@Entity({ name: 'watchlist_group_items' })
@Unique('ux_watchlist_group_company', ['groupId', 'companyId'])
@Index('ix_watchlist_group_items_position', ['groupId', 'position'])
export class WatchlistGroupItemEntity extends GroupRow {
  @Column({ name: 'group_id', type: 'char', length: 36 }) groupId!: string;
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ type: 'int', unsigned: true, default: 0 }) position!: number;
}
@Entity({ name: 'watchlist_group_follows' })
@Unique('ux_watchlist_group_follow', ['groupId', 'ownerKey'])
@Index('ix_watchlist_group_follows_owner', ['ownerKey', 'position'])
export class WatchlistGroupFollowEntity extends GroupRow {
  @Column({ name: 'group_id', type: 'char', length: 36 }) groupId!: string;
  @Column({ name: 'owner_key', type: 'varchar', length: 48 }) ownerKey!: string;
  @Column({ type: 'int', unsigned: true, default: 0 }) position!: number;
}
export const WATCHLIST_GROUP_ENTITIES = [
  WatchlistGroupEntity,
  WatchlistGroupItemEntity,
  WatchlistGroupFollowEntity,
];
