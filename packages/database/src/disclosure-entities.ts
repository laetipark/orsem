import {
  Column,
  CreateDateColumn,
  Entity,
  Generated,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { FilingDocumentKind } from '@orsem/contracts';

const instant = { type: 'datetime' as const, precision: 3 };
abstract class DisclosureProjectionBase {
  @PrimaryColumn({ type: 'char', length: 36 }) @Generated('uuid') id!: string;
  @CreateDateColumn({ name: 'created_at', ...instant }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', ...instant }) updatedAt!: Date;
}

/** Current projections only; the immutable parse run retains every historical extraction. */
@Entity({ name: 'proxy_solicitations' })
@Index('ux_proxy_solicitation_filing', ['filingId'], { unique: true })
export class ProxySolicitationEntity extends DisclosureProjectionBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'parse_run_id', type: 'char', length: 36 }) parseRunId!: string;
  @Column({ name: 'facts_json', type: 'json' }) factsJson!: Record<string, unknown>;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'proxy_agenda_items' })
@Index('ux_proxy_agenda_ordinal', ['proxySolicitationId', 'ordinal'], { unique: true })
export class ProxyAgendaItemEntity extends DisclosureProjectionBase {
  @Column({ name: 'proxy_solicitation_id', type: 'char', length: 36 }) proxySolicitationId!: string;
  @Column({ type: 'int', unsigned: true }) ordinal!: number;
  @Column({ type: 'text' }) title!: string;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'tender_offers' })
@Index('ux_tender_offer_filing', ['filingId'], { unique: true })
export class TenderOfferEntity extends DisclosureProjectionBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'parse_run_id', type: 'char', length: 36 }) parseRunId!: string;
  @Column({ name: 'document_kind', type: 'varchar', length: 16 }) documentKind!: FilingDocumentKind;
  @Column({ name: 'facts_json', type: 'json' }) factsJson!: Record<string, unknown>;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'tender_offer_securities' })
@Index('ux_tender_security_row', ['tenderOfferId', 'rowIndex'], { unique: true })
export class TenderOfferSecurityEntity extends DisclosureProjectionBase {
  @Column({ name: 'tender_offer_id', type: 'char', length: 36 }) tenderOfferId!: string;
  @Column({ name: 'row_index', type: 'int', unsigned: true }) rowIndex!: number;
  @Column({ name: 'facts_json', type: 'json' }) factsJson!: Record<string, unknown>;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
}

export const DISCLOSURE_ENTITIES = [
  ProxySolicitationEntity,
  ProxyAgendaItemEntity,
  TenderOfferEntity,
  TenderOfferSecurityEntity,
] as const;
