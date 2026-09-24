import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Event } from '@orsem/contracts';
import {
  CompanyEntity,
  EventClusterEntity,
  EventClusterItemEntity,
  FilingEntity,
  ParseRunEntity,
} from '@orsem/database';
import { loadAppConfig } from '../config/app-config';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import type { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import { OrsemDataService } from './orsem-data.service';

test('existing events render active parsed facts without changing archived summaries', async () => {
  const row = {
    id: 'event',
    companyId: 'company',
    canonicalEventType: 'INSIDER_OWNERSHIP',
    state: 'VERIFIED',
    evidenceGrade: 'A',
    summary: '[D002 소유변동 확인] 홍길동 — 장내매수 1000 (시장거래 확인)',
    firstObservedAt: new Date('2026-09-24T00:00:00Z'),
  } as EventClusterEntity;
  const company = {
    id: row.companyId,
    nameKo: '삼성전자',
    createdAt: row.firstObservedAt,
    updatedAt: row.firstObservedAt,
  } as CompanyEntity;
  const filing = {
    id: 'filing',
    companyId: company.id,
    detailType: 'D002',
    canonicalType: 'D002',
    classificationStatus: 'CONFIRMED',
    activeParseRunId: 'parse',
    firstObservedAt: row.firstObservedAt,
    lastSeenAt: row.firstObservedAt,
    reportName: '임원ㆍ주요주주특정증권등소유상황보고서',
  } as FilingEntity;
  let parse: ParseRunEntity | null = {
    id: filing.activeParseRunId,
    filingId: filing.id,
    inputType: 'D002',
    extractorType: 'D002',
    resultType: 'D002',
    status: 'SUCCEEDED',
    validationStatus: 'PASSED',
    resultJson: {
      projectionApplied: true,
      parsed: {
        detailType: 'D002',
        reporterName: '홍길동',
        transactions: [
          {
            nature: 'MARKET_BUY',
            direction: 'INCREASE',
            quantity: '1000',
            methodRaw: '장내매수',
          },
        ],
      },
    },
  } as unknown as ParseRunEntity;
  const data = new OrsemDataService(
    loadAppConfig({ NODE_ENV: 'test' }),
    {
      dataSource: {
        getRepository(entity: unknown) {
          if (entity === EventClusterItemEntity)
            return {
              findBy: async () => [{ itemType: 'FILING', itemId: filing.id }],
            };
          return {
            findOneBy: async () => {
              if (entity === CompanyEntity) return company;
              if (entity === FilingEntity) return filing;
              if (entity === ParseRunEntity) return parse;
              throw new Error('Unexpected disclosure repository.');
            },
          };
        },
      },
    } as unknown as DatabaseRuntimeService,
    new FixtureStoreService(),
  ) as unknown as { mapEvent(value: EventClusterEntity): Promise<Event> };
  const result = await data.mapEvent(row);
  assert.equal(result.summary, '[매수신호] (삼성전자) 홍길동 +1,000주 장내매수');
  assert.match(row.summary, /시장거래 확인/);
  parse = null;
  const pending = await data.mapEvent(row);
  assert.equal(pending.summary, `원문 검증 대기 — ${filing.reportName}`);
  assert.equal(pending.state, 'REVIEW_REQUIRED');
});
