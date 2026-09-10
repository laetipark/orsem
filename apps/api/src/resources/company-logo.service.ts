import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SourceCheckpointEntity } from '@orsem/database';
import {
  companyLogoMetadataSchema,
  companyLogoPermitInputSchema,
  normalizeCompanyLogoDomain,
  type CompanyLogoMetadata,
  type CompanyLogoProvider,
  type CompanyLogoResponse,
  type ReviewedLocalLogo,
  type ReviewedLogoMapping,
} from '@orsem/contracts';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { parseWith } from '../common/zod';
import { DatabaseRuntimeService } from '../persistence/database-runtime.service';
import {
  CompanyLogoPermitAccess,
  Public,
  RateLimit,
  ReadOnlyMemberAccess,
} from '../security/security';
import { SessionRuntimeService } from '../security/session-runtime.service';
import { FixtureStoreService } from '../fixtures/fixture-store.service';
import { CompanyInformationApiService } from './company-information.service';
import { groupActor } from '../watchlist-groups/watchlist-access.service';

const KR_EXCHANGES = ['KRX', 'KOSPI', 'KOSDAQ', 'KONEX'];
const US_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'OTC'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const CONNECTOR = 'COMPANY_LOGO_METADATA';
function json(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return json(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
interface LogoIdentityRow {
  id: string;
  market: string;
  symbol: string | null;
  corpCode?: string | null;
  cik?: string | null;
  metadata?: unknown;
  stockMetadata?: unknown;
  etfMetadata?: unknown;
  homepage?: unknown;
}
export function reviewedLogoMapping(
  value: ReviewedLogoMapping | ReviewedLocalLogo | null,
): boolean {
  return Boolean(
    value &&
    value.reviewStatus === 'reviewed' &&
    value.reviewedAt &&
    Number.isFinite(Date.parse(value.reviewedAt)) &&
    Date.parse(value.reviewedAt) <= Date.now() + 60_000,
  );
}

/** Read source identity without merging share classes or guessing security type from names. */
export function initialCompanyLogoMetadata(company: LogoIdentityRow): CompanyLogoMetadata {
  const etf = json(company.etfMetadata);
  const stockMetadata = json(company.stockMetadata);
  const stock =
    stockMetadata.companyId === company.id && stockMetadata.symbol === company.symbol
      ? json(stockMetadata.rawPayload)
      : {};
  const isEtf =
    (etf.companyId === company.id && etf.symbol === company.symbol && etf.securityType === 'ETF') ||
    stock.securityType === 'ETF';
  const market = KR_EXCHANGES.includes(company.market)
    ? 'KR'
    : US_EXCHANGES.includes(company.market)
      ? 'US'
      : null;
  const domain =
    market === 'KR' && !isEtf && /^\d{8}$/u.test(company.corpCode ?? '')
      ? normalizeCompanyLogoDomain(company.homepage)
      : null;
  // KRX is a broad market label. Reuse the existing matching TOSS security record,
  // without changing the company row or guessing a venue from its code/name.
  const stockExchange =
    stock.symbol === company.symbol &&
    stock.currency === 'KRW' &&
    stock.status === 'ACTIVE' &&
    stock.securityType === (isEtf ? 'ETF' : 'STOCK') &&
    (stock.market === 'KOSPI' || stock.market === 'KOSDAQ')
      ? stock.market
      : null;
  return {
    companyId: company.id,
    market,
    exchange: company.market === 'KRX' ? stockExchange : company.market || null,
    symbol: company.symbol,
    assetType: isEtf ? 'etf' : stock.securityType === 'STOCK' ? 'stock' : 'unknown',
    issuerId: isEtf
      ? null
      : company.corpCode
        ? `DART:${company.corpCode}`
        : company.cik
          ? `SEC:${company.cik}`
          : null,
    officialDomain: domain
      ? {
          value: domain,
          sourceUrl: 'https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002',
          reviewStatus: 'unreviewed',
          reviewedAt: null,
        }
      : null,
    providers: {
      logoDev: { enabled: true, ticker: null, domain: null, logoRole: isEtf ? 'fund' : 'company' },
      brandfetch: {
        enabled: true,
        ticker: null,
        domain: null,
        logoRole: isEtf ? 'fund' : 'company',
      },
    },
    manualLogo: null,
    localLogo: null,
    issuerLogo: null,
    reviewStatus: 'unreviewed',
    reviewedAt: null,
  };
}

function requireReviewedMapping(mapping: ReviewedLogoMapping | null, domain: boolean): void {
  if (!mapping) return;
  if (
    !reviewedLogoMapping(mapping) ||
    (domain
      ? normalizeCompanyLogoDomain(mapping.value) !== mapping.value
      : !/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/u.test(mapping.value))
  )
    throw new BadRequestException('검수된 종목·기업 도메인 매핑과 검수일이 필요합니다.');
}
export function validateCompanyLogoRegistration(metadata: CompanyLogoMetadata): void {
  if (
    !reviewedLogoMapping({
      value: '',
      sourceUrl: 'https://www.logo.dev/',
      reviewStatus: metadata.reviewStatus === 'rejected' ? 'reviewed' : metadata.reviewStatus,
      reviewedAt: metadata.reviewedAt,
    })
  )
    throw new BadRequestException('종목 로고 메타데이터 검수가 필요합니다.');
  requireReviewedMapping(metadata.officialDomain, true);
  for (const asset of [metadata.manualLogo, metadata.localLogo, metadata.issuerLogo]) {
    if (asset && (!asset.rightsReviewed || !reviewedLogoMapping(asset)))
      throw new BadRequestException('로컬 파일의 이용 조건과 기업 매핑 검수가 필요합니다.');
    if (asset && metadata.assetType === 'etf' && !['fund', 'issuer'].includes(asset.logoRole))
      throw new BadRequestException('ETF 상품 또는 운용사 로고를 구분해 주세요.');
  }
  if (metadata.issuerLogo && (metadata.issuerLogo.logoRole !== 'issuer' || !metadata.issuerId))
    throw new BadRequestException('운용사 식별자와 issuer 역할이 필요합니다.');
  for (const provider of Object.values(metadata.providers)) {
    requireReviewedMapping(provider.ticker, false);
    requireReviewedMapping(provider.domain, true);
    if (
      metadata.assetType === 'etf' &&
      (provider.ticker || provider.domain) &&
      !['fund', 'issuer'].includes(provider.logoRole)
    )
      throw new BadRequestException('ETF 공급자 매핑은 상품 또는 운용사 로고여야 합니다.');
    if (
      provider.logoRole === 'issuer' &&
      (provider.ticker || provider.domain) &&
      !metadata.issuerId
    )
      throw new BadRequestException('운용사 로고에는 검수된 운용사 식별자가 필요합니다.');
  }
}

@Injectable()
export class CompanyLogoService {
  constructor(
    private readonly database: DatabaseRuntimeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionRuntimeService,
    private readonly fixtures: FixtureStoreService,
  ) {}

  private async identity(id: string): Promise<LogoIdentityRow> {
    if (this.config.fixtureMode) {
      const company = this.fixtures.companies.find((row) => row.id === id);
      if (!company) throw new NotFoundException('기업을 찾을 수 없습니다.');
      return { ...company, symbol: company.stockCode ?? company.ticker };
    }
    const rows: LogoIdentityRow[] = await this.database.requireDataSource().query(
      `SELECT c.id,c.market,COALESCE(c.stock_code,c.ticker) symbol,c.corp_code corpCode,c.cik,
       cp.metadata_json metadata,stock.metadata_json stockMetadata,etf.metadata_json etfMetadata,
       (SELECT JSON_UNQUOTE(JSON_EXTRACT(s.raw_json,'$.annual.profile.hm_url'))
        FROM company_information_snapshots s WHERE s.company_id=c.id AND s.source='OPENDART'
        AND JSON_UNQUOTE(JSON_EXTRACT(s.raw_json,'$.annual.profile.corp_code'))=c.corp_code
        ORDER BY s.observed_at DESC,s.id DESC LIMIT 1) homepage
       FROM companies c
       LEFT JOIN source_checkpoints cp ON cp.connector='${CONNECTOR}' AND cp.stream=c.id
       LEFT JOIN source_checkpoints stock ON stock.connector='TOSS' AND stock.stream=CONCAT('STOCK_INFO:',c.id)
       LEFT JOIN source_checkpoints etf ON etf.connector='TOSS' AND etf.stream=CONCAT('KR_ETF_IDENTITY:',c.id)
       WHERE c.id=?`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('기업을 찾을 수 없습니다.');
    return rows[0];
  }

  private providers(): CompanyLogoResponse['providers'] {
    const sharedBudgetReady = !this.config.fixtureMode && this.sessions.health.ready;
    const logoDev =
      sharedBudgetReady &&
      this.config.logoDevEnabled &&
      Boolean(this.config.logoDevPublishableKey) &&
      this.config.logoDevMonthlyLimit > 0;
    const brandfetch =
      sharedBudgetReady &&
      this.config.brandfetchEnabled &&
      Boolean(this.config.brandfetchClientId) &&
      this.config.brandfetchMonthlyLimit > 0;
    return {
      logoDev: {
        enabled: logoDev,
        publishableKey: logoDev ? this.config.logoDevPublishableKey! : null,
      },
      brandfetch: {
        enabled: brandfetch,
        clientId: brandfetch ? this.config.brandfetchClientId! : null,
      },
    };
  }

  async get(id: string): Promise<CompanyLogoResponse> {
    const company = await this.identity(id);
    let metadata = initialCompanyLogoMetadata(company);
    const record = json(company.metadata);
    // Damaged/stale review records must not silently re-enable automatic lookup.
    if (Object.keys(record).length > 0) {
      metadata.providers.logoDev.enabled = false;
      metadata.providers.brandfetch.enabled = false;
    }
    const stored = companyLogoMetadataSchema.safeParse(record.mapping);
    if (
      stored.success &&
      stored.data.companyId === id &&
      stored.data.market === metadata.market &&
      stored.data.symbol === metadata.symbol &&
      stored.data.exchange === metadata.exchange &&
      !(metadata.assetType === 'etf' && stored.data.assetType !== 'etf')
    ) {
      // URL generation / image loading never writes a review status or overwrites source identity.
      try {
        validateCompanyLogoRegistration(stored.data);
        metadata = stored.data;
      } catch {
        /* fail closed */
      }
    }
    return { metadata, providers: this.providers() };
  }

  async permit(id: string, provider: CompanyLogoProvider): Promise<{ allowed: boolean }> {
    const global = this.providers()[provider];
    if (!global.enabled) return { allowed: false };
    const { metadata } = await this.get(id);
    if (metadata.reviewStatus === 'rejected' || !metadata.providers[provider].enabled)
      return { allowed: false };
    return {
      allowed: await this.sessions.consumeCompanyLogoBudget(
        provider,
        provider === 'logoDev'
          ? this.config.logoDevMonthlyLimit
          : this.config.brandfetchMonthlyLimit,
      ),
    };
  }

  async save(
    id: string,
    metadata: CompanyLogoMetadata,
    adminId: string,
  ): Promise<CompanyLogoResponse> {
    if (!UUID.test(adminId)) throw new ForbiddenException('관리자 권한이 필요합니다.');
    const current = initialCompanyLogoMetadata(await this.identity(id));
    if (
      metadata.companyId !== id ||
      metadata.market !== current.market ||
      metadata.symbol !== current.symbol ||
      metadata.exchange !== current.exchange ||
      (current.assetType !== 'unknown' && metadata.assetType !== current.assetType)
    )
      throw new BadRequestException('로고 설정으로 종목의 식별 정보를 변경할 수 없습니다.');
    validateCompanyLogoRegistration(metadata);
    if (this.config.fixtureMode)
      throw new BadRequestException('운영 데이터베이스에서만 로고 검수를 저장할 수 있습니다.');
    await this.database
      .requireDataSource()
      .getRepository(SourceCheckpointEntity)
      .upsert(
        {
          connector: CONNECTOR,
          stream: id,
          lastSuccessDate: null,
          cursor: null,
          lastSuccessAt: null,
          metadataJson: {
            version: 1,
            mapping: metadata,
            updatedBy: adminId,
            updatedAt: new Date().toISOString(),
          },
        },
        ['connector', 'stream'],
      );
    return { metadata, providers: this.providers() };
  }

  async credits(): Promise<{
    items: Array<
      Pick<ReviewedLocalLogo, 'path' | 'source' | 'sourceUrl' | 'license' | 'attribution'>
    >;
  }> {
    if (this.config.fixtureMode || !this.database.dataSource) return { items: [] };
    const rows: Array<{ metadata: unknown }> = await this.database
      .requireDataSource()
      .query(
        `SELECT metadata_json metadata FROM source_checkpoints WHERE connector='${CONNECTOR}'`,
      );
    const items = new Map<
      string,
      Pick<ReviewedLocalLogo, 'path' | 'source' | 'sourceUrl' | 'license' | 'attribution'>
    >();
    for (const row of rows) {
      const parsed = companyLogoMetadataSchema.safeParse(json(row.metadata).mapping);
      if (!parsed.success) continue;
      for (const asset of [parsed.data.manualLogo, parsed.data.localLogo, parsed.data.issuerLogo]) {
        if (!asset || !asset.rightsReviewed || !reviewedLogoMapping(asset)) continue;
        const { path, source, sourceUrl, license, attribution } = asset;
        const credit = { path, source, sourceUrl, license, attribution };
        items.set(JSON.stringify(credit), credit);
      }
    }
    return { items: [...items.values()] };
  }
}

@Controller('companies')
@ReadOnlyMemberAccess()
export class CompanyLogoController {
  constructor(
    private readonly logos: CompanyLogoService,
    private readonly information: CompanyInformationApiService,
  ) {}

  @Get('logo-credits')
  @Public()
  @RateLimit(60)
  @Header('Cache-Control', 'public, max-age=300')
  credits() {
    return this.logos.credits();
  }

  @Get(':id/logo')
  @RateLimit(180)
  @Header('Cache-Control', 'private, no-store')
  async get(@Param('id') id: string, @Req() request: Request) {
    this.actor(request);
    return this.logos.get(await this.information.resolveId(id));
  }

  @Post(':id/logo-permit')
  @CompanyLogoPermitAccess()
  @RateLimit(180)
  @Header('Cache-Control', 'private, no-store')
  async permit(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    this.actor(request);
    const input = parseWith(companyLogoPermitInputSchema, body);
    return this.logos.permit(await this.information.resolveId(id), input.provider);
  }

  @Patch(':id/logo')
  @RateLimit(30)
  async save(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
    const actor = this.actor(request);
    if (actor.kind !== 'ADMIN') throw new ForbiddenException('관리자 권한이 필요합니다.');
    return this.logos.save(
      await this.information.resolveId(id),
      parseWith(companyLogoMetadataSchema, body),
      actor.id,
    );
  }

  private actor(request: Request) {
    const actor = groupActor(request);
    if (!UUID.test(actor.id)) throw new UnauthorizedException('로그인이 필요합니다.');
    return actor;
  }
}
