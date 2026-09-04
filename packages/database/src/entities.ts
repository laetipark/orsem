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
import type {
  AlertStatus,
  ClassificationReviewResult,
  ConnectorStatus,
  DeliveryChannel,
  Direction,
  DisclosureDetailType,
  EffectiveFilingState,
  EventState,
  EventType,
  EvidenceGrade,
  FilingRelationType,
  Market,
  ParseStatus,
  ProcessingStatus,
  RelationSource,
  RelationReviewDecision,
  ReviewTaskStatus,
  RightsMode,
  SubmissionKind,
  TransactionNature,
  WatchPriority,
} from '@orsem/contracts';
import { numericStringTransformer } from './transformers';
import { MarketInstrumentEntity, MarketObservationEntity } from './market-entities';
import {
  NotificationPreferenceEntity,
  PushSubscriptionEntity,
  PushDeliveryEntity,
} from './notification-entities';

const instantColumn = { type: 'datetime' as const, precision: 3 };
const exactNumericColumn = {
  type: 'decimal' as const,
  precision: 38,
  scale: 6,
  transformer: numericStringTransformer,
};
const confidenceColumn = {
  type: 'decimal' as const,
  precision: 7,
  scale: 6,
  transformer: numericStringTransformer,
};

abstract class EntityBase {
  @PrimaryColumn({ type: 'char', length: 36 })
  @Generated('uuid')
  id!: string;
  @CreateDateColumn({ name: 'created_at', ...instantColumn }) createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', ...instantColumn }) updatedAt!: Date;
}

@Entity({ name: 'admins' })
@Index('ux_admins_email', ['email'], { unique: true })
export class AdminEntity extends EntityBase {
  @Column({ name: 'singleton_key', type: 'tinyint', unsigned: true, default: 1, unique: true })
  singletonKey!: 1;
  @Column({ type: 'varchar', length: 320 }) email!: string;
  @Column({ name: 'password_hash', type: 'varchar', length: 255 }) passwordHash!: string;
  @Column({ name: 'totp_enabled', type: 'boolean', default: false }) totpEnabled!: boolean;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @Column({ name: 'failed_login_count', type: 'int', unsigned: true, default: 0 })
  failedLoginCount!: number;
  @Column({ name: 'locked_until', ...instantColumn, nullable: true }) lockedUntil!: Date | null;
  @Column({ name: 'last_login_at', ...instantColumn, nullable: true }) lastLoginAt!: Date | null;
}

@Entity({ name: 'members' })
@Unique('ux_members_provider_subject', ['provider', 'providerSubject'])
@Index('ix_members_status_created', ['status', 'createdAt'])
export class MemberEntity extends EntityBase {
  @Column({ type: 'varchar', length: 16, default: 'KAKAO' }) provider!: 'KAKAO';
  @Column({ name: 'provider_subject', type: 'varchar', length: 64 }) providerSubject!: string;
  @Column({ type: 'varchar', length: 16, default: 'VIEWER' }) role!: 'VIEWER';
  @Column({ type: 'varchar', length: 16, default: 'PENDING' }) status!:
    'PENDING' | 'APPROVED' | 'REJECTED';
  @Column({ name: 'display_name', type: 'varchar', length: 80, nullable: true }) displayName!:
    string | null;
  @Column({ name: 'last_login_at', ...instantColumn, nullable: true }) lastLoginAt!: Date | null;
  @Column({ name: 'reviewed_at', ...instantColumn, nullable: true }) reviewedAt!: Date | null;
  @Column({ name: 'reviewed_by_admin_id', type: 'char', length: 36, nullable: true })
  reviewedByAdminId!: string | null;
}

@Entity({ name: 'admin_totp_secrets' })
@Unique('ux_admin_totp_admin', ['adminId'])
export class AdminTotpSecretEntity extends EntityBase {
  @Column({ name: 'admin_id', type: 'char', length: 36 }) adminId!: string;
  @Column({ name: 'encrypted_secret', type: 'text' }) encryptedSecret!: string;
  @Column({ name: 'confirmed_at', ...instantColumn, nullable: true }) confirmedAt!: Date | null;
}

@Entity({ name: 'totp_recovery_codes' })
@Index('ix_totp_recovery_admin_used', ['adminId', 'usedAt'])
export class TotpRecoveryCodeEntity extends EntityBase {
  @Column({ name: 'admin_id', type: 'char', length: 36 }) adminId!: string;
  @Column({ name: 'code_hash', type: 'varchar', length: 255 }) codeHash!: string;
  @Column({ name: 'used_at', ...instantColumn, nullable: true }) usedAt!: Date | null;
}

@Entity({ name: 'auth_audit_logs' })
@Index('ix_auth_audit_created', ['createdAt'])
export class AuthAuditLogEntity extends EntityBase {
  @Column({ name: 'admin_id', type: 'char', length: 36, nullable: true }) adminId!: string | null;
  @Column({ type: 'varchar', length: 64 }) action!: string;
  @Column({ type: 'boolean' }) success!: boolean;
  @Column({ name: 'ip_hash', type: 'char', length: 64, nullable: true }) ipHash!: string | null;
  @Column({ name: 'user_agent', type: 'varchar', length: 500, nullable: true }) userAgent!:
    string | null;
  @Column({ name: 'metadata_json', type: 'json', nullable: true }) metadataJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'companies' })
@Index('ux_companies_corp_code', ['corpCode'], { unique: true })
@Index('ux_companies_market_stock', ['market', 'stockCode'], { unique: true })
@Index('ux_companies_market_ticker', ['market', 'ticker'], { unique: true })
@Index('ix_companies_name_ko', ['nameKo'])
@Index('ix_companies_stock_code', ['stockCode'])
@Index('ix_companies_ticker', ['ticker'])
@Index('ix_companies_cik', ['cik'])
export class CompanyEntity extends EntityBase {
  @Column({ type: 'varchar', length: 16 }) market!: Market;
  @Column({ name: 'corp_code', type: 'char', length: 8, nullable: true }) corpCode!: string | null;
  @Column({ name: 'stock_code', type: 'char', length: 6, nullable: true }) stockCode!:
    string | null;
  @Column({ type: 'varchar', length: 32, nullable: true }) ticker!: string | null;
  @Column({ type: 'char', length: 10, nullable: true }) cik!: string | null;
  @Column({ name: 'name_ko', type: 'varchar', length: 255 }) nameKo!: string;
  @Column({ name: 'name_en', type: 'varchar', length: 255, nullable: true }) nameEn!: string | null;
  @Column({ name: 'is_listed', type: 'boolean', default: true }) isListed!: boolean;
  @Column({ name: 'source_updated_date', type: 'date', nullable: true }) sourceUpdatedDate!:
    string | null;
}

