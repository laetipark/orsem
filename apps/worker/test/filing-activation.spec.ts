import { EffectiveFilingState, ParseStatus } from '@orsem/contracts';
import {
  EventClusterEntity,
  EventClusterItemEntity,
  FilingDocumentEntity,
  FilingEntity,
  ParseIssueEntity,
  ParseRunEntity,
  ReviewEntity,
} from '@orsem/database';
import {
  OpenDartPayloadError,
  parseOpenDartDisclosure,
  type ParsedD002Report,
} from '@orsem/opendart-parser';
import type { DataSource } from 'typeorm';
import { FilingEnrichmentService } from '../src/opendart/filing-enrichment.service';

jest.mock('@orsem/opendart-parser', () => ({
  ...jest.requireActual('@orsem/opendart-parser'),
  parseOpenDartDisclosure: jest.fn(),
}));

const SHA = 'a'.repeat(64);
const parsed: ParsedD002Report = {
  detailType: 'D002',
  parserVersion: 'opendart-xml-v2',
  source: {
    archiveSha256: SHA,
    archiveByteLength: 4,
    selectedEntryName: 'report.xml',
    candidateEntries: ['report.xml'],
    candidateErrors: [],
    normalizationAudits: [],
    normalizerVersion: 'opendart-dialect-v1',
  },
  reporterName: '보고자',
  relationshipRaw: null,
  positionRaw: null,
  tablesScanned: 1,
  warnings: [],
  transactions: [
    {
      rowIndex: 1,
      eventDate: '2026-09-04',
      securityTypeRaw: '보통주',
      methodRaw: '장내매수',
      nature: 'MARKET_BUY',
      direction: 'INCREASE',
      quantity: '10',
      quantityUnitRaw: '주',
      unitPrice: '1000',
      amount: '10000',
      amountSource: 'CALCULATED',
      currency: 'KRW',
      sharesAfter: '100',
      confidence: 1,
      warnings: [],
    },
  ],
};

type Row = Record<string, unknown>;
function repository(rows: Row[]) {
  const match = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  return {
    rows,
    create: (row: Row) => ({ ...row }),
    find: jest.fn(async ({ where = {} }: { where?: Row } = {}) =>
      rows.filter((row) => match(row, where)),
    ),
    findOne: jest.fn(async ({ where = {}, order }: { where?: Row; order?: Row } = {}) => {
      const found = rows.filter((row) => match(row, where));
      return (order ? found.at(-1) : found[0]) ?? null;
    }),
    save: jest.fn(async (row: Row) => {
      if (!row.id) row.id = `row-${rows.length + 1}`;
      if (!row.createdAt) row.createdAt = new Date(1_700_000_000_000 + rows.length);
      if (!rows.includes(row)) rows.push(row);
      return row;
    }),
    delete: jest.fn(async () => undefined),
    createQueryBuilder: () => {
      let selected: Row = {};
      const builder = {
        setLock: () => builder,
        where: (_query: string, values: Row = {}) => {
          selected = values;
          return builder;
        },
        getOne: async () => rows.find((row) => match(row, selected)) ?? null,
      };
      return builder;
    },
  };
}

