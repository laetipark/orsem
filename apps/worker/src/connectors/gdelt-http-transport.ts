import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Agent } from 'undici';
import type { FetchImplementation } from '../opendart/opendart.client';

export const GDELT_CONNECT_TIMEOUT_MS = 20_000;
export const GDELT_REQUEST_TIMEOUT_MS = 30_000;

/** One transport per worker preserves the adapters' shared GDELT request/cooldown state. */
@Injectable()
export class GdeltHttpTransport implements OnModuleDestroy {
  private readonly dispatcher = new Agent({ connect: { timeout: GDELT_CONNECT_TIMEOUT_MS } });

  public readonly fetch: FetchImplementation = (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return globalThis.fetch(input, init);
    }
    if (url.origin !== 'https://api.gdeltproject.org' || url.pathname !== '/api/v2/doc/doc') {
      return globalThis.fetch(input, init);
    }

    // The native fetch dispatcher otherwise limits TCP/TLS connection setup to 10s,
    // independently of the adapter's request deadline. Keep this override local to GDELT.
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const requestInit: RequestInit = {
      ...init,
      // Node's bundled Undici types and the installed Agent expose the same fetch
      // dispatch contract but have different optional composition helper types.
      dispatcher: this.dispatcher as unknown as RequestInit['dispatcher'],
      redirect: 'error',
      signal: AbortSignal.any([
        AbortSignal.timeout(GDELT_REQUEST_TIMEOUT_MS),
        ...(callerSignal ? [callerSignal] : []),
      ]),
    };
    return globalThis.fetch(input, requestInit);
  };

  public async onModuleDestroy(): Promise<void> {
    await this.dispatcher.close();
  }
}