@Entity({ name: 'alpaca_assets' })
@Index('ux_alpaca_assets_provider_id', ['providerAssetId'], { unique: true })
@Index('ix_alpaca_assets_current_exchange_symbol', ['isCurrent', 'exchange', 'symbol'])
@Index('ix_alpaca_assets_company', ['companyId'])
export class AlpacaAssetEntity extends EntityBase {
  @Column({ name: 'provider_asset_id', type: 'char', length: 36 }) providerAssetId!: string;
  @Column({ name: 'company_id', type: 'char', length: 36, nullable: true }) companyId!:
    string | null;
  @Column({ name: 'asset_class', type: 'varchar', length: 32 }) assetClass!: string;
  @Column({ type: 'varchar', length: 32 }) exchange!: string;
  @Column({ type: 'varchar', length: 32 }) symbol!: string;
  @Column({ type: 'text' }) name!: string;
  @Column({ type: 'varchar', length: 32 }) status!: string;
  @Column({ type: 'boolean' }) tradable!: boolean;
  @Column({ type: 'boolean' }) marginable!: boolean;
  @Column({ type: 'boolean' }) shortable!: boolean;
  @Column({ name: 'easy_to_borrow', type: 'boolean' }) easyToBorrow!: boolean;
  @Column({ type: 'boolean' }) fractionable!: boolean;
  @Column({ name: 'maintenance_margin_requirement', type: 'varchar', length: 64, nullable: true })
  maintenanceMarginRequirement!: string | null;
  @Column({ name: 'attributes_json', type: 'json', nullable: true }) attributesJson!:
    string[] | null;
  @Column({ name: 'raw_json', type: 'json' }) rawJson!: Record<string, unknown>;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
  @Column({ name: 'provenance_url', type: 'text' }) provenanceUrl!: string;
  @Column({ name: 'first_observed_at', ...instantColumn }) firstObservedAt!: Date;
  @Column({ name: 'last_observed_at', ...instantColumn }) lastObservedAt!: Date;
  @Column({ name: 'is_current', type: 'boolean', default: true }) isCurrent!: boolean;
}

@Entity({ name: 'company_aliases' })
@Unique('ux_company_alias_source', ['companyId', 'source', 'alias'])
@Index('ix_company_alias_alias', ['alias'])
export class CompanyAliasEntity extends EntityBase {
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ type: 'varchar', length: 64 }) source!: string;
  @Column({ type: 'varchar', length: 255 }) alias!: string;
  @Column({ name: 'alias_type', type: 'varchar', length: 32 }) aliasType!: string;
}

@Entity({ name: 'watchlist_items' })
@Unique('ux_watchlist_company', ['companyId'])
@Index('ix_watchlist_priority', ['priority'])
export class WatchlistItemEntity extends EntityBase {
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ type: 'varchar', length: 4 }) priority!: WatchPriority;
  @Column({ name: 'realtime_alerts', type: 'boolean', default: true }) realtimeAlerts!: boolean;
  @Column({ name: 'digest_alerts', type: 'boolean', default: false }) digestAlerts!: boolean;
  @Column({ type: 'text', nullable: true }) notes!: string | null;
}

@Entity({ name: 'source_items' })
@Unique('ux_source_external', ['source', 'externalId'])
@Unique('ux_source_raw_hash', ['source', 'rawHash'])
@Index('ix_source_items_published', ['publishedAt', 'id'])
export class SourceItemEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) source!: string;
  @Column({ name: 'external_id', type: 'varchar', length: 255, nullable: true }) externalId!:
    string | null;
  @Column({ name: 'company_id', type: 'char', length: 36, nullable: true }) companyId!:
    string | null;
  @Column({ type: 'text' }) url!: string;
  @Column({ type: 'text' }) title!: string;
  @Column({ name: 'source_name', type: 'varchar', length: 255, nullable: true }) sourceName!:
    string | null;
  @Column({ type: 'varchar', length: 255, nullable: true }) author!: string | null;
  @Column({ name: 'published_at', ...instantColumn, nullable: true }) publishedAt!: Date | null;
  @Column({ name: 'first_observed_at', ...instantColumn }) firstObservedAt!: Date;
  @Column({ name: 'processed_at', ...instantColumn, nullable: true }) processedAt!: Date | null;
  @Column({ name: 'raw_hash', type: 'char', length: 64, nullable: true }) rawHash!: string | null;
  @Column({ name: 'raw_object_uri', type: 'text', nullable: true }) rawObjectUri!: string | null;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
  @Column({ name: 'provenance_url', type: 'text', nullable: true }) provenanceUrl!: string | null;
  @Column({ name: 'raw_metadata_json', type: 'json', nullable: true }) rawMetadataJson!: Record<
    string,
    unknown
  > | null;
  // 원문·수집 메타데이터를 덮어쓰지 않고 번역 결과와 처리 이력을 별도로 보관합니다.
  @Column({ name: 'translation_json', type: 'json', nullable: true }) translationJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'news_items' })
@Unique('ux_news_source_item', ['sourceItemId'])
@Index('ix_news_company_published', ['companyId', 'publishedAt'])
export class NewsItemEntity extends EntityBase {
  @Column({ name: 'source_item_id', type: 'char', length: 36 }) sourceItemId!: string;
  @Column({ name: 'company_id', type: 'char', length: 36, nullable: true }) companyId!:
    string | null;
  @Column({ type: 'text' }) title!: string;
  @Column({ type: 'text', nullable: true }) description!: string | null;
  @Column({ name: 'published_at', ...instantColumn, nullable: true }) publishedAt!: Date | null;
  @Column({ name: 'tickers_json', type: 'json', nullable: true }) tickersJson!: string[] | null;
  @Column({ name: 'tags_json', type: 'json', nullable: true }) tagsJson!: string[] | null;
  @Column({ name: 'engagement_json', type: 'json', nullable: true }) engagementJson!: Record<
    string,
    number
  > | null;
}

