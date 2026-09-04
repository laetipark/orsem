import { Column, Entity, Generated, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import type { MarketInstrument, RightsMode } from '@orsem/contracts';
import { numericStringTransformer } from './transformers';

const instant = { type: 'datetime' as const, precision: 3 };
const decimal = {
  type: 'decimal' as const,
  precision: 30,
  scale: 10,
  transformer: numericStringTransformer,
};

@Entity({ name: 'market_instruments' })
export class MarketInstrumentEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 }) id!: string;
  @Column({ name: 'definition_json', type: 'json' }) definitionJson!: MarketInstrument;
  @UpdateDateColumn({ name: 'updated_at', ...instant }) updatedAt!: Date;
}

@Entity({ name: 'market_observations' })
@Index('ux_market_observation_period', ['instrumentId', 'kind', 'period'], { unique: true })
@Index('ix_market_observation_date', ['instrumentId', 'kind', 'sourceDate'])
export class MarketObservationEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @Column({ name: 'instrument_id', type: 'varchar', length: 32 }) instrumentId!: string;
  @Column({ type: 'varchar', length: 8 }) kind!: 'QUOTE' | 'DAILY';
  @Column({ type: 'varchar', length: 40 }) period!: string;
  @Column(decimal) value!: string;
  @Column({ name: 'source_date', type: 'date', nullable: true }) sourceDate!: string | null;
  @Column({ name: 'provider_at', ...instant, nullable: true }) providerAt!: Date | null;
  @Column({ name: 'first_observed_at', ...instant }) firstObservedAt!: Date;
  @Column({ name: 'last_observed_at', ...instant }) lastObservedAt!: Date;
  @Column({ type: 'varchar', length: 32 }) source!: string;
  @Column({ name: 'source_url', type: 'text' }) sourceUrl!: string;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
  @Column({ name: 'reference_value', ...decimal, nullable: true }) referenceValue!: string | null;
  @Column({ name: 'reference_date', type: 'date', nullable: true }) referenceDate!: string | null;
  @Column({ name: 'reference_label', type: 'varchar', length: 128, nullable: true })
  referenceLabel!: string | null;
  @Column({ name: 'raw_metadata_json', type: 'json', nullable: true }) rawMetadataJson!: Record<
    string,
    unknown
  > | null;
}
