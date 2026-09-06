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

/** Company relevance is independent of the source's publisher kind and rights. */
@Entity({ name: 'news_source_companies' })
@Unique('ux_news_source_company', ['sourceItemId', 'companyId'])
@Index('ix_news_company_source', ['companyId', 'sourceItemId'])
export class NewsSourceCompanyEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @Column({ name: 'source_item_id', type: 'char', length: 36 }) sourceItemId!: string;
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ name: 'match_method', type: 'varchar', length: 40 }) matchMethod!: string;
  @Column({ name: 'input_hash', type: 'char', length: 64 }) inputHash!: string;
  @Column({ name: 'matcher_version', type: 'int', unsigned: true }) matcherVersion!: number;
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt!: Date;
}