@Entity({ name: 'price_bars' })
@Unique('ux_price_bar_company_source_interval_time', ['companyId', 'source', 'interval', 'barAt'])
export class PriceBarEntity extends EntityBase {
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ type: 'varchar', length: 16 }) interval!: string;
  @Column({ name: 'bar_at', ...instantColumn }) barAt!: Date;
  @Column({ name: 'session_date', type: 'date', nullable: true }) sessionDate!: string | null;
  @Column({ ...exactNumericColumn }) open!: string;
  @Column({ ...exactNumericColumn }) high!: string;
  @Column({ ...exactNumericColumn }) low!: string;
  @Column({ ...exactNumericColumn }) close!: string;
  @Column({ ...exactNumericColumn }) volume!: string;
  @Column({ type: 'char', length: 3 }) currency!: string;
  @Column({ type: 'varchar', length: 64 }) source!: string;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
  @Column({ name: 'raw_payload_json', type: 'json', nullable: true }) rawPayloadJson!: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'observed_at', ...instantColumn, nullable: true }) observedAt!: Date | null;
}

@Entity({ name: 'ir_sources' })
@Unique('ux_ir_source_company_url', ['companyId', 'urlHash'])
export class IrSourceEntity extends EntityBase {
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ type: 'text' }) url!: string;
  @Column({ name: 'url_hash', type: 'char', length: 64 }) urlHash!: string;
  @Column({ name: 'source_type', type: 'varchar', length: 32 }) sourceType!: string;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @Column({ name: 'last_checked_at', ...instantColumn, nullable: true })
  lastCheckedAt!: Date | null;
}

@Entity({ name: 'filings' })
@Unique('ux_filings_source_rcept', ['source', 'rceptNo'])
@Index('ix_filings_date_cursor', ['rceptDate', 'id'])
@Index('ix_filings_company_type_date', ['companyId', 'detailType', 'rceptDate'])
export class FilingEntity extends EntityBase {
  @Column({ type: 'varchar', length: 32, default: 'OPENDART' }) source!: string;
  @Column({ name: 'rcept_no', type: 'varchar', length: 32 }) rceptNo!: string;
  @Column({ name: 'company_id', type: 'char', length: 36 }) companyId!: string;
  @Column({ name: 'detail_type', type: 'char', length: 4 }) detailType!: DisclosureDetailType;
  @Column({ name: 'source_detail_type', type: 'varchar', length: 32, nullable: true })
  sourceDetailType!: string | null;
  @Column({ name: 'title_detected_type', type: 'varchar', length: 32, nullable: true })
  titleDetectedType!: string | null;
  @Column({ name: 'canonical_type', type: 'varchar', length: 32, nullable: true })
  canonicalType!: string | null;
  @Column({ name: 'classification_status', type: 'varchar', length: 32, default: 'UNKNOWN' })
  classificationStatus!: 'CONFIRMED' | 'UNKNOWN' | 'UNSUPPORTED' | 'MANUAL_OVERRIDE' | 'CONFLICT';
  @Column({ name: 'classifier_version', type: 'varchar', length: 64, nullable: true })
  classifierVersion!: string | null;
  @Column({ name: 'classification_provenance_json', type: 'json', nullable: true })
  classificationProvenanceJson!: Record<string, unknown> | null;
  @Column({ name: 'report_name', type: 'text' }) reportName!: string;
  @Column({ name: 'filer_name', type: 'varchar', length: 255 }) filerName!: string;
  @Column({ name: 'rcept_date', type: 'date' }) rceptDate!: string;
  @Column({ type: 'text', nullable: true }) rm!: string | null;
  @Column({ name: 'submission_kind', type: 'varchar', length: 32 }) submissionKind!: SubmissionKind;
  @Column({ name: 'effective_state', type: 'varchar', length: 16 })
  effectiveState!: EffectiveFilingState;
  @Column({ name: 'first_observed_at', ...instantColumn }) firstObservedAt!: Date;
  @Column({ name: 'last_seen_at', ...instantColumn }) lastSeenAt!: Date;
  @Column({ name: 'raw_list_json', type: 'json', nullable: true }) rawListJson!: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'active_parse_run_id', type: 'char', length: 36, nullable: true })
  activeParseRunId!: string | null;
}

@Entity({ name: 'filing_list_observations' })
@Unique('ux_filing_observation_filing_seen', ['filingId', 'observedAt'])
export class FilingListObservationEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'observed_at', ...instantColumn }) observedAt!: Date;
  @Column({ name: 'query_detail_type', type: 'char', length: 4 })
  queryDetailType!: DisclosureDetailType;
  @Column({ name: 'raw_list_json', type: 'json' }) rawListJson!: Record<string, unknown>;
  @Column({ name: 'ingestion_run_id', type: 'char', length: 36, nullable: true }) ingestionRunId!:
    string | null;
}

@Entity({ name: 'filing_documents' })
@Unique('ux_filing_document_sha', ['filingId', 'sha256'])
export class FilingDocumentEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'object_uri', type: 'text' }) objectUri!: string;
  @Column({ type: 'char', length: 64 }) sha256!: string;
  @Column({ name: 'media_type', type: 'varchar', length: 128 }) mediaType!: string;
  @Column({ name: 'byte_size', ...exactNumericColumn }) byteSize!: string;
  @Column({ name: 'original_filename', type: 'varchar', length: 500, nullable: true })
  originalFilename!: string | null;
  @Column({ name: 'retrieved_at', ...instantColumn }) retrievedAt!: Date;
  @Column({ name: 'rights_mode', type: 'varchar', length: 32 }) rightsMode!: RightsMode;
}

