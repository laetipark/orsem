import { CompanyObservationService } from '../watchlist-groups/company-observation.service';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  companyRegion,
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
  private readonly logger = new Logger(LivePriceService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly data: OrsemDataService,
    private readonly sessions: SessionRuntimeService,
    @Optional() private readonly observations?: CompanyObservationService,
  ) {}

  async companyLivePrice(companyId: string): Promise<CompanyLivePrice> {
    const company = await this.data.getCompany(companyId);
    const now = new Date();
    const cached =
      this.config.tossClientId && this.config.tossClientSecret
        ? await this.sessions.readMarketQuote(companyId)
        : { available: false, value: null };
    const price = this.cachedCompanyPrice(company, cached, now);
    const closes = await this.fallbackCloses([company], [price], now);
    return {
      ...price,
      fallbackClose: closes.get(company.id) ?? null,
      ...(this.observations
        ? { displayPrice: await this.observations.price(company, cached, now) }
        : {}),
    };
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
    const [references, closes] = await Promise.all([
      this.data.previousDailyCloses(
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
      ),
      this.fallbackCloses(companies, prices, now),
    ]);
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
          fallbackClose: closes.get(price.companyId) ?? null,
          previousClose: reference?.close ?? null,
          change: change !== null && Number.isFinite(change) ? change : null,
          changePercent: percent !== null && Number.isFinite(percent) ? percent : null,
          referenceDate: reference?.sessionDate ?? null,
        };
      }),
    };
  }

  private async fallbackCloses(
    companies: Company[],
    prices: CompanyLivePrice[],
    now: Date,
  ): Promise<Map<string, NonNullable<CompanyLivePrice['fallbackClose']>>> {
    const today = this.kstDate(now);
    const requests = companies.flatMap((company, index) => {
      const quote = prices[index]?.quote;
      if (
        companyRegion(company.market) !== 'kr' ||
        (quote && this.kstDate(new Date(quote.providerAt)) >= today)
      ) {
        return [];
      }
      return [
        {
          companyId: company.id,
          source: 'TOSS_KR' as const,
          currency: 'KRW' as const,
          beforeDate: today,
        },
      ];
    });
    if (!requests.length) return new Map();
    try {
      const closes = await this.data.previousDailyCloses(requests);
      return new Map(
        [...closes].map(([companyId, close]) => [
          companyId,
          {
            price: String(close.close),
            currency: 'KRW' as const,
            sessionDate: close.sessionDate,
            source: 'TOSS_KR' as const,
          },
        ]),
      );
    } catch {
      // Stored closes are supplementary; their failure must not hide an available live quote.
      this.logger.warn('Previous session closing prices are unavailable.');
      return new Map();
    }
  }

  private kstDate(instant: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
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
      fallbackClose: null,
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
