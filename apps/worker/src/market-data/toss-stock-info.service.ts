import { Injectable } from '@nestjs/common';
import { Market, RightsMode } from '@orsem/contracts';
import { CompanyEntity, SourceCheckpointEntity } from '@orsem/database';
import { DataSource, In } from 'typeorm';
import { toKstDateOnly } from '../common/kst-date';
import type { TossScopeCompany } from './toss-market-data.service';
import {
  TossHttpError,
  TossMarketClient,
  tossStockSchema,
  type TossStock,
} from './toss-market.client';

const US_MARKETS: readonly string[] = [Market.NASDAQ, Market.NYSE, Market.AMEX];
const KR_MARKETS: readonly string[] = [Market.KRX, Market.KOSPI, Market.KOSDAQ, Market.KONEX];
const STOCK_INFO_TTL_MS = 24 * 60 * 60 * 1000;
const streamFor = (companyId: string) => `STOCK_INFO:${companyId}`;

function displayName(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\p{Cc}/gu, '').trim();
  return normalized ? [...normalized].slice(0, 255).join('') : null;
}

function matchesCompany(company: CompanyEntity, stock: TossStock): boolean {
  if (!company.isListed) return false;
  if (US_MARKETS.includes(company.market))
    return (
      company.ticker === stock.symbol && company.market === stock.market && stock.currency === 'USD'
    );
  return (
    company.stockCode === stock.symbol &&
    KR_MARKETS.includes(company.market) &&
    ['KOSPI', 'KOSDAQ', 'KR_ETC'].includes(stock.market) &&
    stock.currency === 'KRW'
  );
}

function cachedStock(
  company: CompanyEntity,
  scope: TossScopeCompany,
  checkpoint: SourceCheckpointEntity | null | undefined,
  now: Date,
): TossStock | null {
  const stock = tossStockSchema.safeParse(checkpoint?.metadataJson?.rawPayload);
  const age = now.getTime() - (checkpoint?.lastSuccessAt?.getTime() ?? NaN);
  return stock.success &&
    stock.data.symbol === scope.symbol &&
    stock.data.status === 'ACTIVE' &&
    matchesCompany(company, stock.data) &&
    age >= 0 &&
    age < STOCK_INFO_TTL_MS
    ? stock.data
    : null;
}