@Entity({ name: 'filing_relations' })
@Unique('ux_filing_relation_edge', ['fromFilingId', 'toFilingId', 'relationType'])
export class FilingRelationEntity extends EntityBase {
  @Column({ name: 'from_filing_id', type: 'char', length: 36 }) fromFilingId!: string;
  @Column({ name: 'to_filing_id', type: 'char', length: 36 }) toFilingId!: string;
  @Column({ name: 'relation_type', type: 'varchar', length: 32 }) relationType!: FilingRelationType;
  @Column({ ...confidenceColumn }) confidence!: string;
  @Column({ type: 'varchar', length: 16 }) source!: RelationSource;
  @Column({ name: 'review_required', type: 'boolean', default: false }) reviewRequired!: boolean;
  @Column({ name: 'review_decision', type: 'varchar', length: 16, default: 'PENDING' })
  reviewDecision!: RelationReviewDecision;
  @Column({ name: 'reviewed_by_admin_id', type: 'char', length: 36, nullable: true })
  reviewedByAdminId!: string | null;
  @Column({ name: 'reviewed_at', ...instantColumn, nullable: true }) reviewedAt!: Date | null;
  @Column({ name: 'matched_fields_json', type: 'json', nullable: true }) matchedFieldsJson!:
    string[] | null;
}

@Entity({ name: 'parse_runs' })
@Unique('ux_parse_run_fingerprint', ['filingId', 'reuseFingerprint'])
@Index('ix_parse_runs_filing_created', ['filingId', 'createdAt'])
export class ParseRunEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'parser_version', type: 'varchar', length: 64 }) parserVersion!: string;
  @Column({ name: 'raw_sha256', type: 'char', length: 64 }) rawSha256!: string;
  @Column({ name: 'input_type', type: 'varchar', length: 32, nullable: true }) inputType!:
    string | null;
  @Column({ name: 'extractor_type', type: 'varchar', length: 32, nullable: true }) extractorType!:
    string | null;
  @Column({ name: 'result_type', type: 'varchar', length: 32, nullable: true }) resultType!:
    string | null;
  @Column({ name: 'normalizer_version', type: 'varchar', length: 64, nullable: true })
  normalizerVersion!: string | null;
  @Column({ name: 'classifier_version', type: 'varchar', length: 64, nullable: true })
  classifierVersion!: string | null;
  @Column({ name: 'reuse_fingerprint', type: 'char', length: 64, nullable: true })
  reuseFingerprint!: string | null;
  @Column({ name: 'candidate_errors_json', type: 'json', nullable: true })
  candidateErrorsJson!: Array<Record<string, unknown>> | null;
  @Column({ name: 'normalization_audits_json', type: 'json', nullable: true })
  normalizationAuditsJson!: Array<Record<string, unknown>> | null;
  @Column({ name: 'supersedes_run_id', type: 'char', length: 36, nullable: true })
  supersedesRunId!: string | null;
  @Column({ name: 'validation_status', type: 'varchar', length: 32, default: 'LEGACY' })
  validationStatus!: 'LEGACY' | 'PENDING' | 'PASSED' | 'REVIEW_REQUIRED' | 'REJECTED';
  @Column({ type: 'varchar', length: 16 }) status!: ParseStatus;
  @Column({ ...confidenceColumn, nullable: true }) confidence!: string | null;
  @Column({ name: 'classification_result', type: 'varchar', length: 32, nullable: true })
  classificationResult!: ClassificationReviewResult | null;
  @Column({ name: 'started_at', ...instantColumn, nullable: true }) startedAt!: Date | null;
  @Column({ name: 'finished_at', ...instantColumn, nullable: true }) finishedAt!: Date | null;
  @Column({ name: 'warnings_json', type: 'json', nullable: true }) warningsJson!: string[] | null;
  @Column({ name: 'error_code', type: 'varchar', length: 128, nullable: true }) errorCode!:
    string | null;
  @Column({ name: 'error_message', type: 'text', nullable: true }) errorMessage!: string | null;
  @Column({ name: 'result_json', type: 'json', nullable: true }) resultJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'parse_issues' })
@Index('ix_parse_issues_run_severity', ['parseRunId', 'severity'])
export class ParseIssueEntity extends EntityBase {
  @Column({ name: 'parse_run_id', type: 'char', length: 36 }) parseRunId!: string;
  @Column({ type: 'varchar', length: 16 }) severity!: 'INFO' | 'WARNING' | 'ERROR';
  @Column({ type: 'varchar', length: 128 }) code!: string;
  @Column({ type: 'text' }) message!: string;
  @Column({ name: 'context_json', type: 'json', nullable: true }) contextJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'insider_reports' })
@Unique('ux_insider_report_filing_reporter', ['filingId', 'reporterName'])
export class InsiderReportEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'reporter_name', type: 'varchar', length: 255 }) reporterName!: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) relationship!: string | null;
  @Column({ type: 'varchar', length: 255, nullable: true }) position!: string | null;
  @Column({ name: 'is_registered_executive', type: 'boolean', nullable: true })
  isRegisteredExecutive!: boolean | null;
  @Column({ name: 'is_major_shareholder', type: 'boolean', nullable: true }) isMajorShareholder!:
    boolean | null;
  @Column({ name: 'ownership_before', ...exactNumericColumn, nullable: true }) ownershipBefore!:
    string | null;
  @Column({ name: 'ownership_after', ...exactNumericColumn, nullable: true }) ownershipAfter!:
    string | null;
  @Column({ name: 'ownership_change', ...exactNumericColumn, nullable: true }) ownershipChange!:
    string | null;
  @Column({ name: 'ownership_rate_after', ...exactNumericColumn, nullable: true })
  ownershipRateAfter!: string | null;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'insider_transactions' })