function setup(reportName = '임원ㆍ주요주주특정증권등소유상황보고서') {
  const filing = {
    id: 'filing',
    companyId: 'company',
    rceptNo: '20260904000001',
    detailType: 'D005',
    reportName,
    sourceDetailType: null,
    classificationStatus: 'UNKNOWN',
    activeParseRunId: 'old-active',
    effectiveState: EffectiveFilingState.ACTIVE,
    firstObservedAt: new Date(0),
  };
  const event = {
    id: 'event',
    dedupeKey: 'opendart:filing:filing',
    state: 'VERIFIED',
    summary: '기존 검증 결과',
    metadataJson: { parseRunId: 'old-active' },
  };
  const runs = repository([
    {
      id: 'old-active',
      filingId: 'filing',
      status: ParseStatus.SUCCEEDED,
      rawSha256: SHA,
      parserVersion: 'opendart-xml-v1',
      resultJson: { parsed: { detailType: 'D005' } },
    },
  ]);
  const reviews = repository([]);
  const events = repository([event]);
  const issues = repository([]);
  const repositories = new Map<unknown, ReturnType<typeof repository>>([
    [FilingEntity, repository([filing])],
    [FilingDocumentEntity, repository([])],
    [ParseRunEntity, runs],
    [ReviewEntity, reviews],
    [EventClusterEntity, events],
    [
      EventClusterItemEntity,
      repository([{ eventClusterId: 'event', itemType: 'FILING', itemId: 'filing' }]),
    ],
    [ParseIssueEntity, issues],
  ]);
  const manager = {
    getRepository: (entity: unknown) => {
      const found = repositories.get(entity);
      if (!found) throw new Error(`Unexpected repository ${String(entity)}`);
      return found;
    },
  };
  const dataSource = {
    ...manager,
    transaction: async (fn: (value: typeof manager) => Promise<unknown>) => fn(manager),
    createQueryRunner: () => ({
      connect: async () => undefined,
      query: async () => [{ acquired: 1 }],
      release: async () => undefined,
    }),
  } as unknown as DataSource;
  const fetchDocument = jest.fn(async () => new Uint8Array([80, 75, 3, 4]));
  const service = new FilingEnrichmentService(
    dataSource,
    { fetchDocument } as unknown as ConstructorParameters<typeof FilingEnrichmentService>[1],
    {
      put: async () => ({ sha256: SHA, objectUri: '/test/immutable.zip', byteSize: 4 }),
    } as unknown as ConstructorParameters<typeof FilingEnrichmentService>[2],
    {
      openDartPausedUntil: async () => null,
      recordOpenDart: async () => undefined,
    } as unknown as ConstructorParameters<typeof FilingEnrichmentService>[3],
    {} as ConstructorParameters<typeof FilingEnrichmentService>[4],
    {} as ConstructorParameters<typeof FilingEnrichmentService>[5],
  );
  const internal = service as unknown as {
    fetchCrosscheck: () => Promise<Row>;
    hasConfirmedProjectionLinks: () => Promise<boolean>;
    replaceProjection: () => Promise<void>;
    enqueueAiReview: () => Promise<void>;
    enqueuePersistedAiReview: () => Promise<void>;
  };
  const fetchCrosscheck = jest
    .spyOn(internal, 'fetchCrosscheck')
    .mockResolvedValue({ status: 'OK', exactReceiptMatches: [{ rcept_no: filing.rceptNo }] });
  const manualLinks = jest.spyOn(internal, 'hasConfirmedProjectionLinks').mockResolvedValue(false);
  const replaceProjection = jest.spyOn(internal, 'replaceProjection').mockResolvedValue(undefined);
  jest.spyOn(internal, 'enqueueAiReview').mockResolvedValue(undefined);
  jest.spyOn(internal, 'enqueuePersistedAiReview').mockResolvedValue(undefined);
  const job = {
    filingId: 'filing',
    rceptNo: filing.rceptNo,
    detailType: 'D005' as const,
    suppressAlerts: true,
    documentRetryAttempt: 0,
  };
  return {
    service,
    job,
    filing,
    event,
    runs,
    reviews,
    events,
    issues,
    replaceProjection,
    manualLinks,
    fetchDocument,
    fetchCrosscheck,
  };
}

beforeEach(() => jest.mocked(parseOpenDartDisclosure).mockReset());

