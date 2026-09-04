import { Inject, Injectable } from '@nestjs/common';
import {
  AlertStatus,
  ClassificationReviewResult,
  ConnectorStatus,
  DeliveryChannel,
  EffectiveFilingState,
  EventState,
  EventType,
  EvidenceGrade,
  FilingRelationType,
  Market,
  ProcessingStatus,
  RelationReviewDecision,
  RelationSource,
  ReviewTaskStatus,
  SubmissionKind,
  WatchPriority,
  type DisclosureDetailType,
} from '@orsem/contracts';
import {
  CompanyEntity,
  AlertEntity,
  AlertOutboxEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  FilingListObservationEntity,
  FilingRelationEntity,
  ProcessingOutboxEntity,
  SyncCheckpointEntity,
  PollRunEntity,
  ReviewEntity,
} from '@orsem/database';
import { OpenDartApiError } from '@orsem/opendart-parser';
import { DataSource, LessThanOrEqual, MoreThanOrEqual, type EntityManager } from 'typeorm';
import { addDateOnlyDays, nextKstMidnight, toKstDateOnly } from '../common/kst-date';
import { ConnectorHealthService } from '../connectors/connector-health.service';
import { WORKER_CONFIG, type WorkerConfig } from '../config/worker-config';
import type { PollOpenDartJob } from '../queues/job-data';
import { WorkerSchedulerService } from '../scheduling/worker-scheduler.service';
import {
  OpenDartClient,
  type OpenDartCorpCodeItem,
  type OpenDartDisclosureItem,
} from './opendart.client';
import { canProcessFiling, updateFilingClassification } from './filing-classification';

const CONNECTOR = 'OPENDART';
const RATE_LIMIT_STREAM = 'GLOBAL_RATE_LIMIT';
const MAX_LIST_PAGES = 10_000;
const MAX_TEXT_COLUMN_CHARACTERS = 16_000;

function streamName(detailType: DisclosureDetailType): string {
  return `DISCLOSURE_LIST:${detailType}`;
}

function classifySubmission(
  reportName: string,
  rm: string,
): {
  submissionKind: SubmissionKind;
  effectiveState: EffectiveFilingState;
} {
  const normalized = `${reportName} ${rm}`.normalize('NFKC');
  if (/철회/.test(normalized)) {
    return {
      submissionKind: SubmissionKind.WITHDRAWAL,
      effectiveState: EffectiveFilingState.WITHDRAWN,
    };
  }
  if (/취소/.test(normalized)) {
    return {
      submissionKind: SubmissionKind.CORRECTION,
      effectiveState: EffectiveFilingState.CANCELLED,
    };
  }
  if (/첨부.*정정/.test(normalized)) {
    return {
      submissionKind: SubmissionKind.ATTACHMENT_CORRECTION,
      effectiveState: EffectiveFilingState.ACTIVE,
    };
  }
  if (/정정/.test(normalized)) {
    return {
      submissionKind: SubmissionKind.CORRECTION,
      effectiveState: EffectiveFilingState.ACTIVE,
    };
  }
  return {
    submissionKind: SubmissionKind.INITIAL,
    effectiveState: EffectiveFilingState.ACTIVE,
  };
}

function canonicalReportName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\[(?:기재|첨부)?정정\]|\(정정\)|정정/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function shouldDeliverFilingAlert(filing: FilingEntity): boolean {
  if (filing.effectiveState === EffectiveFilingState.ACTIVE) return true;
  const sourceText = `${filing.reportName} ${filing.rm ?? ''}`.normalize('NFKC');
  return /취소|철회/.test(sourceText);
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown ingestion error').slice(0, 4000);
}

function rawDisclosureItem(item: OpenDartDisclosureItem): Record<string, unknown> {
  const { rcept_dt_raw: receiptDateRaw, ...fields } = item;
  return { ...fields, rcept_dt: receiptDateRaw };
}