@Index('ix_transactions_report_date', ['insiderReportId', 'eventDate'])
export class InsiderTransactionEntity extends EntityBase {
  @Column({ name: 'insider_report_id', type: 'char', length: 36 }) insiderReportId!: string;
  @Column({ name: 'event_date', type: 'date', nullable: true }) eventDate!: string | null;
  @Column({ name: 'security_type_raw', type: 'varchar', length: 500 }) securityTypeRaw!: string;
  @Column({ name: 'method_raw', type: 'varchar', length: 500 }) methodRaw!: string;
  @Column({ type: 'varchar', length: 32 }) nature!: TransactionNature;
  @Column({ type: 'varchar', length: 16 }) direction!: Direction;
  @Column({ ...exactNumericColumn, nullable: true }) quantity!: string | null;
  @Column({ name: 'unit_price', ...exactNumericColumn, nullable: true }) unitPrice!: string | null;
  @Column({ ...exactNumericColumn, nullable: true }) amount!: string | null;
  @Column({ type: 'char', length: 3, nullable: true }) currency!: 'KRW' | null;
  @Column({ name: 'shares_after', ...exactNumericColumn, nullable: true }) sharesAfter!:
    string | null;
  @Column({ name: 'parser_confidence', ...confidenceColumn }) parserConfidence!: string;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'trade_plans' })
@Index('ix_trade_plans_filing', ['filingId'])
export class TradePlanEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'reporter_name', type: 'varchar', length: 255 }) reporterName!: string;
  @Column({ name: 'planned_start_date', type: 'date', nullable: true }) plannedStartDate!:
    string | null;
  @Column({ name: 'planned_end_date', type: 'date', nullable: true }) plannedEndDate!:
    string | null;
  @Column({ name: 'plan_status', type: 'varchar', length: 32 }) planStatus!: string;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'trade_plan_items' })
@Index('ix_trade_plan_items_plan', ['tradePlanId'])
export class TradePlanItemEntity extends EntityBase {
  @Column({ name: 'trade_plan_id', type: 'char', length: 36 }) tradePlanId!: string;
  @Column({ name: 'security_type_raw', type: 'varchar', length: 500, nullable: true })
  securityTypeRaw!: string | null;
  @Column({ name: 'method_raw', type: 'varchar', length: 500, nullable: true }) methodRaw!:
    string | null;
  @Column({ name: 'planned_quantity', ...exactNumericColumn, nullable: true }) plannedQuantity!:
    string | null;
  @Column({ name: 'planned_unit_price', ...exactNumericColumn, nullable: true }) plannedUnitPrice!:
    string | null;
  @Column({ name: 'planned_amount', ...exactNumericColumn, nullable: true }) plannedAmount!:
    string | null;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'plan_execution_matches' })
@Unique('ux_plan_execution_candidate', ['tradePlanItemId', 'insiderTransactionId'])
export class PlanExecutionMatchEntity extends EntityBase {
  @Column({ name: 'trade_plan_item_id', type: 'char', length: 36 }) tradePlanItemId!: string;
  @Column({ name: 'insider_transaction_id', type: 'char', length: 36 })
  insiderTransactionId!: string;
  @Column({ name: 'relation_type', type: 'varchar', length: 32, default: 'EXECUTION_CANDIDATE' })
  relationType!: FilingRelationType;
  @Column({ ...confidenceColumn }) confidence!: string;
  @Column({ type: 'varchar', length: 16 }) source!: RelationSource;
  @Column({ name: 'confirmed_by_admin_id', type: 'char', length: 36, nullable: true })
  confirmedByAdminId!: string | null;
  @Column({ name: 'confirmed_at', ...instantColumn, nullable: true }) confirmedAt!: Date | null;
  @Column({ name: 'review_decision', type: 'varchar', length: 16, default: 'PENDING' })
  reviewDecision!: RelationReviewDecision;
  @Column({ name: 'reviewed_by_admin_id', type: 'char', length: 36, nullable: true })
  reviewedByAdminId!: string | null;
  @Column({ name: 'reviewed_at', ...instantColumn, nullable: true }) reviewedAt!: Date | null;
  @Column({ name: 'matched_fields_json', type: 'json', nullable: true }) matchedFieldsJson!:
    string[] | null;
}

@Entity({ name: 'large_holder_reports' })
@Index('ix_large_holder_filing', ['filingId'])
export class LargeHolderReportEntity extends EntityBase {
  @Column({ name: 'filing_id', type: 'char', length: 36 }) filingId!: string;
  @Column({ name: 'reporter_name', type: 'varchar', length: 255 }) reporterName!: string;
  @Column({ name: 'report_reason_raw', type: 'text', nullable: true }) reportReasonRaw!:
    string | null;
  @Column({ name: 'holding_purpose_raw', type: 'text', nullable: true }) holdingPurposeRaw!:
    string | null;
  @Column({ name: 'shares_before', ...exactNumericColumn, nullable: true }) sharesBefore!:
    string | null;
  @Column({ name: 'shares_after', ...exactNumericColumn, nullable: true }) sharesAfter!:
    string | null;
  @Column({ name: 'ownership_rate_before', ...exactNumericColumn, nullable: true })
  ownershipRateBefore!: string | null;
  @Column({ name: 'ownership_rate_after', ...exactNumericColumn, nullable: true })
  ownershipRateAfter!: string | null;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'large_holder_positions' })
@Index('ix_large_holder_positions_report', ['largeHolderReportId'])
export class LargeHolderPositionEntity extends EntityBase {
  @Column({ name: 'large_holder_report_id', type: 'char', length: 36 })
  largeHolderReportId!: string;
  @Column({ name: 'holder_name', type: 'varchar', length: 255 }) holderName!: string;
  @Column({ name: 'relationship_raw', type: 'varchar', length: 500, nullable: true })
  relationshipRaw!: string | null;
  @Column({ name: 'security_type_raw', type: 'varchar', length: 500, nullable: true })
  securityTypeRaw!: string | null;
  @Column({ name: 'shares_before', ...exactNumericColumn, nullable: true }) sharesBefore!:
    string | null;
  @Column({ name: 'shares_after', ...exactNumericColumn, nullable: true }) sharesAfter!:
    string | null;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'large_holding_changes' })
