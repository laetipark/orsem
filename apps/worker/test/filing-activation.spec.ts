import { EffectiveFilingState, ParseStatus } from '@orsem/contracts';
import {
  AdminEntity,
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
  type ParsedD001Report,
  type ParsedD002Report,
} from '@orsem/opendart-parser';
import type { DataSource } from 'typeorm';
import { FilingEnrichmentService } from '../src/opendart/filing-enrichment.service';
import { proxyParsed, tenderParsed } from './disclosure-fixtures';

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

const nonTradingLargeHolderReport: ParsedD001Report = {
  detailType: 'D001',
  parserVersion: 'opendart-xml-v3',
  source: parsed.source,
  reportReasonKind: 'CONTRACT_CHANGE',
  nonTradingReport: true,
  confidence: 0.95,
  reportTypeRaw: '변동없음 보고',
  reporterName: '보고자',
  reportReasonRaw: '보유계약 변경',
  sharesAfter: '100',
  sharesChange: '0',
  ownershipRateAfter: '5.00',
  ownershipRateChange: '0',
  changes: [],
  warnings: [],
  tablesScanned: 2,
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
    findOneBy: jest.fn(async (where: Row) => rows.find((row) => match(row, where)) ?? null),
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
    [AdminEntity, repository([{ id: '00000000-0000-4000-8000-000000000001', isActive: true }])],
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
  it.each([
    ['의결권대리행사권유참고서류', proxyParsed],
    ['공개매수신고서', tenderParsed],
  ])(
    'keeps a valid %s inactive until a separate source review and confirmation',
    async (title, candidate) => {
      const state = setup(title);
      jest.mocked(parseOpenDartDisclosure).mockResolvedValue(candidate);
      state.fetchCrosscheck.mockResolvedValue({
        status: 'NOT_APPLICABLE',
        reason: `NO_SUMMARY_API_FOR_${candidate.detailType}`,
      });
      const result = await state.service.enrich(state.job);
      expect(result.status).toBe(ParseStatus.PARTIAL);
      expect(state.runs.rows.at(-1)).toMatchObject({
        inputType: candidate.detailType,
        extractorType: candidate.detailType,
        resultType: candidate.detailType,
        resultJson: { projectionApplied: false, protectedActiveParseRunId: 'old-active' },
        validationStatus: 'REVIEW_REQUIRED',
      });
      expect(state.filing.activeParseRunId).toBe('old-active');
      expect(state.replaceProjection).not.toHaveBeenCalled();
      expect(state.events.save).not.toHaveBeenCalled();
      expect(state.reviews.rows.at(-1)?.status).toBe('OPEN');
    },
  );

  it.each([proxyParsed, tenderParsed])(
    'rejects manual $detailType activation without proof for this exact source',
    async (candidate) => {
      const state = setup(
        candidate.detailType === 'D003' ? '의결권대리행사권유참고서류' : '공개매수신고서',
      );
      Object.assign(state.filing, {
        detailType: candidate.detailType,
        canonicalType: candidate.detailType,
        classificationStatus: 'CONFIRMED',
      });
      const run = {
        id: 'staged',
        rawSha256: SHA,
        filingId: state.filing.id,
        status: ParseStatus.PARTIAL,
        validationStatus: 'REVIEW_REQUIRED',
        inputType: candidate.detailType,
        extractorType: candidate.detailType,
        resultType: candidate.detailType,
        resultJson: {
          parsed: candidate,
          projectionApplied: false,
          protectedActiveParseRunId: 'old-active',
          crosscheck: {
            status: 'NOT_APPLICABLE',
            reason: `NO_SUMMARY_API_FOR_${candidate.detailType}`,
          },
          sourceReview: {
            confirmedByAdminId: '00000000-0000-4000-8000-000000000001',
            confirmedAt: '2026-09-01T00:00:00.000Z',
            parseRunId: 'another-run',
            rawSha256: SHA,
          },
        },
      };
      state.runs.rows.push(run);
      await expect(
        state.service.applyDeferredProjection({
          filingId: state.filing.id,
          parseRunId: run.id,
          requestedByAdminId: '00000000-0000-4000-8000-000000000001',
        }),
      ).rejects.toMatchObject({ code: 'PARSE_SOURCE_REVIEW_REQUIRED' });
      expect(state.replaceProjection).not.toHaveBeenCalled();
      expect(state.filing.activeParseRunId).toBe('old-active');
    },
  );

  it.each([proxyParsed, tenderParsed])(
    'activates reviewed $detailType data only after a separate confirmation by an active administrator',
    async (candidate) => {
      const state = setup(
        candidate.detailType === 'D003' ? '의결권대리행사권유참고서류' : '공개매수신고서',
      );
      Object.assign(state.filing, {
        detailType: candidate.detailType,
        canonicalType: candidate.detailType,
        classificationStatus: 'CONFIRMED',
      });
      const adminId = '00000000-0000-4000-8000-000000000001';
      const run = {
        id: 'staged',
        rawSha256: SHA,
        filingId: state.filing.id,
        status: ParseStatus.PARTIAL,
        validationStatus: 'REVIEW_REQUIRED',
        inputType: candidate.detailType,
        extractorType: candidate.detailType,
        resultType: candidate.detailType,
        resultJson: {
          parsed: candidate,
          projectionApplied: false,
          protectedActiveParseRunId: 'old-active',
          crosscheck: {
            status: 'NOT_APPLICABLE',
            reason: `NO_SUMMARY_API_FOR_${candidate.detailType}`,
          },
          sourceReview: {
            confirmedByAdminId: adminId,
            confirmedAt: '2026-09-01T00:00:00.000Z',
            parseRunId: 'staged',
            rawSha256: SHA,
          },
        },
      };
      state.runs.rows.push(run);
      const materialize = jest
        .spyOn(
          state.service as unknown as {
            materializeParsedEvent: (...args: unknown[]) => Promise<void>;
          },
          'materializeParsedEvent',
        )
        .mockResolvedValue(undefined);

      await expect(
        state.service.applyDeferredProjection({
          filingId: state.filing.id,
          parseRunId: run.id,
          requestedByAdminId: adminId,
        }),
      ).resolves.toMatchObject({ projectionApplied: true });
      expect(state.replaceProjection).toHaveBeenCalledWith(
        expect.anything(),
        state.filing.id,
        state.filing.companyId,
        candidate,
        run.resultJson.crosscheck,
        EffectiveFilingState.ACTIVE,
        run.id,
      );
      expect(state.filing.activeParseRunId).toBe(run.id);
      expect(materialize).toHaveBeenCalledWith(
        expect.anything(),
        state.filing,
        candidate,
        run.id,
        ParseStatus.SUCCEEDED,
        false,
        true,
      );
    },
  );

  it('accepts a parser-proven D001 non-trading report without manufacturing change rows', async () => {
    const state = setup('주식등의대량보유상황보고서');
    jest.mocked(parseOpenDartDisclosure).mockResolvedValue(nonTradingLargeHolderReport);

    await expect(state.service.enrich(state.job)).resolves.toMatchObject({
      status: ParseStatus.SUCCEEDED,
    });
    expect(state.replaceProjection).toHaveBeenCalledWith(
      expect.anything(),
      state.filing.id,
      state.filing.companyId,
      nonTradingLargeHolderReport,
      expect.objectContaining({ status: 'OK' }),
      EffectiveFilingState.ACTIVE,
      expect.any(String),
    );
    expect(state.runs.rows.at(-1)).toMatchObject({
      validationStatus: 'PASSED',
      resultJson: {
        parsed: {
          detailType: 'D001',
          nonTradingReport: true,
          reportReasonKind: 'CONTRACT_CHANGE',
          changes: [],
        },
        projectionApplied: true,
      },
    });
  });

  it('rejects a D004 document-kind mismatch before applying a reviewed candidate', async () => {
    const state = setup('공개매수신고서');
    Object.assign(state.filing, {
      detailType: 'D004',
      canonicalType: 'D004',
      classificationStatus: 'CONFIRMED',
    });
    const candidate = { ...tenderParsed, documentKind: 'EXPLANATION' as const };
    const run = {
      id: '00000000-0000-4000-8000-000000000002',
      rawSha256: SHA,
      filingId: state.filing.id,
      status: ParseStatus.PARTIAL,
      validationStatus: 'REVIEW_REQUIRED',
      inputType: 'D004',
      extractorType: 'D004',
      resultType: 'D004',
      resultJson: {
        parsed: candidate,
        projectionApplied: false,
        protectedActiveParseRunId: 'old-active',
        crosscheck: { status: 'NOT_APPLICABLE', reason: 'NO_SUMMARY_API_FOR_D004' },
      },
    };
    state.runs.rows.push(run);

    await expect(
      state.service.applyDeferredProjection({
        filingId: state.filing.id,
        parseRunId: run.id,
        requestedByAdminId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toMatchObject({ code: 'FILING_DOCUMENT_KIND_INVARIANT' });
    expect(state.replaceProjection).not.toHaveBeenCalled();
    expect(state.filing.activeParseRunId).toBe('old-active');
  });
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

  it('never downloads or selects an extractor for unconfirmed documents', async () => {
    const state = setup('지원범위외 알수없는공시');
    await expect(state.service.enrich(state.job)).rejects.toMatchObject({
      code: 'FILING_TYPE_UNCONFIRMED',
    });
    expect(state.filing).toMatchObject({
      canonicalType: null,
      classificationStatus: 'UNKNOWN',
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

describe('source-bound disclosure activation', () => {
  it('rejects a reviewed D003 payload whose parser source SHA differs from its run', async () => {
    const state = setup('의결권대리행사권유참고서류');
    Object.assign(state.filing, {
      detailType: 'D003',
      canonicalType: 'D003',
      classificationStatus: 'CONFIRMED',
    });
    const adminId = '00000000-0000-4000-8000-000000000001';
    const candidate = {
      ...proxyParsed,
      source: { ...proxyParsed.source, archiveSha256: 'b'.repeat(64) },
    };
    const run = {
      id: 'staged-source-mismatch',
      rawSha256: SHA,
      filingId: state.filing.id,
      status: ParseStatus.PARTIAL,
      validationStatus: 'REVIEW_REQUIRED',
      inputType: 'D003',
      extractorType: 'D003',
      resultType: 'D003',
      resultJson: {
        parsed: candidate,
        projectionApplied: false,
        protectedActiveParseRunId: 'old-active',
        crosscheck: { status: 'NOT_APPLICABLE', reason: 'NO_SUMMARY_API_FOR_D003' },
        sourceReview: {
          confirmedByAdminId: adminId,
          confirmedAt: '2026-09-01T00:00:00.000Z',
          parseRunId: 'staged-source-mismatch',
          rawSha256: SHA,
        },
      },
    };
    state.runs.rows.push(run);
    await expect(
      state.service.applyDeferredProjection({
        filingId: state.filing.id,
        parseRunId: run.id,
        requestedByAdminId: adminId,
      }),
    ).rejects.toMatchObject({ code: 'PARSE_SOURCE_SHA_INVARIANT' });
    expect(state.replaceProjection).not.toHaveBeenCalled();
    expect(state.filing.activeParseRunId).toBe('old-active');
  });
});