describe('validated filing activation', () => {
  it.each(['OK', 'FAILED'])(
    'keeps staged %s crosscheck evidence inactive and never activates on job replay',
    async (crosscheckStatus) => {
      const state = setup();
      Object.assign(state.filing, {
        detailType: 'D002',
        canonicalType: 'D002',
        classificationStatus: 'CONFIRMED',
      });
      const run = {
        id: 'staged',
        filingId: state.filing.id,
        status: ParseStatus.PARTIAL,
        validationStatus: 'REVIEW_REQUIRED',
        inputType: 'D002',
        extractorType: 'D002',
        resultType: 'D002',
        resultJson: {
          parsed,
          projectionApplied: false,
          protectedActiveParseRunId: 'old-active',
          staging: { mode: 'OFFLINE_INACTIVE' },
          crosscheck: { status: 'NOT_RUN' },
        },
      };
      state.runs.rows.push(run);
      state.fetchCrosscheck.mockResolvedValue({
        status: crosscheckStatus,
        exactReceiptMatches: crosscheckStatus === 'OK' ? [{ rcept_no: state.filing.rceptNo }] : [],
      });
      const job = {
        filingId: state.filing.id,
        parseRunId: run.id,
        requestedByAdminId: 'admin',
        crosscheckOnly: true,
      };
      expect(await state.service.applyDeferredProjection(job)).toMatchObject({
        projectionApplied: false,
        crosscheckOnly: true,
      });
      expect(run.resultJson.crosscheck.status).toBe(crosscheckStatus);
      expect(await state.service.applyDeferredProjection(job)).toMatchObject({
        projectionApplied: false,
        crosscheckOnly: true,
      });
      expect(state.filing.activeParseRunId).toBe('old-active');
      expect(state.replaceProjection).not.toHaveBeenCalled();
      expect(state.events.save).not.toHaveBeenCalled();
      expect(state.reviews.rows.at(-1)?.status).toBe('OPEN');
      expect(state.fetchCrosscheck).toHaveBeenCalledTimes(crosscheckStatus === 'OK' ? 1 : 2);
    },
  );

  it('creates a versioned D002 run rather than reusing the same SHA legacy D005 result', async () => {
    const state = setup();
    jest.mocked(parseOpenDartDisclosure).mockResolvedValue(parsed);
    const result = await state.service.enrich(state.job);
    expect(parseOpenDartDisclosure).toHaveBeenCalledWith(
      expect.objectContaining({ detailType: 'D002' }),
    );
    expect(state.runs.rows).toHaveLength(2);
    expect(state.runs.rows[0]!.resultJson).toEqual({ parsed: { detailType: 'D005' } });
    expect(state.runs.rows[1]).toMatchObject({
      inputType: 'D002',
      extractorType: 'D002',
      resultType: 'D002',
      validationStatus: 'PASSED',
      supersedesRunId: 'old-active',
    });
    expect(state.filing.activeParseRunId).toBe(result.parseRunId);
    expect(state.replaceProjection).toHaveBeenCalledTimes(1);
    // A later cache read cannot restore this older active pointer over a newer review.
    state.filing.activeParseRunId = 'newer-active';
    await state.service.enrich(state.job);
    expect(state.filing.activeParseRunId).toBe('newer-active');
    expect(parseOpenDartDisclosure).toHaveBeenCalledTimes(1);
  });

  it('keeps partial empty-row audits and the previous active event without projection or signals', async () => {
    const state = setup();
    jest.mocked(parseOpenDartDisclosure).mockResolvedValue({
      ...parsed,
      transactions: [],
      warnings: [{ code: 'NO_DATA_ROWS', message: '실제 거래행을 확인하지 못했습니다.' }],
    });
    await expect(state.service.enrich(state.job)).resolves.toMatchObject({
      status: ParseStatus.PARTIAL,
    });
    expect(state.filing.activeParseRunId).toBe('old-active');
    expect(state.event).toMatchObject({
      state: 'VERIFIED',
      summary: '기존 검증 결과',
      metadataJson: { parseRunId: 'old-active' },
    });
    expect(state.events.save).not.toHaveBeenCalled();
    expect(state.replaceProjection).not.toHaveBeenCalled();
    expect(state.runs.rows[1]).toMatchObject({
      validationStatus: 'REJECTED',
      resultJson: { projectionApplied: false },
    });
    expect(state.reviews.rows.filter((row) => row.status === 'OPEN')).toHaveLength(1);
  });

  it('keeps a successful reparse inactive when existing manual relationships are protected', async () => {
    const state = setup();
    state.manualLinks.mockResolvedValue(true);
    jest.mocked(parseOpenDartDisclosure).mockResolvedValue(parsed);
    await state.service.enrich(state.job);
    expect(state.filing.activeParseRunId).toBe('old-active');
    expect(state.replaceProjection).not.toHaveBeenCalled();
    expect(state.events.save).not.toHaveBeenCalled();
    expect(state.runs.rows[1]).toMatchObject({
      status: ParseStatus.PARTIAL,
      resultJson: { projectionApplied: false, protectedActiveParseRunId: 'old-active' },
    });
  });

  it('rejects a result-type mismatch before any projection or event mutation', async () => {
    const state = setup();
    jest
      .mocked(parseOpenDartDisclosure)
      .mockResolvedValue({ ...parsed, detailType: 'D005' } as unknown as ParsedD002Report);
    await expect(state.service.enrich(state.job)).rejects.toMatchObject({
      code: 'FILING_TYPE_INVARIANT',
    });
    expect(state.filing.activeParseRunId).toBe('old-active');
    expect(state.replaceProjection).not.toHaveBeenCalled();
    expect(state.events.save).not.toHaveBeenCalled();
  });

  it('never downloads or selects an extractor for unsupported documents', async () => {
    const state = setup('[첨부정정]공개매수신고서');
    await expect(state.service.enrich(state.job)).rejects.toMatchObject({
      code: 'UNSUPPORTED_FILING_TYPE',
    });
    expect(state.filing).toMatchObject({
      canonicalType: 'D004',
      classificationStatus: 'UNSUPPORTED',
    });
    expect(state.fetchDocument).not.toHaveBeenCalled();
    expect(parseOpenDartDisclosure).not.toHaveBeenCalled();
  });

  it('retains candidate-level errors and the old active result after parsing fails', async () => {
    const state = setup();
    const error = new OpenDartPayloadError('해석 가능한 XML 후보가 없습니다.', 'NO_PARSEABLE_XML', {
      candidateErrors: [
        {
          candidateName: 'broken.xml',
          candidateSha256: 'b'.repeat(64),
          errorCode: 'INVALID_XML',
          rootCause: 'OTHER_XML',
          line: 3,
          column: 4,
          originalMessage: 'Closing tag mismatch',
          repairAttempted: false,
          repairCodes: [],
        },
      ],
    });
    jest.mocked(parseOpenDartDisclosure).mockRejectedValue(error);
    await expect(state.service.enrich(state.job)).rejects.toBe(error);
    expect(state.runs.rows[1]).toMatchObject({
      status: ParseStatus.FAILED,
      validationStatus: 'REJECTED',
      candidateErrorsJson: error.candidateErrors,
    });
    expect(state.issues.save).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'ERROR', contextJson: error.candidateErrors[0] }),
    );
    expect(state.filing.activeParseRunId).toBe('old-active');
    expect(state.events.save).not.toHaveBeenCalled();
  });
});