export function tossCompanyNamePatch(
  company: CompanyEntity,
  stock: TossStock,
  previous: Record<string, unknown> | null,
): Partial<Pick<CompanyEntity, 'nameKo' | 'nameEn'>> {
  if (!US_MARKETS.includes(company.market) || !matchesCompany(company, stock)) return {};
  const patch: Partial<Pick<CompanyEntity, 'nameKo' | 'nameEn'>> = {};
  const koreanName = displayName(stock.name);
  // 별도로 등록한 한국어 이름은 보존한다. 토스가 적용한 이름만 같은 출처로 갱신한다.
  const replaceable =
    !/[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(company.nameKo) || previous?.appliedNameKo === company.nameKo;
  if (
    koreanName &&
    /[가-힣ㄱ-ㅎㅏ-ㅣ]/u.test(koreanName) &&
    replaceable &&
    koreanName !== company.nameKo
  )
    patch.nameKo = koreanName;
  // 기존 영문 원문은 덮어쓰지 않고, 없는 경우에만 공식 영문명을 보완한다.
  if (!company.nameEn?.trim()) {
    const englishName = displayName(stock.englishName);
    if (englishName) patch.nameEn = englishName;
  }
  return patch;
}

@Injectable()
export class TossStockInfoService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly client: TossMarketClient,
  ) {}

  async lookup(scopes: readonly TossScopeCompany[]): Promise<Map<string, TossStock>> {
    const result = new Map<string, TossStock>();
    if (!this.client.enabled || scopes.length === 0) return result;
    if (scopes.length > 100) throw new Error('Toss stock information scope exceeds 100 companies.');
    const requested = new Map(scopes.map((scope) => [scope.symbol, scope]));
    if (requested.size !== scopes.length)
      throw new Error('Toss stock information scope is ambiguous.');
    const companies = await this.dataSource.getRepository(CompanyEntity).find({
      where: { id: In(scopes.map((scope) => scope.companyId)), isListed: true },
    });
    const byId = new Map(companies.map((company) => [company.id, company]));
    const checkpoints = await this.dataSource.getRepository(SourceCheckpointEntity).find({
      where: { connector: 'TOSS', stream: In(scopes.map((scope) => streamFor(scope.companyId))) },
    });
    const cached = new Map(checkpoints.map((checkpoint) => [checkpoint.stream, checkpoint]));
    const missing: TossScopeCompany[] = [];
    const now = new Date();
    for (const scope of scopes) {
      const company = byId.get(scope.companyId);
      if (!company) continue;
      const checkpoint = cached.get(streamFor(scope.companyId));
      let stock = cachedStock(company, scope, checkpoint, now);
      if (
        stock &&
        Object.keys(tossCompanyNamePatch(company, stock, checkpoint?.metadataJson ?? null)).length
      )
        stock = await this.hydrateCachedNames(scope, now);
      if (stock) result.set(scope.symbol, stock);
      else missing.push(scope);
    }
    if (missing.length === 0) return result;

    const missingSymbols = new Set(missing.map((scope) => scope.symbol));
    const response = await this.availableStocks([...missingSymbols]);
    const seen = new Set<string>();
    // 응답 전체를 확인한 뒤 저장하여 잘못된 심볼이나 중복 응답의 일부만 반영하지 않는다.
    for (const stock of response) {
      if (!missingSymbols.has(stock.symbol) || seen.has(stock.symbol))
        throw new Error('Toss stock lookup returned an unrequested or duplicate symbol.');
      seen.add(stock.symbol);
    }
    for (const stock of response) {
      const scope = requested.get(stock.symbol)!;
      const company = byId.get(scope.companyId);
      if (!company || stock.status !== 'ACTIVE' || !matchesCompany(company, stock)) continue;
      if (await this.persist(scope, stock, now)) result.set(stock.symbol, stock);
    }
    return result;
  }

  private async availableStocks(symbols: readonly string[]): Promise<readonly TossStock[]> {
    try {
      return await this.client.stocks(symbols);
    } catch (error) {
      if (!(error instanceof TossHttpError) || error.status !== 404) throw error;
      // 목록 갱신 사이에 사라진 한 종목 때문에 같은 배치의 다른 이름을 누락하지 않는다.
      if (symbols.length === 1) return [];
      const middle = Math.ceil(symbols.length / 2);
      return [
        ...(await this.availableStocks(symbols.slice(0, middle))),
        ...(await this.availableStocks(symbols.slice(middle))),
      ];
    }
  }

  private async hydrateCachedNames(scope: TossScopeCompany, now: Date): Promise<TossStock | null> {
    return this.dataSource.transaction(async (manager) => {
      const companies = manager.getRepository(CompanyEntity);
      const company = await companies.findOne({
        where: { id: scope.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!company) return null;
      const checkpoints = manager.getRepository(SourceCheckpointEntity);
      const checkpoint = await checkpoints.findOne({
        where: { connector: 'TOSS', stream: streamFor(scope.companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      const stock = cachedStock(company, scope, checkpoint, now);
      if (!stock || !checkpoint) return null;
      const patch = tossCompanyNamePatch(company, stock, checkpoint.metadataJson ?? null);
      if (Object.keys(patch).length) {
        await companies.update({ id: company.id }, patch);
        // 캐시로 이름을 복구한 시각을 공급자 데이터를 새로 관측한 시각으로 기록하지 않는다.
        await checkpoints.save(
          checkpoints.create({
            ...checkpoint,
            metadataJson: {
              ...checkpoint.metadataJson,
              originalCompanyNames: checkpoint.metadataJson?.originalCompanyNames ?? {
                nameKo: company.nameKo,
                nameEn: company.nameEn,
              },
              appliedNameKo: patch.nameKo ?? checkpoint.metadataJson?.appliedNameKo ?? null,
            },
          }),
        );
      }
      return stock;
    });
  }

  private async persist(
    scope: TossScopeCompany,
    stock: TossStock,
    observedAt: Date,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const companies = manager.getRepository(CompanyEntity);
      const company = await companies.findOne({
        where: { id: scope.companyId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!company || !matchesCompany(company, stock)) return false;
      const checkpoints = manager.getRepository(SourceCheckpointEntity);
      const previous = await checkpoints.findOne({
        where: { connector: 'TOSS', stream: streamFor(scope.companyId) },
        lock: { mode: 'pessimistic_write' },
      });
      const previousStock = tossStockSchema.safeParse(previous?.metadataJson?.rawPayload);
      // 티커 재사용으로 다른 증권의 이름이 기존 기업에 붙지 않도록 식별자 변경을 차단한다.
      if (previousStock.success && previousStock.data.isinCode !== stock.isinCode) return false;
      const patch = tossCompanyNamePatch(company, stock, previous?.metadataJson ?? null);
      if (Object.keys(patch).length) await companies.update({ id: company.id }, patch);
      const firstObservedAt = previous?.metadataJson?.firstObservedAt;
      await checkpoints.save(
        checkpoints.create({
          ...(previous ?? {}),
          connector: 'TOSS',
          stream: streamFor(company.id),
          lastSuccessDate: toKstDateOnly(observedAt),
          lastSuccessAt: observedAt,
          cursor: null,
          metadataJson: {
            version: 1,
            companyId: company.id,
            symbol: stock.symbol,
            source: 'TOSS',
            rightsMode: RightsMode.PRIVATE_DISPLAY_ONLY,
            provenanceUrl: `https://openapi.tossinvest.com/api/v1/stocks?symbols=${encodeURIComponent(stock.symbol)}`,
            rawPayload: { ...stock },
            firstObservedAt:
              typeof firstObservedAt === 'string' ? firstObservedAt : observedAt.toISOString(),
            observedAt: observedAt.toISOString(),
            originalCompanyNames: previous?.metadataJson?.originalCompanyNames ?? {
              nameKo: company.nameKo,
              nameEn: company.nameEn,
            },
            appliedNameKo: patch.nameKo ?? previous?.metadataJson?.appliedNameKo ?? null,
          },
        }),
      );
      return true;
    });
  }
}