@Index('ix_large_holding_changes_report_date', ['largeHolderReportId', 'eventDate'])
export class LargeHoldingChangeEntity extends EntityBase {
  @Column({ name: 'large_holder_report_id', type: 'char', length: 36 })
  largeHolderReportId!: string;
  @Column({ name: 'event_date', type: 'date', nullable: true }) eventDate!: string | null;
  @Column({ name: 'method_raw', type: 'varchar', length: 500, nullable: true }) methodRaw!:
    string | null;
  @Column({ type: 'varchar', length: 16 }) direction!: Direction;
  @Column({ name: 'share_change', ...exactNumericColumn, nullable: true }) shareChange!:
    string | null;
  @Column({ ...exactNumericColumn, nullable: true }) amount!: string | null;
  @Column({ name: 'raw_json', type: 'json', nullable: true }) rawJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'event_clusters' })
@Index('ix_event_clusters_cursor', ['firstObservedAt', 'id'])
@Index('ix_event_clusters_company_type', ['companyId', 'canonicalEventType'])
export class EventClusterEntity extends EntityBase {
  @Column({ name: 'canonical_event_type', type: 'varchar', length: 32 })
  canonicalEventType!: EventType;
  @Column({ name: 'company_id', type: 'char', length: 36, nullable: true }) companyId!:
    string | null;
  @Column({ name: 'occurred_at', ...instantColumn, nullable: true }) occurredAt!: Date | null;
  @Column({ name: 'published_at', ...instantColumn, nullable: true }) publishedAt!: Date | null;
  @Column({ name: 'first_observed_at', ...instantColumn }) firstObservedAt!: Date;
  @Column({ name: 'processed_at', ...instantColumn, nullable: true }) processedAt!: Date | null;
  @Column({ type: 'varchar', length: 32 }) state!: EventState;
  @Column({ name: 'evidence_grade', type: 'varchar', length: 16 }) evidenceGrade!: EvidenceGrade;
  @Column({ type: 'text' }) summary!: string;
  @Column({ name: 'dedupe_key', type: 'varchar', length: 255, unique: true }) dedupeKey!: string;
  @Column({ name: 'metadata_json', type: 'json', nullable: true }) metadataJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'event_cluster_items' })
@Unique('ux_event_cluster_item', ['eventClusterId', 'itemType', 'itemId'])
export class EventClusterItemEntity extends EntityBase {
  @Column({ name: 'event_cluster_id', type: 'char', length: 36 }) eventClusterId!: string;
  @Column({ name: 'item_type', type: 'varchar', length: 32 }) itemType!:
    'FILING' | 'SOURCE_ITEM' | 'NEWS_ITEM';
  @Column({ name: 'item_id', type: 'char', length: 36 }) itemId!: string;
  @Column({ name: 'is_primary', type: 'boolean', default: false }) isPrimary!: boolean;
  @Column({ name: 'provenance_json', type: 'json', nullable: true }) provenanceJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'ai_runs' })
@Unique('ux_ai_runs_identity', ['subjectType', 'subjectId', 'provider', 'model', 'promptHash'])
@Index('ix_ai_runs_subject_created', ['subjectType', 'subjectId', 'createdAt'])
export class AiRunEntity extends EntityBase {
  @Column({ name: 'subject_type', type: 'varchar', length: 64 }) subjectType!: string;
  @Column({ name: 'subject_id', type: 'char', length: 36 }) subjectId!: string;
  @Column({ type: 'varchar', length: 128 }) provider!: string;
  @Column({ type: 'varchar', length: 255 }) model!: string;
  @Column({ name: 'prompt_hash', type: 'char', length: 64 }) promptHash!: string;
  @Column({ type: 'varchar', length: 16 }) status!: ProcessingStatus;
  @Column({ name: 'input_provenance_json', type: 'json' }) inputProvenanceJson!: Record<
    string,
    unknown
  >;
  @Column({ name: 'output_json', type: 'json', nullable: true }) outputJson!: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'error_message', type: 'text', nullable: true }) errorMessage!: string | null;
}

@Entity({ name: 'api_usage_counters' })
@Unique('ux_api_usage_connector_day', ['connector', 'usageDate'])
export class ApiUsageCounterEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) connector!: string;
  @Column({ name: 'usage_date', type: 'date' }) usageDate!: string;
  @Column({ name: 'request_count', ...exactNumericColumn, default: '0' }) requestCount!: string;
  @Column({ name: 'item_count', ...exactNumericColumn, default: '0' }) itemCount!: string;
  @Column({ name: 'last_request_at', ...instantColumn, nullable: true })
  lastRequestAt!: Date | null;
}

@Entity({ name: 'ingestion_runs' })
@Index('ix_ingestion_runs_connector_started', ['connector', 'startedAt'])
export class IngestionRunEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) connector!: string;
  @Column({ type: 'varchar', length: 128 }) stream!: string;
  @Column({ name: 'window_start', type: 'date', nullable: true }) windowStart!: string | null;
  @Column({ name: 'window_end', type: 'date', nullable: true }) windowEnd!: string | null;
  @Column({ type: 'varchar', length: 16 }) status!: ProcessingStatus;
  @Column({ name: 'items_seen', ...exactNumericColumn, default: '0' }) itemsSeen!: string;
  @Column({ name: 'items_created', ...exactNumericColumn, default: '0' }) itemsCreated!: string;
  @Column({ name: 'started_at', ...instantColumn }) startedAt!: Date;
  @Column({ name: 'finished_at', ...instantColumn, nullable: true }) finishedAt!: Date | null;
  @Column({ name: 'error_message', type: 'text', nullable: true }) errorMessage!: string | null;
}

@Entity({ name: 'source_checkpoints' })
@Unique('ux_source_checkpoint_stream', ['connector', 'stream'])
export class SourceCheckpointEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) connector!: string;
  @Column({ type: 'varchar', length: 128 }) stream!: string;
  @Column({ name: 'last_success_date', type: 'date', nullable: true }) lastSuccessDate!:
    string | null;
  @Column({ name: 'checkpoint_cursor', type: 'text', nullable: true }) cursor!: string | null;
  @Column({ name: 'last_success_at', ...instantColumn, nullable: true })
  lastSuccessAt!: Date | null;
  @Column({ name: 'metadata_json', type: 'json', nullable: true }) metadataJson!: Record<
    string,
    unknown
  > | null;
}

