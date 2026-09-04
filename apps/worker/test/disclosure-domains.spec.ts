import { EventType, EffectiveFilingState } from '@orsem/contracts';
import {
  ProxySolicitationEntity,
  ProxyAgendaItemEntity,
  TenderOfferEntity,
  TenderOfferSecurityEntity,
} from '@orsem/database';
import type { ParsedOpenDartDisclosure } from '@orsem/opendart-parser';
import type { EntityManager } from 'typeorm';
import { loadWorkerConfig } from '../src/config/worker-config';
import {
  FilingEnrichmentService,
  selectUnknownAiReviewCandidates,
} from '../src/opendart/filing-enrichment.service';
import { filingEventType, OPENDART_WORKER_TYPES } from '../src/opendart/disclosure-policy';
import { crosscheckAllowsProjection, parseReuseFingerprint } from '../src/opendart/parse-reuse';
import { proxyParsed, tenderParsed } from './disclosure-fixtures';

function service() {
  const forbidden = jest.fn(() => {
    throw new Error('No provider or unrelated projection access is allowed.');
  });
  return {
    instance: new FilingEnrichmentService(
      { getRepository: forbidden } as unknown as ConstructorParameters<
        typeof FilingEnrichmentService
      >[0],
      { fetchMajorStock: forbidden, fetchEleStock: forbidden } as unknown as ConstructorParameters<
        typeof FilingEnrichmentService
      >[1],
      {} as ConstructorParameters<typeof FilingEnrichmentService>[2],
      {} as ConstructorParameters<typeof FilingEnrichmentService>[3],
      {} as ConstructorParameters<typeof FilingEnrichmentService>[4],
      loadWorkerConfig({}),
    ),
    forbidden,
  };
}

describe('five independent disclosure domains', () => {
  it('explicitly enables only implemented pollers and distinct event types', () => {
    expect(OPENDART_WORKER_TYPES).toEqual(['D001', 'D002', 'D003', 'D004', 'D005']);
    expect(filingEventType('D003')).toBe(EventType.PROXY_SOLICITATION);
    expect(filingEventType('D004')).toBe(EventType.TENDER_OFFER);
    expect(() => filingEventType('D006')).toThrow();
  });

  it('does not opt existing global channels into new document families', () => {
    expect(loadWorkerConfig({}).openDartGlobalAlertTypes).toEqual(['D001', 'D002', 'D005']);
    expect(loadWorkerConfig({ OPENDART_GLOBAL_ALERT_TYPES: '' }).openDartGlobalAlertTypes).toEqual(
      [],
    );
    expect(
      loadWorkerConfig({ OPENDART_GLOBAL_ALERT_TYPES: 'D003, D004,D003' }).openDartGlobalAlertTypes,
    ).toEqual(['D003', 'D004']);
    expect(() => loadWorkerConfig({ OPENDART_GLOBAL_ALERT_TYPES: 'D006' })).toThrow();
  });

  it.each([proxyParsed, tenderParsed])(
    'never sends $detailType through a share-summary provider or transaction AI',
    async (parsed) => {
      const { instance, forbidden } = service();
      const internal = instance as unknown as {
        fetchCrosscheck(
          filing: { detailType: string },
          receipt: string,
        ): Promise<Record<string, unknown>>;
      };
      const crosscheck = await internal.fetchCrosscheck(
        { detailType: parsed.detailType },
        'receipt',
      );
      expect(crosscheck).toEqual({
        status: 'NOT_APPLICABLE',
        reason: `NO_SUMMARY_API_FOR_${parsed.detailType}`,
      });
      expect(crosscheckAllowsProjection(parsed.detailType, crosscheck, 'receipt')).toBe(true);
      expect(
        crosscheckAllowsProjection(parsed.detailType, { status: 'NOT_APPLICABLE' }, 'receipt'),
      ).toBe(false);
      expect(selectUnknownAiReviewCandidates(parsed)).toEqual({
        candidates: [],
        totalEligibleRows: 0,
        truncated: false,
      });
      expect(forbidden).not.toHaveBeenCalled();
    },
  );

  it('separates report, explanation, and result reuse keys despite matching source/version/type', () => {
    const base = {
      rawSha256: 'a'.repeat(64),
      parserVersion: 'v3',
      normalizerVersion: 'v1',
      classifierVersion: 'v2',
      extractorType: 'D004',
    };
    expect(parseReuseFingerprint(base)).toBe(
      parseReuseFingerprint({ ...base, documentKind: 'OTHER' }),
    );
    expect(
      new Set(
        ['REPORT', 'EXPLANATION', 'RESULT'].map((documentKind) =>
          parseReuseFingerprint({ ...base, documentKind }),
        ),
      ).size,
    ).toBe(3);
  });

  it.each([proxyParsed, tenderParsed])(
    'stores $detailType facts and source-bound children without transaction projections',
    async (parsed) => {
      const { instance } = service();
      const headerType = parsed.detailType === 'D003' ? ProxySolicitationEntity : TenderOfferEntity;
      const childType =
        parsed.detailType === 'D003' ? ProxyAgendaItemEntity : TenderOfferSecurityEntity;
      const saved: Record<string, unknown>[] = [];
      const children: Record<string, unknown>[] = [];
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === headerType)
            return {
              find: async () => [],
              save: async (row: Record<string, unknown>) => {
                saved.push(row);
                return { id: 'header', ...row };
              },
            };
          if (entity === childType)
            return {
              save: async (row: Record<string, unknown>) => {
                children.push(row);
                return row;
              },
            };
          throw new Error(
            'New disclosures must not access insider, large-holder, plan, or execution-link repositories.',
          );
        },
      } as unknown as EntityManager;
      const internal = instance as unknown as {
        replaceProjection(
          manager: EntityManager,
          filingId: string,
          companyId: string,
          parsed: ParsedOpenDartDisclosure,
          crosscheck: Record<string, unknown>,
          state: EffectiveFilingState,
          parseRunId: string,
        ): Promise<void>;
      };
      await internal.replaceProjection(
        manager,
        'filing',
        'company',
        parsed,
        { status: 'NOT_APPLICABLE' },
        EffectiveFilingState.ACTIVE,
        'source-run',
      );
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        filingId: 'filing',
        parseRunId: 'source-run',
        factsJson: { detailType: parsed.detailType },
        provenanceJson: {},
      });
      expect(children).toHaveLength(1);
      if (parsed.detailType === 'D003')
        expect(children[0]).toMatchObject({ ordinal: 1, title: '이사 선임', provenanceJson: {} });
      else
        expect(children[0]).toMatchObject({
          factsJson: {
            minQuantity: '100',
            maxQuantity: '200',
            acquiredQuantity: null,
            actualAmount: null,
          },
          provenanceJson: {},
        });
      if (parsed.detailType === 'D004')
        expect(
          (children[0]?.['factsJson'] as Record<string, unknown>)['provenance'],
        ).toBeUndefined();
    },
  );
});
