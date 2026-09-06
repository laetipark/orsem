import {
  createNewsCompanyMatcher,
  matchNewsCompanies,
  newsCompanyAliases,
} from '../src/connectors/news-company-matching';
import {
  APPROVED_GROUP_COMPANIES_SQL,
  replaceNewsCompanyRelevance,
} from '../src/connectors/news-relevance';
import { backfillNewsRelevance } from '../src/cli/backfill-news-relevance';
import {
  CompanyAliasEntity,
  CompanyEntity,
  NewsSourceCompanyEntity,
  SourceItemEntity,
} from '@orsem/database';
import type { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';

const aliases = newsCompanyAliases([
  { id: 'apple', nameKo: '애플', nameEn: 'Apple Inc.', ticker: 'AAPL', stockCode: null },
  {
    id: 'nvidia',
    nameKo: '엔비디아',
    nameEn: 'NVIDIA Corporation',
    ticker: 'NVDA',
    stockCode: null,
  },
  {
    id: 'samsung',
    nameKo: '삼성전자',
    nameEn: 'Samsung Electronics Co., Ltd.',
    ticker: null,
    stockCode: '005930',
  },
  {
    id: 'electro',
    nameKo: '삼성전기',
    nameEn: 'Samsung Electro-Mechanics',
    ticker: null,
    stockCode: '009150',
  },
]);
it('reuses a large catalogue across titles while preserving exact boundaries and unrelated-title rejection', () => {
  const companies = Array.from({ length: 9140 }, (_, index) => ({
    id: `company-${index}`,
    nameKo: `검증기업${String(index).padStart(5, '0')}`,
    nameEn: `Verification Enterprise ${String(index).padStart(5, '0')} Incorporated`,
    ticker: `VX${index}`,
    stockCode: null,
  }));
  const match = createNewsCompanyMatcher(newsCompanyAliases(companies));
  for (const index of [0, 17, 999, 9139]) {
    expect(
      match(`Verification Enterprise ${String(index).padStart(5, '0')} Incorporated earnings`),
    ).toEqual([`company-${index}`]);
    expect(match(`검증기업${String(index).padStart(5, '0')}의 실적 발표`)).toEqual([
      `company-${index}`,
    ]);
    expect(match(`($VX${index}) shares`)).toEqual([`company-${index}`]);
    expect(match(`검증기업${String(index).padStart(5, '0')}서비스 실적 발표`)).toEqual([]);
  }
  expect(match('Central bank discusses inflation and monetary policy')).toEqual([]);
});
it('candidate indexing preserves normalized names, Unicode casing, and explicit symbol case variants', () => {
  const match = createNewsCompanyMatcher([
    { companyId: 'symbol', alias: 'ABC', aliasType: 'SYMBOL' },
    { companyId: 'symbol', alias: 'abc', aliasType: 'SYMBOL' },
    { companyId: 'greek', alias: 'ΟΣΟΣ', aliasType: 'NAME' },
    { companyId: 'width', alias: 'ＡＣＭＥ', aliasType: 'NAME' },
    { companyId: 'literal', alias: 'A+B', aliasType: 'NAME' },
  ]);
  expect(match('$ABC and $abc')).toEqual(['symbol']);
  expect(match('οσος earnings')).toEqual(['greek']);
  expect(match('ACME earnings')).toEqual(['width']);
  expect(match('A+B earnings')).toEqual(['literal']);
  expect(match('AxB earnings')).toEqual([]);
});
it('derives company base names with no alias rows and retains all definite title companies', () => {
  expect(matchNewsCompanies('NVIDIA and Apple Inc. report earnings', aliases)).toEqual([
    'apple',
    'nvidia',
  ]);
  expect(matchNewsCompanies('삼성전자와 삼성전기 실적 발표', aliases)).toEqual([
    'electro',
    'samsung',
  ]);
  expect(matchNewsCompanies('삼성전자의 영업이익', aliases)).toEqual(['samsung']);
});
it('does not infer company relevance from generic industry words, plain tickers or shared aliases', () => {
  expect(matchNewsCompanies('Apple growers announce harvest season', aliases)).toEqual([]);
  expect(matchNewsCompanies('NVDA technology market analysis', aliases)).toEqual([]);
  expect(matchNewsCompanies('($NVDA) shares rise', aliases)).toEqual(['nvidia']);
  const shared = [
    { companyId: 'a', alias: 'Acme', aliasType: 'NAME' },
    { companyId: 'b', alias: 'Acme', aliasType: 'NAME' },
  ];
  expect(matchNewsCompanies('Acme earnings', shared)).toEqual([]);
  expect(matchNewsCompanies('삼성전자서비스 발표', aliases)).toEqual([]);
});
it('never promotes ambiguous ordinary words merely because finance vocabulary is elsewhere in the title', () => {
  const ambiguous = newsCompanyAliases([
    { id: 'target', nameKo: '타겟', nameEn: 'Target Corporation', ticker: 'TGT', stockCode: null },
    { id: 'gap', nameKo: '갭', nameEn: 'Gap Inc.', ticker: 'GAP', stockCode: null },
    {
      id: 'msft',
      nameKo: '마이크로소프트',
      nameEn: 'Microsoft Corporation',
      ticker: 'MSFT',
      stockCode: null,
    },
  ]).concat(aliases);
  expect(matchNewsCompanies('Exporters target higher revenue next quarter', ambiguous)).toEqual([]);
  expect(matchNewsCompanies('Oil stocks see gap widen after earnings reports', ambiguous)).toEqual(
    [],
  );
  expect(matchNewsCompanies('Apple growers report record profit this year', ambiguous)).toEqual([]);
  expect(matchNewsCompanies('Microsoft shares target record highs', ambiguous)).toEqual(['msft']);
  expect(matchNewsCompanies('Target Corporation reports earnings', ambiguous)).toEqual(['target']);
  expect(matchNewsCompanies('Apple ($AAPL) reports earnings', ambiguous)).toEqual(['apple']);
});
it('keeps source kind/rights outside relevance mutation and makes repeated backfills idempotent', async () => {
  const rows: any[] = [];
  const repo = {
    find: jest.fn(async () => [...rows]),
    delete: jest.fn(),
    create: (v: unknown) => v,
    save: jest.fn(async (v: any) => {
      rows.push(v);
      return v;
    }),
  };
  const manager = { getRepository: () => repo } as unknown as EntityManager;
  await replaceNewsCompanyRelevance(manager, 'source', 'NVIDIA earnings', [
    { companyId: 'nvidia', matchMethod: 'TITLE_ALIAS' },
  ]);
  await replaceNewsCompanyRelevance(manager, 'source', 'NVIDIA earnings', [
    { companyId: 'nvidia', matchMethod: 'TITLE_ALIAS' },
  ]);
  expect(repo.save).toHaveBeenCalledTimes(1);
  expect(rows[0]).not.toHaveProperty('sourceKind');
  expect(rows[0]).not.toHaveProperty('rightsMode');
  expect(APPROVED_GROUP_COMPANIES_SQL).toMatch(/m\.status\s*=\s*'APPROVED'/);
  expect(APPROVED_GROUP_COMPANIES_SQL).not.toContain('is_shared');
});

it('backfill defaults to read-only, then writes only locked relevance rows with stable repeat behavior', async () => {
  const article = {
    id: 'source',
    title: 'NVIDIA earnings',
    source: 'NEWS_RSS',
    companyId: null,
    rawMetadataJson: null,
  };
  const company = {
    id: 'nvidia',
    nameKo: '엔비디아',
    nameEn: 'NVIDIA Corporation',
    ticker: 'NVDA',
    stockCode: null,
  };
  const relations: any[] = [];
  const save = jest.fn(async (row: any) => {
    relations.push(row);
    return row;
  });
  const sourceRepo = {
    find: jest.fn(async (options: any) => (options.where.id ? [] : [article])),
    findOne: jest.fn(async () => article),
  };
  const relationRepo = {
    find: async () => [...relations],
    create: (row: any) => row,
    save,
    delete: jest.fn(),
  };
  const getRepository = (entity: unknown): any =>
    entity === SourceItemEntity
      ? sourceRepo
      : entity === CompanyEntity
        ? { find: async () => [company] }
        : entity === CompanyAliasEntity
          ? { find: async () => [] }
          : entity === NewsSourceCompanyEntity
            ? relationRepo
            : (() => {
                throw new Error('Unexpected mutation target');
              })();
  const transaction = jest.fn(async (run: any) => run({ getRepository }));
  const source = { getRepository, transaction } as unknown as DataSource;
  expect(await backfillNewsRelevance(source)).toEqual({
    scanned: 1,
    relatedSources: 1,
    relations: 1,
    applied: false,
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  await backfillNewsRelevance(source, true);
  await backfillNewsRelevance(source, true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(sourceRepo.findOne).toHaveBeenCalledWith(
    expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
  );
  expect(article).not.toHaveProperty('sourceKind');
});