@Entity({ name: 'job_outbox' })
@Unique('ux_job_outbox_dedupe', ['kind', 'dedupeKey'])
@Index('ix_job_outbox_available', ['status', 'availableAt'])
export class JobOutboxEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) kind!: string;
  @Column({ name: 'dedupe_key', type: 'varchar', length: 255 }) dedupeKey!: string;
  @Column({ name: 'payload_json', type: 'json' }) payloadJson!: Record<string, unknown>;
  @Column({ type: 'varchar', length: 16 }) status!: ProcessingStatus;
  @Column({ name: 'available_at', ...instantColumn }) availableAt!: Date;
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ name: 'locked_at', ...instantColumn, nullable: true }) lockedAt!: Date | null;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
}

@Entity({ name: 'alerts' })
@Index('ux_alerts_idempotency', ['idempotencyKey'], { unique: true })
export class AlertEntity extends EntityBase {
  @Column({ name: 'event_cluster_id', type: 'char', length: 36, nullable: true }) eventClusterId!:
    string | null;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 }) idempotencyKey!: string;
  @Column({ type: 'varchar', length: 16 }) status!: AlertStatus;
  @Column({ name: 'alert_version', type: 'int', unsigned: true, default: 1 }) alertVersion!: number;
  @Column({ name: 'payload_json', type: 'json' }) payloadJson!: Record<string, unknown>;
}

@Entity({ name: 'alert_outbox' })
@Unique('ux_alert_outbox_channel_key', ['channel', 'idempotencyKey'])
@Index('ix_alert_outbox_available', ['status', 'availableAt'])
export class AlertOutboxEntity extends EntityBase {
  @Column({ name: 'alert_id', type: 'char', length: 36 }) alertId!: string;
  @Column({ type: 'varchar', length: 32 }) channel!: DeliveryChannel;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 255 }) idempotencyKey!: string;
  @Column({ type: 'varchar', length: 16 }) status!: AlertStatus;
  @Column({ type: 'json' }) payload!: Record<string, unknown>;
  @Column({ name: 'available_at', ...instantColumn }) availableAt!: Date;
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
}

@Entity({ name: 'alert_deliveries' })
@Index('ix_alert_delivery_alert_channel', ['alertId', 'channel'])
export class AlertDeliveryEntity extends EntityBase {
  @Column({ name: 'alert_id', type: 'char', length: 36 }) alertId!: string;
  @Column({ type: 'varchar', length: 32 }) channel!: DeliveryChannel;
  @Column({ name: 'destination_hash', type: 'char', length: 64, nullable: true }) destinationHash!:
    string | null;
  @Column({ type: 'varchar', length: 16 }) status!: AlertStatus;
  @Column({ name: 'external_message_id', type: 'varchar', length: 255, nullable: true })
  externalMessageId!: string | null;
  @Column({ name: 'sent_at', ...instantColumn, nullable: true }) sentAt!: Date | null;
  @Column({ name: 'acknowledged_at', ...instantColumn, nullable: true })
  acknowledgedAt!: Date | null;
  @Column({ name: 'error_message', type: 'text', nullable: true }) errorMessage!: string | null;
}

@Entity({ name: 'reviews' })
@Index('ix_reviews_status_created', ['status', 'createdAt'])
@Unique('ux_reviews_subject_dedupe', ['subjectType', 'subjectId', 'dedupeKey'])
export class ReviewEntity extends EntityBase {
  @Column({ name: 'subject_type', type: 'varchar', length: 64 }) subjectType!: string;
  @Column({ name: 'subject_id', type: 'char', length: 36 }) subjectId!: string;
  @Column({ name: 'dedupe_key', type: 'varchar', length: 255 }) dedupeKey!: string;
  @Column({ name: 'review_group', type: 'varchar', length: 32, nullable: true }) reviewGroup!:
    string | null;
  @Column({ name: 'parse_run_id', type: 'char', length: 36, nullable: true }) parseRunId!:
    string | null;
  @Column({ name: 'superseded_by_review_id', type: 'char', length: 36, nullable: true })
  supersededByReviewId!: string | null;
  @Column({ name: 'reopened_from_review_id', type: 'char', length: 36, nullable: true })
  reopenedFromReviewId!: string | null;
  @Column({ type: 'text' }) reason!: string;
  @Column({ type: 'varchar', length: 16 }) status!: ReviewTaskStatus;
  @Column({ name: 'classification_result', type: 'varchar', length: 32, nullable: true })
  classificationResult!: ClassificationReviewResult | null;
  @Column({ type: 'text', nullable: true }) resolution!: string | null;
  @Column({ name: 'resolved_by_admin_id', type: 'char', length: 36, nullable: true })
  resolvedByAdminId!: string | null;
  @Column({ name: 'resolved_at', ...instantColumn, nullable: true }) resolvedAt!: Date | null;
}

@Entity({ name: 'connector_health' })
@Unique('ux_connector_health_connector', ['connector'])
export class ConnectorHealthEntity extends EntityBase {
  @Column({ type: 'varchar', length: 64 }) connector!: string;
  @Column({ type: 'varchar', length: 16 }) status!: ConnectorStatus;
  @Column({ type: 'text', nullable: true }) message!: string | null;
  @Column({ name: 'last_success_at', ...instantColumn, nullable: true })
  lastSuccessAt!: Date | null;
  @Column({ name: 'last_failure_at', ...instantColumn, nullable: true })
  lastFailureAt!: Date | null;
  @Column({ name: 'metadata_json', type: 'json', nullable: true }) metadataJson!: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'checked_at', ...instantColumn }) checkedAt!: Date;
}

@Entity({ name: 'messenger_devices' })
@Unique('ux_messenger_device_external', ['externalDeviceId'])
export class MessengerDeviceEntity extends EntityBase {
  @Column({ name: 'external_device_id', type: 'varchar', length: 128 }) externalDeviceId!: string;
  @Column({ name: 'token_hash', type: 'varchar', length: 255 }) tokenHash!: string;
  @Column({ type: 'varchar', length: 255 }) room!: string;
  @Column({ name: 'author_hash', type: 'varchar', length: 255 }) authorHash!: string;
  @Column({ name: 'package_name', type: 'varchar', length: 255 }) packageName!: string;
  @Column({ name: 'bot_version', type: 'varchar', length: 64 }) botVersion!: string;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
  @Column({ name: 'paired_at', ...instantColumn }) pairedAt!: Date;
  @Column({ name: 'last_seen_at', ...instantColumn, nullable: true }) lastSeenAt!: Date | null;
}

