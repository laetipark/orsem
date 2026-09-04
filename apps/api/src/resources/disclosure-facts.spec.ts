import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LargeHolderReportEntity,
  LargeHoldingChangeEntity,
  ProxySolicitationEntity,
  ProxyAgendaItemEntity,
  TenderOfferEntity,
  TenderOfferSecurityEntity,
  type ParseRunEntity,
} from '@orsem/database';
import { readDisclosureFacts } from './disclosure-facts';

test('D003 projection is bound to the active parse generation and keeps date-only source fields', async () => {
  const calls: unknown[] = [];
  const source = {
    getRepository(entity: unknown) {
      if (entity === ProxySolicitationEntity)
        return {
          findOneBy: async (where: unknown) => {
            calls.push(where);
            return {
              id: 'proxy',
              factsJson: {
                solicitorName: '권유자',
                targetCompanyName: '대상사',
                relationshipRaw: null,
                meetingDate: '2026-09-30',
                meetingTimeRaw: '오전 9시',
                meetingAt: null,
                meetingLocation: null,
                solicitationStartDate: null,
                solicitationEndDate: null,
                purposeRaw: null,
                electronicVoting: true,
              },
            };
          },
        };
      if (entity === ProxyAgendaItemEntity)
        return { find: async () => [{ ordinal: 1, title: '이사 선임' }] };
      throw new Error('unexpected repository');
    },
  };
  const detail = await readDisclosureFacts(source as never, 'filing', {
    id: 'active-run',
    resultType: 'D003',
  } as ParseRunEntity);
  assert.deepEqual(calls, [{ filingId: 'filing', parseRunId: 'active-run' }]);
  assert.equal(detail.proxySolicitation?.meetingDate, '2026-09-30');
  assert.equal(detail.proxySolicitation?.agendas[0]?.title, '이사 선임');
});

test('D004 result preserves exact decimal strings and active generation', async () => {
  const source = {
    getRepository(entity: unknown) {
      if (entity === TenderOfferEntity)
        return {
          findOneBy: async () => ({
            id: 'offer',
            documentKind: 'RESULT',
            factsJson: {
              offerorName: null,
              targetCompanyName: null,
              purposeRaw: null,
              conditionsRaw: null,
              subscriptionStartDate: null,
              subscriptionEndDate: null,
              settlementDate: null,
            },
          }),
        };
      if (entity === TenderOfferSecurityEntity)
        return {
          find: async () => [
            {
              rowIndex: 2,
              factsJson: {
                securityTypeRaw: '보통주',
                unitPrice: '9007199254740993.25',
                currency: 'KRW',
                minQuantity: null,
                maxQuantity: null,
                heldQuantity: null,
                expectedHoldingsMin: null,
                expectedHoldingsMax: null,
                offeredQuantity: '101',
                acquiredQuantity: '100',
                actualAmount: '900719925474099325',
              },
            },
          ],
        };
      throw new Error('unexpected repository');
    },
  };
  const detail = await readDisclosureFacts(source as never, 'filing', {
    id: 'active-run',
    resultType: 'D004',
  } as ParseRunEntity);
  assert.equal(detail.tenderOffer?.securities[0]?.unitPrice, '9007199254740993.25');
  assert.equal(detail.tenderOffer?.securities[0]?.acquiredQuantity, '100');
});

test('D001 exposes report reason semantics even when there are no transaction rows', async () => {
  const source = {
    getRepository(entity: unknown) {
      if (entity === LargeHolderReportEntity)
        return {
          findOne: async () => ({
            id: 'holder',
            reporterName: '보고자',
            reportReasonRaw: '주요계약 변경',
            holdingPurposeRaw: null,
            sharesBefore: null,
            sharesAfter: null,
            ownershipRateBefore: null,
            ownershipRateAfter: null,
            rawJson: { reportReasonKind: 'CONTRACT_CHANGE' },
          }),
        };
      if (entity === LargeHoldingChangeEntity) return { find: async () => [] };
      throw new Error('unexpected repository');
    },
  };
  const detail = await readDisclosureFacts(source as never, 'filing', {
    id: 'active-run',
    resultType: 'D001',
  } as ParseRunEntity);
  assert.equal(detail.largeHolding?.reportReasonKind, 'CONTRACT_CHANGE');
  assert.deepEqual(detail.largeHolding?.changes, []);
});
