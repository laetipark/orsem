import { Inject, Injectable } from '@nestjs/common';
import {
  livePriceQuoteSchema,
  livePriceSnapshotSchema,
  type CompanyLivePrice,
  type Company,
  type WatchlistQuotes,
} from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { OrsemDataService } from './orsem-data.service';

@Injectable()
export class LivePriceService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly data: OrsemDataService,
    private readonly sessions: SessionRuntimeService,
  ) {}

  async companyLivePrice(companyId: string): Promise<CompanyLivePrice> {
    const company = await this.data.getCompany(companyId);
    const now = new Date();
    const cached =
      this.config.tossClientId && this.config.tossClientSecret
        ? await this.sessions.readMarketQuote(companyId)
        : { available: false, value: null };
    return this.cachedCompanyPrice(company, cached, now);
  }

  async watchlistQuotes(companyIds: string[]): Promise<WatchlistQuotes> {
    const companies = await this.data.watchedCompanies(companyIds);
    const now = new Date();
    const cached =
      this.config.tossClientId && this.config.tossClientSecret
        ? await this.sessions.readMarketQuotes(companies.map((company) => company.id))
        : { available: false, values: companies.map(() => null) };
    const prices = companies.map((company, index) =>
      this.cachedCompanyPrice(
        company,
        { available: cached.available, value: cached.values[index] ?? null },
        now,
      ),
    );
    const references = await this.data.previousDailyCloses(
      prices.flatMap((price) =>
        price.quote
          ? [
              {
                companyId: price.companyId,
                source:
                  price.quote.currency === 'USD' ? ('TOSS_US' as const) : ('TOSS_KR' as const),
                currency: price.quote.currency,
                beforeDate: new Intl.DateTimeFormat('en-CA', {
                  timeZone: price.quote.currency === 'USD' ? 'America/New_York' : 'Asia/Seoul',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                }).format(new Date(price.quote.providerAt)),
              },
            ]
          : [],
      ),
    );
    return {
      asOf: now.toISOString(),
      items: prices.map((price) => {
        const reference = references.get(price.companyId);
        const change =
          price.quote && reference ? Number(price.quote.price) - reference.close : null;
        const percent = change !== null && reference ? (change / reference.close) * 100 : null;
        return {
          companyId: price.companyId,
          status: price.status,
          quote: price.quote,
          previousClose: reference?.close ?? null,
          change: change !== null && Number.isFinite(change) ? change : null,
          changePercent: percent !== null && Number.isFinite(percent) ? percent : null,
          referenceDate: reference?.sessionDate ?? null,
        };
      }),
    };
  }

  private cachedCompanyPrice(
    company: Company,
    cached: { available: boolean; value: string | null },
    now: Date,
  ): CompanyLivePrice {
    const companyId = company.id;
    const result: CompanyLivePrice = {
      companyId,
      provider: 'toss',
      status: 'NOT_CONFIGURED',
      quote: null,
      asOf: now.toISOString(),
    };
    if (!this.config.tossClientId || !this.config.tossClientSecret) return result;
    if (!cached.available) return { ...result, status: 'UNAVAILABLE' };
    if (!cached.value) return { ...result, status: 'WAITING' };
    try {
      const parsed = livePriceSnapshotSchema.safeParse(JSON.parse(cached.value));
      if (!parsed.success || parsed.data.companyId !== companyId) {
        return { ...result, status: 'UNAVAILABLE' };
      }
      const isUs = ['NASDAQ', 'NYSE', 'AMEX'].includes(company.market);
      if (
        (parsed.data.source === 'TOSS_US') !== isUs ||
        parsed.data.currency !== (isUs ? 'USD' : 'KRW')
      ) {
        return { ...result, status: 'UNAVAILABLE' };
      }
      // 캐시를 새로 저장했더라도 오래된 제공자 체결을 실시간으로 표시하지 않습니다.
      const observedAge = now.getTime() - Date.parse(parsed.data.observedAt);
      const providerAge = now.getTime() - Date.parse(parsed.data.providerAt);
      const stale =
        Math.max(observedAge, providerAge) > 15_000 || Math.min(observedAge, providerAge) < -5_000;
      return {
        ...result,
        status: stale ? 'STALE' : 'LIVE',
        // Zod가 원본 프레임과 추가 필드를 제거하므로 이 화면용 모델에는
        // 자격증명이나 제공자의 원본 응답이 포함되지 않습니다.
        quote: livePriceQuoteSchema.parse(parsed.data),
      };
    } catch {
      return { ...result, status: 'UNAVAILABLE' };
    }
  }
}