@Injectable()
export class OpenDartIngestionService {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly client: OpenDartClient,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
    private readonly scheduler: WorkerSchedulerService,
    private readonly connectorHealth: ConnectorHealthService,
  ) {}

  public async poll(job: PollOpenDartJob): Promise<{
    readonly pages: number;
    readonly itemsSeen: number;
    readonly itemsCreated: number;
    readonly startDate: string;
    readonly endDate: string;
  }> {
    const stream = streamName(job.detailType);
    const checkpoint = await this.dataSource
      .getRepository(SyncCheckpointEntity)
      .findOne({ where: { connector: CONNECTOR, stream } });
    const globalPause = await this.dataSource.getRepository(SyncCheckpointEntity).findOne({
      where: { connector: CONNECTOR, stream: RATE_LIMIT_STREAM },
    });
    const pausedUntil = globalPause?.metadataJson?.pausedUntil;
    if (
      typeof pausedUntil === 'string' &&
      !Number.isNaN(Date.parse(pausedUntil)) &&
      Date.parse(pausedUntil) > Date.now()
    ) {
      if (job.reason === 'BACKFILL') {
        throw new OpenDartApiError(
          '020',
          `Persisted OpenDART circuit is open until ${pausedUntil}.`,
          'NEXT_KST_DAY',
        );
      }
      const endDate = job.endDate ?? toKstDateOnly();
      return Object.freeze({
        pages: 0,
        itemsSeen: 0,
        itemsCreated: 0,
        startDate: job.startDate ?? endDate,
        endDate,
      });
    }
    const endDate = job.endDate ?? toKstDateOnly();
    let startDate =
      job.startDate ??
      (checkpoint?.lastSuccessDate
        ? addDateOnlyDays(checkpoint.lastSuccessDate, -this.config.pollOverlapDays)
        : addDateOnlyDays(endDate, -(this.config.pollOverlapDays - 1)));
    if (startDate > endDate) throw new Error('OpenDART poll window is inverted.');
    if (addDateOnlyDays(startDate, 89) < endDate) {
      if (job.startDate || job.reason === 'BACKFILL') {
        throw new Error('OpenDART poll window exceeds the approved 90-day chunk.');
      }
      const currentWindowStart = addDateOnlyDays(endDate, -89);
      await this.scheduler.enqueueBackfill({
        detailTypes: [job.detailType],
        startDate,
        endDate: addDateOnlyDays(currentWindowStart, -1),
      });
      startDate = currentWindowStart;
    }

    const runRepository = this.dataSource.getRepository(PollRunEntity);
    const run = await runRepository.save(
      runRepository.create({
        connector: CONNECTOR,
        stream: job.reason === 'BACKFILL' ? `${stream}:BACKFILL` : stream,
        windowStart: startDate,
        windowEnd: endDate,
        status: ProcessingStatus.PROCESSING,
        itemsSeen: '0',
        itemsCreated: '0',
        startedAt: new Date(),
        finishedAt: null,
        errorMessage: null,
      }),
    );

    let itemsSeen = 0;
    let itemsCreated = 0;
    let pages = 0;
    try {
      for (let pageNumber = 1; ; pageNumber += 1) {
        if (pageNumber > MAX_LIST_PAGES) {
          throw new Error('OpenDART pagination exceeded the safety limit.');
        }
        const page = await this.client.listDisclosures({
          detailType: job.detailType,
          startDate,
          endDate,
          page: pageNumber,
        });
        if (page.totalPages > MAX_LIST_PAGES) {
          throw new Error('OpenDART declared too many result pages.');
        }
        if (page.page !== pageNumber && page.totalPages > 0) {
          throw new Error('OpenDART returned an unexpected page number.');
        }
        pages += 1;
        itemsSeen += page.items.length;
        for (const item of page.items) {
          if (await this.persistListItem(item, job.detailType, run.id, job.suppressAlerts)) {
            itemsCreated += 1;
          }
        }
        if (page.totalPages === 0 || pageNumber >= page.totalPages) break;
      }

      if (job.reason !== 'BACKFILL') {
        await this.saveCheckpoint(stream, endDate, {
          lastWindowStart: startDate,
          lastPages: pages,
          lastItemsSeen: itemsSeen,
        });
      }
      run.status = ProcessingStatus.COMPLETED;
      run.itemsSeen = String(itemsSeen);
      run.itemsCreated = String(itemsCreated);
      run.finishedAt = new Date();
      await runRepository.save(run);
      await this.connectorHealth
        .recordOpenDart(ConnectorStatus.HEALTHY, null, {
          operation: 'LIST',
          detailType: job.detailType,
        })
        .catch(() => undefined);
      return Object.freeze({ pages, itemsSeen, itemsCreated, startDate, endDate });
    } catch (error) {
      run.status = ProcessingStatus.FAILED;
      run.itemsSeen = String(itemsSeen);
      run.itemsCreated = String(itemsCreated);
      run.finishedAt = new Date();
      run.errorMessage = errorMessage(error);
      await runRepository.save(run);
      if (error instanceof OpenDartApiError && error.status === '020') {
        await this.connectorHealth
          .pauseOpenDartUntil(nextKstMidnight(), error.apiMessage)
          .catch(async () => {
            await this.savePause(nextKstMidnight()).catch(() => undefined);
          });
      } else {
        await this.connectorHealth
          .recordOpenDart(
            error instanceof OpenDartApiError && error.retryPolicy === 'NONE'
              ? ConnectorStatus.FAILED
              : ConnectorStatus.DEGRADED,
            errorMessage(error),
            { operation: 'LIST', detailType: job.detailType },
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  public async syncCorpCodes(): Promise<number> {
    try {
      const pausedUntil = await this.connectorHealth.openDartPausedUntil();
      if (pausedUntil) {
        throw new OpenDartApiError(
          '020',
          `Persisted OpenDART circuit is open until ${pausedUntil.toISOString()}.`,
          'NEXT_KST_DAY',
        );
      }
      const rows = await this.client.fetchCorpCodes();
      const repository = this.dataSource.getRepository(CompanyEntity);
      for (let offset = 0; offset < rows.length; offset += 500) {
        const chunk = rows.slice(offset, offset + 500);
        // MySQL은 법인 코드 키나 임시 KRX 종목 코드 키 중 어느 쪽이 중복되어도
        // ON DUPLICATE KEY UPDATE를 적용합니다. 행 ID를 교체하지 않으므로
        // 기업 외래 키를 유지하면서 법인 목록 갱신과 공시 주기 조회 사이의
        // 경합을 안전하게 처리합니다.
        await repository
          .createQueryBuilder()
          .insert()
          .into(CompanyEntity)
          .values(chunk.map((row) => this.companyMasterValues(row)))
          .orUpdate([
            'corpCode',
            'stockCode',
            'ticker',
            'nameKo',
            'nameEn',
            'market',
            'isListed',
            'sourceUpdatedDate',
          ])
          .execute();
      }
      await this.connectorHealth
        .recordOpenDart(ConnectorStatus.HEALTHY, null, {
          operation: 'CORP_CODE',
          rows: rows.length,
        })
        .catch(() => undefined);
      return rows.length;
    } catch (error) {
      if (error instanceof OpenDartApiError && error.status === '020') {
        await this.connectorHealth
          .pauseOpenDartUntil(nextKstMidnight(), error.apiMessage)
          .catch(async () => {
            await this.savePause(nextKstMidnight()).catch(() => undefined);
          });
      } else {
        await this.connectorHealth
          .recordOpenDart(
            error instanceof OpenDartApiError && error.retryPolicy === 'NONE'
              ? ConnectorStatus.FAILED
              : ConnectorStatus.DEGRADED,
            errorMessage(error),
            { operation: 'CORP_CODE' },
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private companyMasterValues(row: OpenDartCorpCodeItem): {
    market: Market;
    corpCode: string;
    stockCode: string | null;
    ticker: string | null;
    cik: null;
    nameKo: string;
    nameEn: string | null;
    isListed: boolean;
    sourceUpdatedDate: string;
  } {
    const listed = /^[0-9A-Z]{6}$/.test(row.stock_code);
    const sourceUpdatedDate = `${row.modify_date.slice(0, 4)}-${row.modify_date.slice(4, 6)}-${row.modify_date.slice(6, 8)}`;
    // 주기 조회 기간에 사용하는 엄격한 달력 날짜 검증기를 재사용합니다.
    addDateOnlyDays(sourceUpdatedDate, 0);
    return {
      market: listed ? Market.KRX : Market.OTHER,
      corpCode: row.corp_code,
      stockCode: listed ? row.stock_code : null,
      ticker: listed ? row.stock_code : null,
      cik: null,
      nameKo: row.corp_name.slice(0, 255),
      nameEn: row.corp_eng_name ? row.corp_eng_name.slice(0, 255) : null,
      isListed: listed,
      sourceUpdatedDate,
    };
  }

  private async persistListItem(
    item: OpenDartDisclosureItem,
    detailType: DisclosureDetailType,
    ingestionRunId: string,
    suppressAlerts: boolean,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const companyRepository = manager.getRepository(CompanyEntity);
      let company = await companyRepository.findOne({
        where: { corpCode: item.corp_code },
      });
      if (!company) {
        if (item.stock_code) {
          // corpCode.xml 동기화 전에 관심 목록이 종목 코드만 있는 임시 행을
          // 만들었을 수 있습니다. 먼저 정확히 일치하는 기존 식별 행을 연결하며,
          // NULL 조건을 함께 검사해 동시 조회에서도 같은 결과를 유지합니다.
          await companyRepository
            .createQueryBuilder()
            .update(CompanyEntity)
            .set({
              corpCode: item.corp_code,
              ticker: item.stock_code,
              isListed: true,
            })
            .where('market = :market', { market: Market.KRX })
            .andWhere('stock_code = :stockCode', {
              stockCode: item.stock_code,
            })
            .andWhere('corp_code IS NULL')
            .execute();
          company = await companyRepository
            .createQueryBuilder('company')
            .setLock('pessimistic_write')
            .where('company.corpCode = :corpCode', {
              corpCode: item.corp_code,
            })
            .getOne();
        }
      }
      if (!company) {
        await companyRepository
          .createQueryBuilder()
          .insert()
          .into(CompanyEntity)
          .values({
            market: item.stock_code ? Market.KRX : Market.OTHER,
            corpCode: item.corp_code,
            stockCode: item.stock_code || null,
            ticker: item.stock_code || null,
            cik: null,
            nameKo: item.corp_name.slice(0, 255),
            nameEn: null,
            isListed: Boolean(item.stock_code),
            sourceUpdatedDate: null,
          })
          .orIgnore()
          .execute();
        // 잠금 조회는 스냅샷 기반 findOne과 달리 MySQL REPEATABLE READ에서도
        // 다른 트랜잭션이 방금 커밋한 INSERT를 확인합니다.
        company = await companyRepository
          .createQueryBuilder('company')
          .setLock('pessimistic_write')
          .where('company.corpCode = :corpCode', {
            corpCode: item.corp_code,
          })
          .getOne();
        if (!company) {
          throw new Error(
            'Company insert conflicted with another unique identity; corp master reconciliation is required.',
          );
        }
      }

      const filingRepository = manager.getRepository(FilingEntity);
      let filing = await filingRepository
        .createQueryBuilder('filing')
        .setLock('pessimistic_write')
        .where('filing.source = :source AND filing.rceptNo = :rceptNo', {
          source: CONNECTOR,
          rceptNo: item.rcept_no,
        })
        .getOne();
      const created = !filing;
      const state = classifySubmission(item.report_nm, item.rm);
      const observedAt = new Date();
      if (!filing) {
        filing = filingRepository.create({
          source: CONNECTOR,
          rceptNo: item.rcept_no,
          companyId: company.id,
          detailType,
          reportName: item.report_nm.slice(0, MAX_TEXT_COLUMN_CHARACTERS),
          filerName: item.flr_nm.slice(0, 255),
          rceptDate: item.rcept_dt,
          rm: item.rm ? item.rm.slice(0, MAX_TEXT_COLUMN_CHARACTERS) : null,
          submissionKind: state.submissionKind,
          effectiveState: state.effectiveState,
          firstObservedAt: observedAt,
          lastSeenAt: observedAt,
          rawListJson: rawDisclosureItem(item),
          activeParseRunId: null,
        });
      } else {
        const authoritativeEffectiveState = filing.effectiveState;
        filing.companyId = company.id;
        filing.reportName = item.report_nm.slice(0, MAX_TEXT_COLUMN_CHARACTERS);
        filing.filerName = item.flr_nm.slice(0, 255);
        filing.rceptDate = item.rcept_dt;
        filing.rm = item.rm ? item.rm.slice(0, MAX_TEXT_COLUMN_CHARACTERS) : null;
        filing.submissionKind = state.submissionKind;
        // 확정된 정정·취소 계보 판단은 이전 상태로 되돌리지 않습니다.
        // 원본 INITIAL 행을 다시 관측해도 그 행의 제목이 바뀌지 않았다는
        // 이유만으로 ACTIVE 상태를 복원해서는 안 됩니다.
        filing.effectiveState =
          authoritativeEffectiveState === EffectiveFilingState.ACTIVE
            ? state.effectiveState
            : authoritativeEffectiveState;
        filing.lastSeenAt = observedAt;
        filing.rawListJson = rawDisclosureItem(item);
      }
      updateFilingClassification(filing, item.report_nm, detailType);
      filing = await filingRepository.save(filing);
      await manager.getRepository(FilingListObservationEntity).save({
        filingId: filing.id,
        observedAt,
        queryDetailType: detailType,
        rawListJson: rawDisclosureItem(item),
        ingestionRunId,
      });

      // Unsupported/ambiguous documents remain auditable observations, never D005 events.
      if (!canProcessFiling(filing)) return created;

      const outboxRepository = manager.getRepository(ProcessingOutboxEntity);
      const dedupeKey = `opendart:${filing.canonicalType}:${item.rcept_no}:enrich:${filing.classifierVersion}`;
      if (!(await outboxRepository.findOne({ where: { kind: 'ENRICH_FILING', dedupeKey } }))) {
        await outboxRepository.save({
          kind: 'ENRICH_FILING',
          dedupeKey,
          payloadJson: {
            filingId: filing.id,
            rceptNo: filing.rceptNo,
            detailType: filing.detailType,
            suppressAlerts,
          },
          status: ProcessingStatus.PENDING,
          availableAt: observedAt,
          attempts: 0,
          lockedAt: null,
          lastError: null,
        });
      }

      if (created && state.submissionKind !== SubmissionKind.INITIAL) {
        await this.linkCorrection(manager, filing, company.id);
      } else if (created) {
        await this.linkWaitingCorrections(manager, filing, company.id);
      }
      if (created) {
        const currentFiling =
          (await filingRepository.findOne({ where: { id: filing.id } })) ?? filing;
        await this.materializeDetectionEvent(
          manager,
          currentFiling,
          company.nameKo,
          suppressAlerts,
        );
        if (!suppressAlerts) {
          const discoveryDedupeKey = `naver:filing:${filing.rceptNo}:discovery:v1`;
          if (
            !(await outboxRepository.findOne({
              where: {
                kind: 'DISCOVER_NEWS_LINKS',
                dedupeKey: discoveryDedupeKey,
              },
            }))
          ) {
            await outboxRepository.save({
              kind: 'DISCOVER_NEWS_LINKS',
              dedupeKey: discoveryDedupeKey,
              payloadJson: {
                connectors: ['NAVER'],
                priorities: [WatchPriority.P3],
                companyIds: [company.id],
                reason: 'DISCLOSURE_TRIGGER',
                triggerFilingId: filing.id,
              },
              status: ProcessingStatus.PENDING,
              availableAt: observedAt,
              attempts: 0,
              lockedAt: null,
              lastError: null,
            });
          }
        }
      }
      return created;
    });
  }

  private async materializeDetectionEvent(
    manager: EntityManager,
    filing: FilingEntity,
    companyName: string,
    suppressAlerts: boolean,
  ): Promise<void> {
    if (!canProcessFiling(filing)) return;
    const eventRepository = manager.getRepository(EventClusterEntity);
    const dedupeKey = `opendart:filing:${filing.id}`;
    let event = await eventRepository.findOne({ where: { dedupeKey } });
    if (!event) {
      event = await eventRepository.save({
        canonicalEventType:
          filing.detailType === 'D001'
            ? EventType.LARGE_HOLDER
            : filing.detailType === 'D005'
              ? EventType.TRADE_PLAN
              : EventType.INSIDER_OWNERSHIP,
        companyId: filing.companyId,
        occurredAt: null,
        // OpenDART 목록은 접수 날짜만 제공하며 공시 시각은 제공하지 않습니다.
        publishedAt: null,
        firstObservedAt: filing.firstObservedAt,
        processedAt: null,
        state:
          filing.effectiveState === EffectiveFilingState.CANCELLED ||
          filing.effectiveState === EffectiveFilingState.WITHDRAWN
            ? EventState.CANCELLED
            : filing.effectiveState === EffectiveFilingState.SUPERSEDED
              ? EventState.SUPERSEDED
              : EventState.OPEN,
        evidenceGrade: EvidenceGrade.A,
        summary: `[${filing.detailType} 공시 감지] ${companyName} — ${filing.reportName} (원문 분석 중)`,
        dedupeKey,
        metadataJson: {
          rceptNo: filing.rceptNo,
          detailType: filing.detailType,
          phase: 'DETECTED',
        },
      });
      await manager.getRepository(EventClusterItemEntity).save({
        eventClusterId: event.id,
        itemType: 'FILING',
        itemId: filing.id,
        isPrimary: true,
        provenanceJson: { source: CONNECTOR, phase: 'LIST' },
      });
    }
    if (suppressAlerts || !shouldDeliverFilingAlert(filing)) {
      return;
    }
    const idempotencyKey = `${event.id}:WEB:detected:v1`;
    const alertRepository = manager.getRepository(AlertEntity);
    if (await alertRepository.findOne({ where: { idempotencyKey } })) return;
    const payload = {
      phase: 'DETECTED',
      filingId: filing.id,
      detailType: filing.detailType,
      companyName,
      reportName: filing.reportName,
      rceptNo: filing.rceptNo,
      rceptDate: filing.rceptDate,
      officialUrl: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${filing.rceptNo}`,
      message: '원문 분석 중이며 투자 매매 신호가 아닙니다.',
    };
    const alert = await alertRepository.save({
      eventClusterId: event.id,
      idempotencyKey,
      status: AlertStatus.PENDING,
      alertVersion: 1,
      payloadJson: payload,
    });
    await manager.getRepository(AlertOutboxEntity).save({
      alertId: alert.id,
      channel: DeliveryChannel.WEB,
      idempotencyKey,
      status: AlertStatus.PENDING,
      payload,
      availableAt: new Date(),
      attempts: 0,
      lastError: null,
    });
  }

  private async linkCorrection(
    manager: EntityManager,
    filing: FilingEntity,
    companyId: string,
  ): Promise<void> {
    const candidates = await manager.getRepository(FilingEntity).find({
      where: {
        companyId,
        detailType: filing.detailType,
        rceptDate: LessThanOrEqual(filing.rceptDate),
      },
      order: { rceptDate: 'DESC', firstObservedAt: 'DESC' },
      take: 20,
    });
    const original = candidates.find(
      (candidate) =>
        candidate.id !== filing.id &&
        canonicalReportName(candidate.reportName) === canonicalReportName(filing.reportName) &&
        candidate.filerName === filing.filerName,
    );
    if (!original) return;
    const relationType =
      filing.submissionKind === SubmissionKind.WITHDRAWAL
        ? FilingRelationType.WITHDRAWS
        : filing.effectiveState === EffectiveFilingState.CANCELLED
          ? FilingRelationType.CANCELS
          : FilingRelationType.CORRECTS;
    const relationRepository = manager.getRepository(FilingRelationEntity);
    let relation = await relationRepository.findOne({
      where: {
        fromFilingId: filing.id,
        toFilingId: original.id,
        relationType,
      },
    });
    if (!relation) {
      relation = await relationRepository.save({
        fromFilingId: filing.id,
        toFilingId: original.id,
        relationType,
        confidence: '0.700000',
        source: RelationSource.HEURISTIC,
        reviewRequired: true,
        reviewDecision: RelationReviewDecision.PENDING,
        reviewedByAdminId: null,
        reviewedAt: null,
        matchedFieldsJson: ['companyId', 'detailType', 'reportName', 'filerName'],
      });
    }
    const reviewRepository = manager.getRepository(ReviewEntity);
    const reviewDedupeKey = `lineage:${relation.id}`;
    if (
      !(await reviewRepository.findOne({
        where: {
          subjectType: 'FILING_RELATION',
          subjectId: relation.id,
          dedupeKey: reviewDedupeKey,
        },
      }))
    ) {
      await reviewRepository.save({
        subjectType: 'FILING_RELATION',
        subjectId: relation.id,
        dedupeKey: reviewDedupeKey,
        reason:
          '정정·취소·철회 원공시 연결은 목록 메타데이터 기반 후보이므로 원문 또는 관리자 확인이 필요합니다.',
        status: ReviewTaskStatus.OPEN,
        classificationResult: ClassificationReviewResult.REVIEW_REQUIRED,
        resolution: null,
        resolvedByAdminId: null,
        resolvedAt: null,
      });
    }
    // 목록 메타데이터에는 원본 접수 번호를 확정할 근거가 없습니다. 따라서 검토가 필요한
    // 계보 후보로 유지하며, 상태 전환과 알림 취소에는 출처의 명시적 참조나
    // 수동 승인이 필요합니다.
  }

  private async linkWaitingCorrections(
    manager: EntityManager,
    original: FilingEntity,
    companyId: string,
  ): Promise<void> {
    const possibleCorrections = await manager.getRepository(FilingEntity).find({
      where: {
        companyId,
        detailType: original.detailType,
        rceptDate: MoreThanOrEqual(original.rceptDate),
      },
      order: { rceptDate: 'ASC', firstObservedAt: 'ASC' },
      take: 100,
    });
    for (const correction of possibleCorrections) {
      if (
        correction.id === original.id ||
        correction.submissionKind === SubmissionKind.INITIAL ||
        correction.filerName !== original.filerName ||
        canonicalReportName(correction.reportName) !== canonicalReportName(original.reportName)
      ) {
        continue;
      }
      await this.linkCorrection(manager, correction, companyId);
    }
  }

  private async saveCheckpoint(
    stream: string,
    lastSuccessDate: string,
    metadataJson: Record<string, unknown>,
  ): Promise<void> {
    const repository = this.dataSource.getRepository(SyncCheckpointEntity);
    const checkpoint =
      (await repository.findOne({ where: { connector: CONNECTOR, stream } })) ??
      repository.create({ connector: CONNECTOR, stream });
    checkpoint.lastSuccessDate = lastSuccessDate;
    checkpoint.cursor = null;
    checkpoint.lastSuccessAt = new Date();
    checkpoint.metadataJson = metadataJson;
    await repository.save(checkpoint);
  }

  private async savePause(until: Date): Promise<void> {
    const repository = this.dataSource.getRepository(SyncCheckpointEntity);
    const checkpoint =
      (await repository.findOne({
        where: { connector: CONNECTOR, stream: RATE_LIMIT_STREAM },
      })) ??
      repository.create({
        connector: CONNECTOR,
        stream: RATE_LIMIT_STREAM,
        lastSuccessDate: null,
        cursor: null,
        lastSuccessAt: null,
      });
    checkpoint.metadataJson = {
      ...(checkpoint.metadataJson ?? {}),
      pausedUntil: until.toISOString(),
      pauseReason: 'OPENDART_STATUS_020',
    };
    await repository.save(checkpoint);
  }
}
