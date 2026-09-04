import { z } from 'zod';
import { readBoundedResponseText } from '../common/bounded-response';
import type { FetchImplementation } from '../opendart/opendart.client';

const MAX_ASSET_RESPONSE_BYTES = 32 * 1024 * 1024;

const alpacaAssetSchema = z
  .object({
    // Alpaca에는 버전 비트가 RFC 규격과 다른, 고정된 UUID 형태의 ID가 일부 있습니다.
    // 그 외에는 형식에 맞는 36자 16진수 식별자이므로 거절하지 않고 제공자의
    // 식별 정보를 보존합니다.
    id: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
    class: z.string().min(1).max(32),
    exchange: z.string().min(1).max(32),
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(2_000),
    status: z.string().min(1).max(32),
    tradable: z.boolean(),
    marginable: z.boolean(),
    maintenance_margin_requirement: z.union([z.string(), z.number()]).nullable().optional(),
    shortable: z.boolean(),
    easy_to_borrow: z.boolean(),
    fractionable: z.boolean(),
    attributes: z.array(z.string().max(128)).max(100).nullable().optional(),
  })
  .passthrough();

const alpacaAssetListSchema = z.array(alpacaAssetSchema).min(1).max(100_000);

export type AlpacaAssetSource = z.infer<typeof alpacaAssetSchema>;

export interface AlpacaAssetMasterItem {
  readonly providerAssetId: string;
  readonly assetClass: string;
  readonly exchange: string;
  readonly symbol: string;
  readonly name: string;
  readonly status: string;
  readonly tradable: boolean;
  readonly marginable: boolean;
  readonly maintenanceMarginRequirement: string | null;
  readonly shortable: boolean;
  readonly easyToBorrow: boolean;
  readonly fractionable: boolean;
  readonly attributes: readonly string[] | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export class AlpacaAssetMasterClient {
  public constructor(
    private readonly apiKey: string | null,
    private readonly apiSecret: string | null,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchImplementation,
    private readonly timeoutMs: number,
  ) {}

  public async fetchActiveUsEquities(): Promise<
    Readonly<{ items: readonly AlpacaAssetMasterItem[]; provenanceUrl: string }>
  > {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('ALPACA_API_KEY or ALPACA_API_SECRET missing');
    }
    const url = new URL('/v2/assets', `${this.baseUrl}/`);
    url.searchParams.set('status', 'active');
    url.searchParams.set('asset_class', 'us_equity');
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'APCA-API-KEY-ID': this.apiKey,
          'APCA-API-SECRET-KEY': this.apiSecret,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new Error('Alpaca asset-master request failed before receiving an HTTP response.');
    }
    if (!response.ok) {
      throw new Error(`Alpaca asset-master request failed with HTTP ${response.status}.`);
    }
    let parsed: AlpacaAssetSource[];
    try {
      parsed = alpacaAssetListSchema.parse(
        JSON.parse(
          await readBoundedResponseText(response, {
            maxBytes: MAX_ASSET_RESPONSE_BYTES,
            errorMessage: 'Alpaca asset-master response exceeded its size limit.',
            cancelReason: 'asset-master response too large',
          }),
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('size limit')) throw error;
      throw new Error('Alpaca asset-master response was not valid bounded JSON.');
    }
    return Object.freeze({
      provenanceUrl: url.toString(),
      items: Object.freeze(
        parsed.map((asset) =>
          Object.freeze({
            providerAssetId: asset.id,
            assetClass: asset.class,
            exchange: asset.exchange,
            symbol: asset.symbol.trim().toUpperCase(),
            name: asset.name.trim(),
            status: asset.status,
            tradable: asset.tradable,
            marginable: asset.marginable,
            maintenanceMarginRequirement:
              asset.maintenance_margin_requirement == null
                ? null
                : String(asset.maintenance_margin_requirement),
            shortable: asset.shortable,
            easyToBorrow: asset.easy_to_borrow,
            fractionable: asset.fractionable,
            attributes: asset.attributes ? Object.freeze([...asset.attributes]) : null,
            raw: Object.freeze({ ...asset }),
          }),
        ),
      ),
    });
  }
}