@Entity({ name: 'device_pairings' })
@Index('ix_device_pairings_expires', ['expiresAt'])
export class DevicePairingEntity extends EntityBase {
  @Column({ name: 'code_hash', type: 'char', length: 64, unique: true }) codeHash!: string;
  @Column({ name: 'created_by_admin_id', type: 'char', length: 36 }) createdByAdminId!: string;
  @Column({ name: 'expires_at', ...instantColumn }) expiresAt!: Date;
  @Column({ name: 'consumed_at', ...instantColumn, nullable: true }) consumedAt!: Date | null;
  @Column({ name: 'device_id', type: 'char', length: 36, nullable: true }) deviceId!: string | null;
}

@Entity({ name: 'bot_room_bindings' })
@Unique('ux_bot_room_consumer_room', ['consumer', 'roomHash'])
export class BotRoomBindingEntity extends EntityBase {
  @Column({ type: 'varchar', length: 32 }) consumer!: 'DISCORD' | 'MESSENGERBOTR';
  @Column({ name: 'device_id', type: 'char', length: 36, nullable: true }) deviceId!: string | null;
  @Column({ name: 'room_label', type: 'varchar', length: 255 }) roomLabel!: string;
  @Column({ name: 'room_hash', type: 'char', length: 64 }) roomHash!: string;
  @Column({ name: 'is_active', type: 'boolean', default: true }) isActive!: boolean;
}

@Entity({ name: 'bot_deliveries' })
@Unique('ux_bot_delivery_dedupe', ['consumer', 'dedupeKey'])
@Index('ix_bot_deliveries_pull', ['consumer', 'status', 'availableAt'])
@Index('ix_bot_deliveries_alert', ['alertId', 'status'])
export class BotDeliveryEntity extends EntityBase {
  @Column({ name: 'alert_id', type: 'char', length: 36, nullable: true }) alertId!: string | null;
  @Column({ name: 'alert_delivery_id', type: 'char', length: 36, nullable: true })
  alertDeliveryId!: string | null;
  @Column({ type: 'varchar', length: 32 }) consumer!: 'DISCORD' | 'MESSENGERBOTR';
  @Column({ name: 'device_id', type: 'char', length: 36, nullable: true }) deviceId!: string | null;
  @Column({ name: 'dedupe_key', type: 'varchar', length: 255 }) dedupeKey!: string;
  @Column({ type: 'varchar', length: 16 }) status!: AlertStatus;
  @Column({ type: 'json' }) payload!: Record<string, unknown>;
  @Column({ name: 'available_at', ...instantColumn }) availableAt!: Date;
  @Column({ name: 'lease_until', ...instantColumn, nullable: true }) leaseUntil!: Date | null;
  @Column({ name: 'external_message_id', type: 'varchar', length: 255, nullable: true })
  externalMessageId!: string | null;
  @Column({ name: 'acknowledged_at', ...instantColumn, nullable: true })
  acknowledgedAt!: Date | null;
  @Column({ type: 'int', unsigned: true, default: 0 }) attempts!: number;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError!: string | null;
}

@Entity({ name: 'bot_commands' })
@Unique('ux_bot_command_external', ['deviceId', 'externalCommandId'])
export class BotCommandEntity extends EntityBase {
  @Column({ name: 'device_id', type: 'char', length: 36 }) deviceId!: string;
  @Column({ name: 'external_command_id', type: 'varchar', length: 128 }) externalCommandId!: string;
  @Column({ type: 'varchar', length: 128 }) command!: string;
  @Column({ type: 'text' }) query!: string;
  @Column({ name: 'received_at', ...instantColumn }) receivedAt!: Date;
  @Column({ name: 'response_json', type: 'json', nullable: true }) responseJson!: Record<
    string,
    unknown
  > | null;
}

export const ENTITIES = [
  NotificationPreferenceEntity,
  PushSubscriptionEntity,
  PushDeliveryEntity,
  MarketInstrumentEntity,
  MarketObservationEntity,
  AdminEntity,
  MemberEntity,
  AdminTotpSecretEntity,
  TotpRecoveryCodeEntity,
  AuthAuditLogEntity,
  CompanyEntity,
  AlpacaAssetEntity,
  CompanyAliasEntity,
  WatchlistItemEntity,
  SourceItemEntity,
  NewsItemEntity,
  PriceBarEntity,
  IrSourceEntity,
  FilingEntity,
  FilingListObservationEntity,
  FilingDocumentEntity,
  FilingRelationEntity,
  ParseRunEntity,
  ParseIssueEntity,
  InsiderReportEntity,
  InsiderTransactionEntity,
  TradePlanEntity,
  TradePlanItemEntity,
  PlanExecutionMatchEntity,
  LargeHolderReportEntity,
  LargeHolderPositionEntity,
  LargeHoldingChangeEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  AiRunEntity,
  ApiUsageCounterEntity,
  IngestionRunEntity,
  SourceCheckpointEntity,
  JobOutboxEntity,
  AlertEntity,
  AlertOutboxEntity,
  AlertDeliveryEntity,
  ReviewEntity,
  ConnectorHealthEntity,
  MessengerDeviceEntity,
  DevicePairingEntity,
  BotRoomBindingEntity,
  BotDeliveryEntity,
  BotCommandEntity,
] as const;

export { AdminEntity as UserEntity };
export { AdminTotpSecretEntity as TotpSecretEntity };
export { TotpRecoveryCodeEntity as RecoveryCodeEntity };
export { IngestionRunEntity as PollRunEntity };
export { SourceCheckpointEntity as SyncCheckpointEntity };
export { JobOutboxEntity as ProcessingOutboxEntity };
export { EventClusterItemEntity as EventSourceItemEntity };
