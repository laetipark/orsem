import { z } from 'zod';

export const companyLogoProviderSchema = z.enum(['logoDev', 'brandfetch']);
export type CompanyLogoProvider = z.infer<typeof companyLogoProviderSchema>;
export const logoReviewStatusSchema = z.enum(['unreviewed', 'reviewed', 'rejected']);
export const logoRoleSchema = z.enum(['company', 'fund', 'issuer', 'fallback']);
const reviewedAtSchema = z.iso.datetime().nullable();
const sourceUrlSchema = z
  .string()
  .max(1000)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'An HTTPS source URL without credentials is required');

export function safeLocalCompanyLogoPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 240 &&
    /^\/logos\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|jpg|jpeg|webp)$/u.test(value)
  );
}

/** Domain normalization yields a candidate, never approval of the corporate identity. */
export function normalizeCompanyLogoDomain(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null;
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    const domain = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain) ||
      /\.(?:local|localhost|internal|invalid|test)$/u.test(domain)
    )
      return null;
    return domain;
  } catch {
    return null;
  }
}

export const reviewedLogoMappingSchema = z
  .object({
    value: z.string().min(1).max(253),
    sourceUrl: sourceUrlSchema,
    reviewStatus: logoReviewStatusSchema,
    reviewedAt: reviewedAtSchema,
  })
  .strict();
export type ReviewedLogoMapping = z.infer<typeof reviewedLogoMappingSchema>;

export const providerLogoMappingSchema = z
  .object({
    enabled: z.boolean(),
    ticker: reviewedLogoMappingSchema.nullable(),
    domain: reviewedLogoMappingSchema.nullable(),
    logoRole: logoRoleSchema,
  })
  .strict();
export type ProviderLogoMapping = z.infer<typeof providerLogoMappingSchema>;

export const reviewedLocalLogoSchema = z
  .object({
    path: z.string().refine(safeLocalCompanyLogoPath, 'Logo must be a reviewed file below /logos/'),
    source: z.enum(['manual', 'simple-icons', 'wikimedia']),
    sourceUrl: sourceUrlSchema,
    license: z.string().trim().min(1).max(500),
    attribution: z.string().trim().min(1).max(1000),
    rightsReviewed: z.boolean(),
    reviewStatus: logoReviewStatusSchema,
    reviewedAt: reviewedAtSchema,
    logoRole: logoRoleSchema,
  })
  .strict();
export type ReviewedLocalLogo = z.infer<typeof reviewedLocalLogoSchema>;

export const companyLogoMetadataSchema = z
  .object({
    companyId: z.string().min(1).max(128),
    market: z.enum(['KR', 'US']).nullable(),
    exchange: z.string().max(32).nullable(),
    symbol: z.string().max(32).nullable(),
    assetType: z.enum(['stock', 'etf', 'unknown']),
    issuerId: z.string().max(128).nullable(),
    officialDomain: reviewedLogoMappingSchema.nullable(),
    providers: z
      .object({ logoDev: providerLogoMappingSchema, brandfetch: providerLogoMappingSchema })
      .strict(),
    manualLogo: reviewedLocalLogoSchema.nullable(),
    localLogo: reviewedLocalLogoSchema.nullable(),
    issuerLogo: reviewedLocalLogoSchema.nullable(),
    reviewStatus: logoReviewStatusSchema,
    reviewedAt: reviewedAtSchema,
  })
  .strict();
export type CompanyLogoMetadata = z.infer<typeof companyLogoMetadataSchema>;

export const companyLogoResponseSchema = z
  .object({
    metadata: companyLogoMetadataSchema,
    providers: z
      .object({
        logoDev: z.object({ enabled: z.boolean(), publishableKey: z.string().nullable() }).strict(),
        brandfetch: z.object({ enabled: z.boolean(), clientId: z.string().nullable() }).strict(),
      })
      .strict(),
  })
  .strict();
export type CompanyLogoResponse = z.infer<typeof companyLogoResponseSchema>;
export const companyLogoPermitInputSchema = z
  .object({ provider: companyLogoProviderSchema })
  .strict();
export const companyLogoPermitResponseSchema = z.object({ allowed: z.boolean() }).strict();
