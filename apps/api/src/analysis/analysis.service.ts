import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  analysisSelectionSchema,
  type AnalysisSelection,
  type AnalysisRun,
  type AnalysisReport,
  type AnalysisExportRequest,
  type AnalysisDocument,
  type AnalysisDiff,
  type AnalysisNote,
  type SavedAnalysisQuery,
  type ExportManifest,
  type AnalysisBookmark,
  type AnalysisMapping,
  type AnalysisValidation,
} from '@orsem/contracts';
import { parseWith } from '../common/zod';
import {
  WatchlistAccessService,
  sqlBoolean,
  sqlInstant,
  type GroupActor,
} from '../watchlist-groups/watchlist-access.service';
import { AnalysisConfig } from './analysis-config';
import {
  analysisArray,
  analysisJson,
  publicAnalysisJson,
  readAnalysisArtifact,
  safeAnalysisUrl,
} from './analysis-artifacts';

type Row = Record<string, unknown> & { id: string };
const placeholders = (ids: readonly unknown[]) => ids.map(() => '?').join(',');
const instant = (value: unknown): string | null =>
  value ? sqlInstant(value as string | Date) : null;
const date = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString().slice(0, 10)
    : typeof value === 'string'
      ? value.slice(0, 10)
      : null;
const ids = (value: unknown): string[] =>
  analysisArray(value).filter((entry): entry is string => typeof entry === 'string');
const official = (row: Row) => {
  if (row.rights_mode !== 'OFFICIAL_PUBLIC_DATA')
    throw new ForbiddenException('원문 이용 정책상 이 자료는 분석할 수 없습니다.');
};

@Injectable()
export class AnalysisService {
  constructor(
    private readonly access: WatchlistAccessService,
    private readonly config: AnalysisConfig,
  ) {}

  capabilities() {
    return {
      enabled: this.config.enabled,
      documents: this.config.documentsEnabled,
      notes: this.config.notesEnabled,
    };
  }

  private enabled(feature: 'analysis' | 'documents' | 'notes' = 'analysis') {
    if (
      !(feature === 'documents'
        ? this.config.documentsEnabled
        : feature === 'notes'
          ? this.config.notesEnabled
          : this.config.enabled)
    ) {
      throw new NotFoundException('이 분석 기능은 아직 활성화되지 않았습니다.');
    }
  }

  private transaction<T>(actor: GroupActor, work: (m: EntityManager) => Promise<T>): Promise<T> {
    this.enabled();
    return this.access.transaction(actor, work);
  }

  private async selectionCompanies(
    m: EntityManager,
    actor: GroupActor,
    selection: AnalysisSelection,
  ): Promise<string[]> {
    let selected = selection.companyIds;
    if (selection.groupId) {
      let members: Array<{ company_id: string }>;
      if (selection.groupId === 'operational') {
        members = await m.query(
          'SELECT company_id FROM market_leader_watchlist ORDER BY priority,company_id',
        );
      } else {
        await this.access.group(m, actor, selection.groupId);
        members = await m.query(
          'SELECT company_id FROM watchlist_group_items WHERE group_id=? ORDER BY position,company_id',
          [selection.groupId],
        );
      }
      const accessible = new Set(members.map((row) => row.company_id));
      if (selected.some((id) => !accessible.has(id)))
        throw new ForbiddenException('선택한 그룹에 없는 기업입니다.');
      selected = selected.length ? selected : [...accessible];
    }
    selected = [...new Set(selected)];
    if (!selected.length || selected.length > 20)
      throw new BadRequestException('그룹에서 분석할 기업을 1개부터 20개까지 선택하세요.');
    const companies: Array<{ id: string }> = await m.query(
      `SELECT id FROM companies WHERE id IN (${placeholders(selected)})`,
      selected,
    );
    if (companies.length !== selected.length)
      throw new BadRequestException('선택한 기업을 확인할 수 없습니다.');
    if (selection.reportIds?.length) {
      const reports: Row[] = await m.query(
        `SELECT id,company_id,rights_mode FROM analysis_reports WHERE id IN (${placeholders(selection.reportIds)})`,
        selection.reportIds,
      );
      if (
        reports.length !== new Set(selection.reportIds).size ||
        reports.some((r) => !selected.includes(String(r.company_id)))
      ) {
        throw new BadRequestException('선택한 제출본이 기업 범위와 일치하지 않습니다.');
      }
      reports.forEach(official);
    }
    return selected;
  }

  private runView(row: Row): AnalysisRun {
    const progress = analysisJson(row.progress_json);
    return {
      id: row.id,
      savedQueryId: row.saved_query_id as string | null,
      parentRunId: row.parent_run_id as string | null,
      status: row.status as AnalysisRun['status'],
      selection: analysisJson(row.selection_json) as unknown as AnalysisSelection,
      companyIds: ids(row.company_ids_json),
      result: row.result_json
        ? (publicAnalysisJson(analysisJson(row.result_json)) as AnalysisRun['result'])
        : null,
      progress: {
        completed: Number.isFinite(progress.completed) ? Number(progress.completed) : 0,
        total: Number.isFinite(progress.total) ? Number(progress.total) : 0,
        ...(typeof progress.message === 'string'
          ? { message: progress.message.slice(0, 500) }
          : {}),
      },
      errorMessage: row.error_message ? '분석 처리에 실패했습니다. 잠시 후 다시 시도하세요.' : null,
      nextAttemptAt: instant(row.next_attempt_at),
      createdAt: instant(row.created_at)!,
      updatedAt: instant(row.updated_at)!,
      completedAt: instant(row.completed_at),
    };
  }

