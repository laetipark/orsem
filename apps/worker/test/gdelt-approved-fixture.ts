import { GDELT_METADATA_POLICY } from '@orsem/contracts';
import { GdeltMetadataConnector as Connector } from '../src/connectors/connector-adapters';
import type { FetchImplementation } from '../src/opendart/opendart.client';
/** Explicit synthetic publisher approval for transport tests, never a production allowlist. */
export class GdeltMetadataConnector extends Connector {
  constructor(
    enabled: boolean,
    fetcher: FetchImplementation,
    timeout: number,
    domains: readonly string[] = ['publisher.example'],
  ) {
    super(
      enabled,
      fetcher,
      timeout,
      domains,
      Object.fromEntries(domains.map((domain) => [domain, GDELT_METADATA_POLICY])),
    );
  }
}
