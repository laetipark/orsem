import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { NaverNewsBudgetService } from './naver-news-budget.service';

export const NAVER_NEWS_FETCH = Symbol('NAVER_NEWS_FETCH');

export const naverNewsSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(120),
    start: z.coerce.number().int().min(1).max(1000).default(1),
    sort: z.enum(['date', 'sim']).default('date'),
  })
  .strict();

const providerResponseSchema = z.object({
  lastBuildDate: z.string(),
  total: z.number().int().nonnegative(),
  start: z.number().int().min(1).max(1000),
  display: z.number().int().min(0).max(20),
  items: z
    .array(
      z.object({
        title: z.string(),
        originallink: z.string(),
        link: z.string(),
        description: z.string(),
        pubDate: z.string(),
      }),
    )
    .max(20),
});

export type NaverNewsSearchResult = z.infer<typeof providerResponseSchema> & {
  provider: 'NAVER';
};

@Injectable()
export class NaverNewsSearchService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional()
    @Inject(NAVER_NEWS_FETCH)
    private readonly fetchImpl: typeof fetch = fetch,
    @Optional() private readonly budget?: NaverNewsBudgetService,
  ) {}

  status() {
    if (this.budget) return this.budget.status();
    return Promise.resolve({
      configured: Boolean(this.config.naverClientId && this.config.naverClientSecret),
      automaticAllowed: false,
      mode: 'ON_DEMAND' as const,
      freeUntil: null,
      dailyLimit: this.config.naverNewsDailyLimit,
      monthlyLimit: this.config.naverNewsMonthlyLimit,
      remainingToday: null,
      remainingMonth: null,
      reason: '뉴스 검색 사용량 확인이 필요합니다.',
    });
  }

  async search(
    input: z.infer<typeof naverNewsSearchQuerySchema>,
    onRequest?: () => void,
  ): Promise<NaverNewsSearchResult> {
    const { naverClientId, naverClientSecret, naverApiProvider } = this.config;
    if (!naverClientId || !naverClientSecret) {
      throw new ServiceUnavailableException('네이버 뉴스 검색이 아직 설정되지 않았습니다.');
    }
    if (this.budget) await this.budget.reserve();
    else if (this.config.nodeEnv === 'production') {
      throw new ServiceUnavailableException(
        '뉴스 검색 사용량을 확인하지 못해 요청을 중단했습니다.',
      );
    }
    const cloud = naverApiProvider === 'ncloud';
    const url = new URL(
      cloud
        ? 'https://naverapihub.apigw.ntruss.com/search/v1/news'
        : 'https://openapi.naver.com/v1/search/news.json',
    );
    url.searchParams.set('query', input.q);
    url.searchParams.set('start', String(input.start));
    url.searchParams.set('sort', input.sort);
    url.searchParams.set('display', '20');
    if (cloud) url.searchParams.set('format', 'json');
    const credentials: Record<string, string> = cloud
      ? {
          'X-NCP-APIGW-API-KEY-ID': naverClientId,
          'X-NCP-APIGW-API-KEY': naverClientSecret,
        }
      : {
          'X-Naver-Client-Id': naverClientId,
          'X-Naver-Client-Secret': naverClientSecret,
        };
    const signal = AbortSignal.timeout(10_000);
    try {
      // NAVER 결과는 이 요청에서만 전달합니다. DB·캐시·수집기·AI 의존성을 두지 않습니다.
      // 리다이렉트를 거부해 다른 호스트로 인증 헤더가 전달되는 것도 방지합니다.
      onRequest?.();
      const response = await this.fetchImpl(url, {
        headers: { ...credentials, Accept: 'application/json' },
        signal,
        redirect: 'error',
        cache: 'no-store',
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new ServiceUnavailableException({
          code: 'NAVER_AUTH_INVALID',
          message: '네이버 뉴스 검색 인증 키를 확인해 주세요.',
        });
      }
      if (response.status === 403) {
        await response.body?.cancel();
        throw new ServiceUnavailableException({
          code: 'NAVER_ACCESS_DENIED',
          message: '네이버 뉴스 검색 API의 이용 권한을 확인해 주세요.',
        });
      }
      if (response.status === 429) {
        await response.body?.cancel();
        throw new HttpException(
          '네이버 뉴스 검색 한도에 도달했습니다. 잠시 후 다시 검색해 주세요.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BadGatewayException('네이버 뉴스 검색에 연결하지 못했습니다.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BadGatewayException('네이버 뉴스 검색 응답이 비어 있습니다.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new BadGatewayException('네이버 뉴스 검색 응답 크기를 확인할 수 없습니다.');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const parsed = providerResponseSchema.safeParse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (!parsed.success) {
        throw new BadGatewayException('네이버 뉴스 검색 응답을 확인할 수 없습니다.');
      }
      // 원래 순서와 문자열을 그대로 전달합니다. 강조 HTML과 URL은 화면에서 안전하게 표시합니다.
      return { provider: 'NAVER', ...parsed.data };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
        throw new GatewayTimeoutException('네이버 뉴스 검색 응답이 지연되고 있습니다.');
      }
      // 제공자 오류 본문·검색어·인증 값·네트워크 오류를 로그나 응답에 포함하지 않습니다.
      throw new BadGatewayException('네이버 뉴스 검색에 연결하지 못했습니다.');
    }
  }
}