  private async ownedRun(m: EntityManager, actor: GroupActor, id: string): Promise<Row> {
    const [run]: Row[] = await m.query(
      'SELECT * FROM analysis_runs WHERE id=? AND owner_key=? FOR UPDATE',
      [id, actor.key],
    );
    if (!run) throw new NotFoundException('분석 실행을 찾을 수 없습니다.');
    for (const reportId of ids(analysisJson(run.result_json).reportIds))
      await this.report(m, reportId);
    return run;
  }

  private async job(
    m: EntityManager,
    kind: string,
    entityId: string,
    payload: Record<string, unknown>,
  ) {
    await m.query(
      "INSERT INTO analysis_jobs(id,kind,entity_id,status,attempts,available_at,payload_json,created_at,updated_at) VALUES (?,?,?,'PENDING',0,UTC_TIMESTAMP(6),?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE status=IF(status IN ('FAILED','COMPLETE'),'PENDING',status),available_at=UTC_TIMESTAMP(6),payload_json=VALUES(payload_json),updated_at=UTC_TIMESTAMP(6)",
      [randomUUID(), kind, entityId, JSON.stringify(payload)],
    );
  }

  private async createRunIn(
    m: EntityManager,
    actor: GroupActor,
    selection: AnalysisSelection,
    savedQueryId: string | null = null,
    parentRunId: string | null = null,
  ): Promise<AnalysisRun> {
    const companyIds = await this.selectionCompanies(m, actor, selection);
    selection = { ...selection, companyIds };
    const id = randomUUID();
    await m.query(
      "INSERT INTO analysis_runs(id,owner_key,saved_query_id,parent_run_id,status,selection_json,company_ids_json,progress_json,created_at,updated_at) VALUES (?,?,?,?,'QUEUED',?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
      [
        id,
        actor.key,
        savedQueryId,
        parentRunId,
        JSON.stringify(selection),
        JSON.stringify(companyIds),
        JSON.stringify({
          completed: 0,
          total:
            companyIds.length * Math.max(selection.periods.length, selection.rolling?.count ?? 1),
        }),
      ],
    );
    await this.job(m, 'RUN', id, { runId: id });
    return this.runView(await this.ownedRun(m, actor, id));
  }

  createRun(actor: GroupActor, input: AnalysisSelection) {
    return this.transaction(actor, (m) =>
      this.createRunIn(m, actor, parseWith(analysisSelectionSchema, input)),
    );
  }

