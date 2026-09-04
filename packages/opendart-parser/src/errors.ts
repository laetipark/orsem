export type OpenDartRetryPolicy = 'NONE' | 'SHORT_BACKOFF' | 'DELAYED_DOCUMENT' | 'NEXT_KST_DAY';

export class OpenDartPayloadError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OpenDartPayloadError';
  }
}

export class OpenDartApiError extends Error {
  public constructor(
    public readonly status: string,
    public readonly apiMessage: string,
    public readonly retryPolicy: OpenDartRetryPolicy,
  ) {
    super(`OpenDART API ${status}: ${apiMessage}`);
    this.name = 'OpenDartApiError';
  }
}

export function retryPolicyForOpenDartStatus(
  status: string,
  operation: 'LIST' | 'DOCUMENT' | 'CORP_CODE' | 'SUMMARY',
): OpenDartRetryPolicy {
  if (status === '020') return 'NEXT_KST_DAY';
  if (status === '800' || status === '900') return 'SHORT_BACKOFF';
  if (status === '014' && operation === 'DOCUMENT') {
    return 'DELAYED_DOCUMENT';
  }
  return 'NONE';
}