  getRun(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) => this.runView(await this.ownedRun(m, actor, id)));
  }

  listRuns(actor: GroupActor, savedQueryId?: string) {
    return this.transaction(actor, async (m) => {
      const rows: Row[] = await m.query(
        `SELECT * FROM analysis_runs WHERE owner_key=?${savedQueryId ? ' AND saved_query_id=?' : ''} ORDER BY created_at DESC,id DESC LIMIT 100`,
        [actor.key, ...(savedQueryId ? [savedQueryId] : [])],
      );
      const items: AnalysisRun[] = [];
      for (const row of rows) {
        try {
          for (const reportId of ids(analysisJson(row.result_json).reportIds))
            await this.report(m, reportId);
        } catch (error) {
          if (error instanceof NotFoundException || error instanceof ForbiddenException) continue;
          throw error;
        }
        items.push(this.runView(row));
      }
      return { items };
    });
  }

  retryRun(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) => {
      const old = await this.ownedRun(m, actor, id);
      if (!['PARTIAL', 'WAITING', 'FAILED'].includes(String(old.status)))
        throw new ConflictException(
          '완료 대기 중인 작업이나 정상 완료된 작업은 재시도할 수 없습니다.',
        );
      if (old.next_attempt_at && new Date(instant(old.next_attempt_at)!).getTime() > Date.now())
        throw new ConflictException('수집 제공자의 대기 시간이 끝난 뒤 다시 시도하세요.');
      const [existing]: Row[] = await m.query(
        "SELECT * FROM analysis_runs WHERE owner_key=? AND parent_run_id=? AND status IN ('QUEUED','RUNNING','WAITING') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [actor.key, id],
      );
      if (existing) return this.runView(existing);
      return this.createRunIn(
        m,
        actor,
        parseWith(analysisSelectionSchema, analysisJson(old.selection_json)),
        old.saved_query_id as string | null,
        id,
      );
    });
  }

  periods(actor: GroupActor, companyId: string) {
    return this.transaction(actor, async (m) => {
      const rows: Row[] = await m.query(
        "SELECT * FROM analysis_reports WHERE company_id=? AND rights_mode='OFFICIAL_PUBLIC_DATA' ORDER BY report_year DESC,period_end DESC,first_observed_at DESC,id DESC LIMIT 400",
        [companyId],
      );
      return {
        items: rows.map((r): AnalysisReport => ({
          id: r.id,
          companyId: String(r.company_id),
          source: r.source as AnalysisReport['source'],
          filingId: String(r.filing_id),
          reportYear: Number(r.report_year),
          reportCode: r.report_code as AnalysisReport['reportCode'],
          scope: r.scope as AnalysisReport['scope'],
          periodStart: date(r.period_start),
          periodEnd: date(r.period_end),
          publicationDate: date(r.publication_date),
          firstObservedAt: instant(r.first_observed_at)!,
          sourceUrl: safeAnalysisUrl(r.source_url) ?? '',
        })),
      };
    });
  }

  private savedView(row: Row): SavedAnalysisQuery {
    return {
      id: row.id,
      name: String(row.name),
      selection: analysisJson(row.selection_json) as unknown as AnalysisSelection,
      autoRefresh: sqlBoolean(row.auto_refresh),
      createdAt: instant(row.created_at)!,
      updatedAt: instant(row.updated_at)!,
    };
  }

  listSaved(actor: GroupActor) {
    return this.transaction(actor, async (m) => {
      const rows: Row[] = await m.query(
        'SELECT * FROM analysis_saved_queries WHERE owner_key=? ORDER BY updated_at DESC,id DESC LIMIT 100',
        [actor.key],
      );
      const items: SavedAnalysisQuery[] = [];
      for (const row of rows) items.push(this.savedView(row));
      return { items };
    });
  }

  saveQuery(
    actor: GroupActor,
    input: { name: string; selection: AnalysisSelection; autoRefresh: boolean },
    id?: string,
  ) {
    return this.transaction(actor, async (m) => {
      const companyIds = await this.selectionCompanies(m, actor, input.selection);
      input = { ...input, selection: { ...input.selection, companyIds } };
      const queryId = id ?? randomUUID();
      if (id) {
        const [old]: Row[] = await m.query(
          'SELECT * FROM analysis_saved_queries WHERE id=? AND owner_key=? FOR UPDATE',
          [id, actor.key],
        );
        if (!old) throw new NotFoundException('저장한 조회를 찾을 수 없습니다.');
        await m.query(
          'UPDATE analysis_saved_queries SET name=?,selection_json=?,auto_refresh=?,last_trigger_key=NULL,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND owner_key=?',
          [input.name, JSON.stringify(input.selection), input.autoRefresh, id, actor.key],
        );
      } else {
        const [count]: Array<{ total: number }> = await m.query(
          'SELECT COUNT(*) total FROM analysis_saved_queries WHERE owner_key=?',
          [actor.key],
        );
        if (Number(count?.total) >= 100)
          throw new ConflictException('저장한 조회는 최대 100개까지 보관할 수 있습니다.');
        await m.query(
          'INSERT INTO analysis_saved_queries(id,owner_key,name,selection_json,auto_refresh,created_at,updated_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))',
          [queryId, actor.key, input.name, JSON.stringify(input.selection), input.autoRefresh],
        );
      }
      const [row]: Row[] = await m.query(
        'SELECT * FROM analysis_saved_queries WHERE id=? AND owner_key=?',
        [queryId, actor.key],
      );
      return this.savedView(row!);
    });
  }

  deleteSaved(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) => {
      // Deleting one's saved trigger remains possible after leaving its shared group.
      const [row]: Row[] = await m.query(
        'SELECT id FROM analysis_saved_queries WHERE id=? AND owner_key=? FOR UPDATE',
        [id, actor.key],
      );
      if (!row) throw new NotFoundException('저장한 조회를 찾을 수 없습니다.');
      await m.query('DELETE FROM analysis_saved_queries WHERE id=? AND owner_key=?', [
        id,
        actor.key,
      ]);
    });
  }

  runSaved(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) => {
      const [row]: Row[] = await m.query(
        'SELECT * FROM analysis_saved_queries WHERE id=? AND owner_key=? FOR UPDATE',
        [id, actor.key],
      );
      if (!row) throw new NotFoundException('저장한 조회를 찾을 수 없습니다.');
      return this.createRunIn(
        m,
        actor,
        parseWith(analysisSelectionSchema, analysisJson(row.selection_json)),
        id,
      );
    });
  }

  private async report(m: EntityManager, id: string): Promise<Row> {
    const [row]: Row[] = await m.query('SELECT * FROM analysis_reports WHERE id=?', [id]);
    if (!row) throw new NotFoundException('보존된 제출본을 찾을 수 없습니다.');
    official(row);
    return row;
  }

  private async filing(m: EntityManager, id: string): Promise<Row> {
    const [row]: Row[] = await m.query(
      "SELECT f.*,d.rights_mode document_rights_mode,d.object_uri raw_uri,d.sha256 raw_sha256,d.media_type FROM filings f LEFT JOIN filing_documents d ON d.id=(SELECT fd.id FROM filing_documents fd WHERE fd.filing_id=f.id ORDER BY fd.retrieved_at DESC,fd.id DESC LIMIT 1) WHERE (f.id=? OR f.rcept_no=?) AND f.source='OPENDART'",
      [id, id],
    );
    if (!row || !/^\d{14}$/u.test(String(row.rcept_no)))
      throw new NotFoundException('공식 공시를 찾을 수 없습니다.');
    if (row.document_rights_mode && row.document_rights_mode !== 'OFFICIAL_PUBLIC_DATA')
      throw new ForbiddenException('이 공시 원문은 분석할 수 없는 이용 정책입니다.');
    return { ...row, source_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${row.rcept_no}` };
  }

  private async document(m: EntityManager, id: string): Promise<Row> {
    const [row]: Row[] = await m.query('SELECT * FROM analysis_documents WHERE id=?', [id]);
    if (!row) throw new NotFoundException('분석 문서를 찾을 수 없습니다.');
    official(row);
    if (row.report_id) await this.report(m, String(row.report_id));
    if (row.filing_id) await this.filing(m, String(row.filing_id));
    if (row.source_item_id) {
      const [source]: Row[] = await m.query(
        'SELECT id,rights_mode,source FROM source_items WHERE id=?',
        [row.source_item_id],
      );
      if (!source || !['SEC', 'OPENDART'].includes(String(source.source)))
        throw new NotFoundException('공식 원문 출처를 찾을 수 없습니다.');
      official(source);
    }
    if (!row.report_id && !row.source_item_id && !row.filing_id)
      throw new ForbiddenException('검증된 원문 출처가 없는 문서입니다.');
    return row;
  }

  private async scopedDocument(m: EntityManager, run: Row, id: string): Promise<Row> {
    const row = await this.document(m, id);
    const companies = ids(run.company_ids_json);
    let company: unknown;
    if (row.report_id) company = (await this.report(m, String(row.report_id))).company_id;
    else if (row.filing_id) company = (await this.filing(m, String(row.filing_id))).company_id;
    else {
      const [source]: Row[] = await m.query('SELECT id,company_id FROM source_items WHERE id=?', [
        row.source_item_id,
      ]);
      company = source?.company_id;
    }
    if (!companies.includes(String(company)))
      throw new ForbiddenException('이 분석에 포함되지 않은 기업의 문서입니다.');
    return { ...row, analysis_company_id: company };
  }

  private noteView(row: Row): AnalysisNote {
    return {
      id: row.id,
      documentId: String(row.document_id),
      key: String(row.note_key),
      title: String(row.title),
      text: String(row.body),
      tableIds: ids(row.table_ids_json),
      sourceUrl: safeAnalysisUrl(row.source_url) ?? '',
    };
  }

  private async documentView(m: EntityManager, row: Row): Promise<AnalysisDocument> {
    const notes: Row[] = this.config.notesEnabled
      ? await m.query(
          'SELECT * FROM analysis_notes WHERE document_id=? ORDER BY note_key,id LIMIT 2000',
          [row.id],
        )
      : [];
    return {
      id: row.id,
      reportId: row.report_id as string | null,
      filingId: row.filing_id as string | null,
      sourceItemId: row.source_item_id as string | null,
      sourceUrl: safeAnalysisUrl(row.source_url) ?? '',
      rightsMode: String(row.rights_mode),
      sha256: String(row.raw_sha256 ?? ''),
      parserVersion: String(row.parser_version ?? ''),
      status: row.status as AnalysisDocument['status'],
      tables: publicAnalysisJson(analysisArray(row.tables_json)) as AnalysisDocument['tables'],
      notes: notes.map((r) => this.noteView(r)),
      ownership: row.ownership_json
        ? (publicAnalysisJson(analysisJson(row.ownership_json)) as AnalysisDocument['ownership'])
        : null,
      errorMessage: row.error_message
        ? '원문을 처리하지 못했습니다. 수집 상태를 확인하세요.'
        : null,
    };
  }

  private async linkRunArtifact(
    m: EntityManager,
    run: Row,
    key: 'documentIds' | 'diffIds',
    artifactId: string,
  ) {
    const result: Record<string, unknown> = {
      facts: [],
      issues: [],
      reportIds: [],
      documentIds: [],
      diffIds: [],
      validations: [],
      mappingVersion: 'pending',
      ...analysisJson(run.result_json),
    };
    result[key] = [...new Set([...ids(result[key]), artifactId])];
    run.result_json = result;
    await m.query(
      'UPDATE analysis_runs SET result_json=?,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND owner_key=?',
      [JSON.stringify(result), run.id, run.owner_key],
    );
  }

  getDocument(actor: GroupActor, id: string) {
    this.enabled('documents');
    return this.transaction(actor, async (m) => this.documentView(m, await this.document(m, id)));
  }

  createDocument(
    actor: GroupActor,
    input: {
      runId: string;
      reportId?: string;
      sourceItemId?: string;
      eventId?: string;
      filingId?: string;
    },
  ) {
    this.enabled('documents');
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, input.runId);
      await this.selectionCompanies(
        m,
        actor,
        parseWith(analysisSelectionSchema, analysisJson(run.selection_json)),
      );
      if (input.eventId) {
        let sources: Row[] = await m.query(
          "SELECT s.id FROM event_cluster_items e JOIN source_items s ON e.item_type='SOURCE_ITEM' AND e.item_id=s.id WHERE e.event_cluster_id=? AND s.source IN ('SEC','OPENDART') AND s.rights_mode='OFFICIAL_PUBLIC_DATA' ORDER BY e.is_primary DESC,s.id LIMIT 2",
          [input.eventId],
        );
        if (!sources.length)
          sources = await m.query(
            "SELECT id FROM source_items WHERE id=? AND source IN ('SEC','OPENDART') AND rights_mode='OFFICIAL_PUBLIC_DATA'",
            [input.eventId],
          );
        if (sources.length === 1) input = { runId: input.runId, sourceItemId: sources[0]!.id };
        else if (sources.length > 1)
          throw new BadRequestException('이 사건의 여러 원문 중 분석할 문서를 선택하세요.');
        else {
          const filings: Row[] = await m.query(
            "SELECT f.id FROM event_cluster_items e JOIN filings f ON e.item_type='FILING' AND e.item_id=f.id WHERE e.event_cluster_id=? ORDER BY e.is_primary DESC,f.id LIMIT 2",
            [input.eventId],
          );
          if (filings.length > 1)
            throw new BadRequestException('이 사건의 여러 공시 중 분석할 문서를 선택하세요.');
          input = { runId: input.runId, filingId: filings[0]?.id ?? input.eventId };
        }
      }
      let source: Row;
      if (input.reportId) source = await this.report(m, input.reportId);
      else if (input.filingId) {
        source = await this.filing(m, input.filingId);
        input = { runId: input.runId, filingId: source.id };
      } else {
        const [item]: Row[] = await m.query(
          "SELECT * FROM source_items WHERE id=? AND source IN ('SEC','OPENDART')",
          [input.sourceItemId],
        );
        if (!item) throw new NotFoundException('공식 원문을 찾을 수 없습니다.');
        official(item);
        source = item;
      }
      if (!ids(run.company_ids_json).includes(String(source.company_id)))
        throw new ForbiddenException('분석 기업에 포함된 원문만 선택하세요.');
      const [existing]: Row[] = await m.query(
        `SELECT * FROM analysis_documents WHERE ${input.reportId ? 'report_id' : input.filingId ? 'filing_id' : 'source_item_id'}=? ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.reportId ?? input.filingId ?? input.sourceItemId],
      );
      if (
        existing &&
        ['QUEUED', 'RUNNING', 'COMPLETE', 'PARTIAL'].includes(String(existing.status))
      ) {
        await this.linkRunArtifact(m, run, 'documentIds', existing.id);
        return this.documentView(m, await this.document(m, existing.id));
      }
      const id = randomUUID();
      const sourceUrl = safeAnalysisUrl(
        input.reportId || input.filingId ? source.source_url : source.url,
      );
      if (!sourceUrl) throw new BadRequestException('원문 주소를 확인할 수 없습니다.');
      await m.query(
        "INSERT INTO analysis_documents(id,report_id,filing_id,source_item_id,source_url,rights_mode,raw_uri,raw_sha256,media_type,parser_version,status,tables_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'QUEUED',?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
        [
          id,
          input.reportId ?? null,
          input.filingId ?? null,
          input.sourceItemId ?? null,
          sourceUrl,
          'OFFICIAL_PUBLIC_DATA',
          // Report raw files contain financial API JSON; document jobs fetch the filing itself.
          input.filingId ? (source.raw_uri ?? null) : null,
          input.filingId ? (source.raw_sha256 ?? null) : null,
          String(source.media_type ?? 'application/octet-stream'),
          'pending',
          '[]',
        ],
      );
      await this.job(m, 'DOCUMENT', id, { documentId: id, runId: run.id, ownerKey: actor.key });
      await this.linkRunArtifact(m, run, 'documentIds', id);
      return this.documentView(m, await this.document(m, id));
    });
  }

  private diffView(row: Row): AnalysisDiff {
    const result = analysisJson(row.result_json);
    const review = analysisJson(row.review_json);
    return {
      id: row.id,
      beforeDocumentId: String(row.before_document_id),
      afterDocumentId: String(row.after_document_id),
      status: row.status as AnalysisDiff['status'],
      confirmed: sqlBoolean(row.confirmed),
      differences: publicAnalysisJson(
        Array.isArray(result.differences) ? result.differences : analysisArray(row.result_json),
      ) as AnalysisDiff['differences'],
      errorMessage: row.error_message ? '문서 비교를 완료하지 못했습니다.' : null,
      ...(review.status === 'CONFIRMED'
        ? {
            confirmation: {
              status: 'CONFIRMED' as const,
              sourceUrl: safeAnalysisUrl(review.sourceUrl) ?? '',
              note: String(review.note ?? ''),
              reviewedAt: String(review.reviewedAt ?? ''),
            },
          }
        : {}),
    };
  }

  private async diff(m: EntityManager, id: string): Promise<Row> {
    const [row]: Row[] = await m.query('SELECT * FROM analysis_diffs WHERE id=?', [id]);
    if (!row) throw new NotFoundException('비교 결과를 찾을 수 없습니다.');
    await this.document(m, String(row.before_document_id));
    await this.document(m, String(row.after_document_id));
    return row;
  }

  getDiff(actor: GroupActor, id: string) {
    this.enabled('documents');
    return this.transaction(actor, async (m) => this.diffView(await this.diff(m, id)));
  }

  confirmDiff(
    actor: GroupActor,
    id: string,
    input: { runId: string; sourceUrl: string; note: string },
  ) {
    this.enabled('documents');
    if (actor.kind !== 'ADMIN')
      throw new ForbiddenException('정정 관계 확인은 관리자만 할 수 있습니다.');
    const sourceUrl = safeAnalysisUrl(input.sourceUrl);
    const officialHosts = [
      'www.sec.gov',
      'sec.gov',
      'data.sec.gov',
      'dart.fss.or.kr',
      'opendart.fss.or.kr',
    ];
    if (
      !sourceUrl ||
      !sourceUrl.startsWith('https://') ||
      !officialHosts.includes(new URL(sourceUrl).hostname)
    )
      throw new BadRequestException('SEC 또는 DART의 HTTPS 공식 근거 주소를 입력하세요.');
    const note = input.note.trim();
    if (note.length < 10 || note.length > 2000)
      throw new BadRequestException('정정 관계를 확인한 근거를 10자부터 2,000자까지 입력하세요.');
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, input.runId);
      await this.selectionCompanies(
        m,
        actor,
        parseWith(analysisSelectionSchema, analysisJson(run.selection_json)),
      );
      if (!ids(analysisJson(run.result_json).diffIds).includes(id))
        throw new NotFoundException('이 분석에 연결된 비교 결과를 선택하세요.');
      const [row]: Row[] = await m.query('SELECT * FROM analysis_diffs WHERE id=? FOR UPDATE', [
        id,
      ]);
      if (!row) throw new NotFoundException('비교 결과를 찾을 수 없습니다.');
      if (
        sqlBoolean(row.confirmed) ||
        Object.keys(analysisJson(row.review_json)).length ||
        !['WAITING', 'PARTIAL', 'QUEUED'].includes(String(row.status))
      )
        throw new ConflictException('확인된 결과나 진행 중인 비교는 변경할 수 없습니다.');
      const before = await this.scopedDocument(m, run, String(row.before_document_id));
      const after = await this.scopedDocument(m, run, String(row.after_document_id));
      if (before.id === after.id || before.analysis_company_id !== after.analysis_company_id)
        throw new BadRequestException('같은 기업의 서로 다른 제출본을 선택하세요.');
      if (![before, after].every((doc) => ['COMPLETE', 'PARTIAL'].includes(String(doc.status))))
        throw new ConflictException('원문 처리가 끝난 뒤 정정 관계를 확인하세요.');
      const [job]: Row[] = await m.query(
        "SELECT * FROM analysis_jobs WHERE kind='DIFF' AND entity_id=? FOR UPDATE",
        [id],
      );
      if (job?.status === 'RUNNING')
        throw new ConflictException('진행 중인 비교는 변경할 수 없습니다.');
      const review = {
        status: 'CONFIRMED',
        reviewedBy: actor.key,
        reviewedAt: new Date().toISOString(),
        sourceUrl,
        note,
      };
      await m.query(
        "UPDATE analysis_diffs SET review_json=?,status='QUEUED',error_message=NULL,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
        [JSON.stringify(review), id],
      );
      await this.job(m, 'DIFF', id, { diffId: id, runId: run.id, ownerKey: actor.key });
      return this.diffView({ ...row, review_json: review, status: 'QUEUED', error_message: null });
    });
  }

  createDiff(
    actor: GroupActor,
    input: { runId: string; beforeDocumentId: string; afterDocumentId: string },
  ) {
    this.enabled('documents');
    if (input.beforeDocumentId === input.afterDocumentId)
      throw new BadRequestException('서로 다른 두 문서를 선택하세요.');
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, input.runId);
      await this.selectionCompanies(
        m,
        actor,
        parseWith(analysisSelectionSchema, analysisJson(run.selection_json)),
      );
      const companyIds: unknown[] = [];
      for (const id of [input.beforeDocumentId, input.afterDocumentId]) {
        const doc = await this.scopedDocument(m, run, id);
        companyIds.push(doc.analysis_company_id);
        if (!['COMPLETE', 'PARTIAL'].includes(String(doc.status)))
          throw new ConflictException('원문 처리가 끝난 뒤 비교하세요.');
      }
      if (companyIds[0] !== companyIds[1])
        throw new BadRequestException('같은 기업의 제출본끼리 비교하세요.');
      const [existing]: Row[] = await m.query(
        'SELECT * FROM analysis_diffs WHERE before_document_id=? AND after_document_id=? FOR UPDATE',
        [input.beforeDocumentId, input.afterDocumentId],
      );
      if (existing) {
        if (existing.status === 'FAILED') {
          await m.query(
            "UPDATE analysis_diffs SET status='QUEUED',error_message=NULL,updated_at=UTC_TIMESTAMP(6) WHERE id=?",
            [existing.id],
          );
          await this.job(m, 'DIFF', existing.id, {
            diffId: existing.id,
            runId: run.id,
            ownerKey: actor.key,
          });
          existing.status = 'QUEUED';
          existing.error_message = null;
        }
        await this.linkRunArtifact(m, run, 'diffIds', existing.id);
        return this.diffView(existing);
      }
      const id = randomUUID();
      await m.query(
        "INSERT INTO analysis_diffs(id,before_document_id,after_document_id,status,confirmed,result_json,created_at,updated_at) VALUES (?,?,?,'QUEUED',0,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
        [id, input.beforeDocumentId, input.afterDocumentId, '{}'],
      );
      await this.job(m, 'DIFF', id, { diffId: id, runId: run.id, ownerKey: actor.key });
      await this.linkRunArtifact(m, run, 'diffIds', id);
      return this.diffView(await this.diff(m, id));
    });
  }

  private exportView(row: Row): ExportManifest {
    return {
      id: row.id,
      runId: String(row.run_id),
      status: row.status as ExportManifest['status'],
      sha256: row.sha256 as string | null,
      errorMessage: row.error_message ? '내보내기 파일을 만들지 못했습니다.' : null,
      createdAt: instant(row.created_at)!,
      updatedAt: instant(row.updated_at)!,
      ...(row.status === 'COMPLETE'
        ? { downloadUrl: `/api/v1/analysis/exports/${row.id}/download` }
        : {}),
    };
  }

  private async exportRights(m: EntityManager, run: Row, selection: Record<string, unknown>) {
    const result = analysisJson(run.result_json);
    const reportIds = [...new Set([...ids(result.reportIds), ...ids(selection.reportIds)])];
    for (const reportId of reportIds) await this.report(m, reportId);
    const request = analysisJson(selection.request);
    for (const documentId of ids(request.documentIds))
      await this.scopedDocument(m, run, documentId);
    for (const diffId of ids(request.diffIds)) {
      const diff = await this.diff(m, diffId);
      await this.scopedDocument(m, run, String(diff.before_document_id));
      await this.scopedDocument(m, run, String(diff.after_document_id));
    }
  }

  createExport(actor: GroupActor, runId: string, request: AnalysisExportRequest) {
    if (
      request.documentIds.length ||
      request.diffIds.length ||
      request.tableIds.length ||
      request.includeOwnership
    )
      this.enabled('documents');
    if (request.includeNotes) this.enabled('notes');
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, runId);
      if (!['COMPLETE', 'PARTIAL'].includes(String(run.status)))
        throw new ConflictException('분석 결과가 완성된 뒤 내보내세요.');
      const snapshot = {
        request,
        runSnapshot: analysisJson(run.result_json),
        reportIds: ids(analysisJson(run.result_json).reportIds),
      };
      await this.exportRights(m, run, snapshot);
      const tableIds = new Set<string>();
      for (const documentId of request.documentIds) {
        const doc = await this.scopedDocument(m, run, documentId);
        if (!['COMPLETE', 'PARTIAL'].includes(String(doc.status)))
          throw new ConflictException('원문 처리가 끝난 뒤 내보내세요.');
        for (const table of analysisArray(doc.tables_json)) {
          const value = analysisJson(table).id;
          if (typeof value === 'string') tableIds.add(value);
        }
      }
      if (request.tableIds.some((id) => !tableIds.has(id)))
        throw new BadRequestException('선택한 표가 문서에 존재하지 않습니다.');
      for (const diffId of request.diffIds) {
        const diff = await this.diff(m, diffId);
        if (diff.status !== 'COMPLETE')
          throw new ConflictException('문서 비교가 끝난 뒤 내보내세요.');
      }
      const id = randomUUID();
      await m.query(
        "INSERT INTO analysis_exports(id,run_id,owner_key,status,selection_json,created_at,updated_at) VALUES (?,?,?,'QUEUED',?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))",
        [id, runId, actor.key, JSON.stringify(snapshot)],
      );
      await this.job(m, 'EXPORT', id, { exportId: id, runId });
      const [row]: Row[] = await m.query(
        'SELECT * FROM analysis_exports WHERE id=? AND owner_key=?',
        [id, actor.key],
      );
      return this.exportView(row!);
    });
  }

  private async ownedExport(m: EntityManager, actor: GroupActor, id: string) {
    const [row]: Row[] = await m.query(
      'SELECT * FROM analysis_exports WHERE id=? AND owner_key=? FOR UPDATE',
      [id, actor.key],
    );
    if (!row) throw new NotFoundException('내보내기 결과를 찾을 수 없습니다.');
    const run = await this.ownedRun(m, actor, String(row.run_id));
    await this.exportRights(m, run, analysisJson(row.selection_json));
    return row;
  }

  getExport(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) =>
      this.exportView(await this.ownedExport(m, actor, id)),
    );
  }

  downloadExport(actor: GroupActor, id: string) {
    return this.transaction(actor, async (m) => {
      const row = await this.ownedExport(m, actor, id);
      if (
        row.status !== 'COMPLETE' ||
        typeof row.object_uri !== 'string' ||
        typeof row.sha256 !== 'string'
      )
        throw new ConflictException('내보내기 파일이 아직 준비되지 않았습니다.');
      return {
        bytes: await readAnalysisArtifact(this.config.storageDir, row.object_uri, row.sha256),
        filename: `orsem-analysis-${row.run_id}-${row.id}.xlsx`,
        sha256: row.sha256,
      };
    });
  }

  evidence(actor: GroupActor, runId: string, factId: string) {
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, runId);
      const fact = analysisArray(analysisJson(run.result_json).facts)
        .map(analysisJson)
        .find((f) => f.id === factId);
      if (!fact || typeof fact.reportId !== 'string')
        throw new NotFoundException('이 분석의 근거를 찾을 수 없습니다.');
      await this.report(m, fact.reportId);
      return publicAnalysisJson(fact);
    });
  }

  validations(actor: GroupActor, runId: string) {
    return this.transaction(actor, async (m) => {
      const run = await this.ownedRun(m, actor, runId);
      return {
        items: publicAnalysisJson(
          analysisArray(analysisJson(run.result_json).validations),
        ) as AnalysisValidation[],
      };
    });
  }

  notes(actor: GroupActor, input: { runId?: string; documentId?: string; q?: string }) {
    this.enabled('notes');
    return this.transaction(actor, async (m) => {
      let documentIds: string[] = [];
      if (input.runId) {
        const run = await this.ownedRun(m, actor, input.runId);
        documentIds = ids(analysisJson(run.result_json).documentIds);
        if (input.documentId && !documentIds.includes(input.documentId))
          throw new NotFoundException('이 분석의 주석을 찾을 수 없습니다.');
      }
      if (input.documentId) documentIds = [input.documentId];
      for (const id of documentIds) await this.document(m, id);
      if (!documentIds.length) return { items: [] };
      const query = input.q ? `%${input.q.replace(/[\\%_]/gu, (v) => `\\${v}`)}%` : null;
      const rows: Row[] = await m.query(
        `SELECT * FROM analysis_notes WHERE document_id IN (${placeholders(documentIds)})${query ? ' AND (title LIKE ? OR body LIKE ?)' : ''} ORDER BY document_id,note_key,id LIMIT 100`,
        [...documentIds, ...(query ? [query, query] : [])],
      );
      return { items: rows.map((row) => this.noteView(row)) };
    });
  }

  private bookmarkView(row: Row): AnalysisBookmark {
    return {
      id: row.id,
      documentId: String(row.document_id),
      noteId: row.note_id as string | null,
      label: String(row.label),
      anchor: analysisJson(row.anchor_json),
      needsRelink: sqlBoolean(row.needs_relink),
      createdAt: instant(row.created_at)!,
    };
  }

  bookmarks(actor: GroupActor) {
    this.enabled('notes');
    return this.transaction(actor, async (m) => {
      const rows: Row[] = await m.query(
        'SELECT * FROM analysis_bookmarks WHERE owner_key=? ORDER BY created_at DESC,id DESC LIMIT 200',
        [actor.key],
      );
      const items: AnalysisBookmark[] = [];
      for (const row of rows) {
        try {
          await this.document(m, String(row.document_id));
        } catch (e) {
          if (e instanceof NotFoundException || e instanceof ForbiddenException) continue;
          throw e;
        }
        items.push(this.bookmarkView(row));
      }
      return { items };
    });
  }

  createBookmark(
    actor: GroupActor,
    input: {
      documentId: string;
      noteId: string | null;
      label: string;
      anchor: Record<string, unknown>;
    },
  ) {
    this.enabled('notes');
    return this.transaction(actor, async (m) => {
      const doc = await this.document(m, input.documentId);
      if (input.noteId) {
        const [note]: Row[] = await m.query(
          'SELECT id FROM analysis_notes WHERE id=? AND document_id=?',
          [input.noteId, input.documentId],
        );
        if (!note) throw new BadRequestException('이 문서에 없는 주석입니다.');
      }
      if (input.anchor.tableId) {
        const table = analysisArray(doc.tables_json)
          .map(analysisJson)
          .find((t) => t.id === input.anchor.tableId);
        if (
          !table ||
          (typeof input.anchor.row === 'number' && input.anchor.row >= Number(table.rowCount)) ||
          (typeof input.anchor.column === 'number' &&
            input.anchor.column >= Number(table.columnCount))
        )
          throw new BadRequestException('문서에 존재하는 표와 위치를 선택하세요.');
      }
      const id = randomUUID();
      await m.query(
        'INSERT INTO analysis_bookmarks(id,owner_key,document_id,note_id,label,anchor_json,needs_relink,created_at) VALUES (?,?,?,?,?,?,0,UTC_TIMESTAMP(6))',
        [id, actor.key, input.documentId, input.noteId, input.label, JSON.stringify(input.anchor)],
      );
      const [row]: Row[] = await m.query(
        'SELECT * FROM analysis_bookmarks WHERE id=? AND owner_key=?',
        [id, actor.key],
      );
      return this.bookmarkView(row!);
    });
  }

  deleteBookmark(actor: GroupActor, id: string) {
    this.enabled('notes');
    return this.transaction(actor, async (m) => {
      const [row]: Row[] = await m.query(
        'SELECT id FROM analysis_bookmarks WHERE id=? AND owner_key=? FOR UPDATE',
        [id, actor.key],
      );
      if (!row) throw new NotFoundException('북마크를 찾을 수 없습니다.');
      await m.query('DELETE FROM analysis_bookmarks WHERE id=? AND owner_key=?', [id, actor.key]);
    });
  }

  private mappingView(row: Row): AnalysisMapping {
    return {
      id: row.id,
      source: row.source as AnalysisMapping['source'],
      taxonomy: String(row.taxonomy),
      accountId: String(row.account_id),
      metric: row.metric as AnalysisMapping['metric'],
      scope: row.scope as AnalysisMapping['scope'],
      status: row.status as AnalysisMapping['status'],
      version: Number(row.version),
      sourceUrl: safeAnalysisUrl(row.source_url) ?? '',
      details: publicAnalysisJson(analysisJson(row.details_json)) as Record<string, unknown>,
    };
  }

  mappings(actor: GroupActor) {
    return this.transaction(actor, async (m) => {
      const rows: Row[] = await m.query(
        'SELECT a.* FROM analysis_mappings a WHERE NOT EXISTS (SELECT 1 FROM analysis_mappings b WHERE b.source=a.source AND b.taxonomy=a.taxonomy AND b.account_id=a.account_id AND b.metric=a.metric AND b.scope=a.scope AND b.version>a.version) ORDER BY a.created_at DESC,a.id DESC LIMIT 400',
      );
      return { items: rows.map((r) => this.mappingView(r)) };
    });
  }

  createMapping(actor: GroupActor, input: Omit<AnalysisMapping, 'id' | 'version'>) {
    if (actor.kind !== 'ADMIN')
      throw new ForbiddenException('계정 연결 검토는 관리자만 할 수 있습니다.');
    if (!safeAnalysisUrl(input.sourceUrl)?.startsWith('https://'))
      throw new BadRequestException('검증 가능한 HTTPS 근거 주소를 입력하세요.');
    return this.transaction(actor, async (m) => {
      const [previous]: Row[] = await m.query(
        'SELECT * FROM analysis_mappings WHERE source=? AND taxonomy=? AND account_id=? AND metric=? AND scope=? ORDER BY version DESC LIMIT 1 FOR UPDATE',
        [input.source, input.taxonomy, input.accountId, input.metric, input.scope],
      );
      const id = randomUUID();
      const version = Number(previous?.version ?? 0) + 1;
      await m.query(
        'INSERT INTO analysis_mappings(id,source,taxonomy,account_id,metric,scope,status,version,source_url,details_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))',
        [
          id,
          input.source,
          input.taxonomy,
          input.accountId,
          input.metric,
          input.scope,
          input.status,
          version,
          input.sourceUrl,
          JSON.stringify(input.details),
          actor.key,
        ],
      );
      const [row]: Row[] = await m.query('SELECT * FROM analysis_mappings WHERE id=?', [id]);
      return this.mappingView(row!);
    });
  }
}
