import type { OpenDartRetryPolicy } from '@orsem/opendart-parser';

export interface OpenDartStatusPolicy {
  readonly emptyResult: boolean;
  readonly retryPolicy: OpenDartRetryPolicy;
  readonly disablesUntilNextKstDay: boolean;
}

export function openDartStatusPolicy(
  status: string,
  operation: 'LIST' | 'DOCUMENT' | 'CORP_CODE' | 'SUMMARY',
): OpenDartStatusPolicy {
  if (status === '000') {
    return {
      emptyResult: false,
      retryPolicy: 'NONE',
      disablesUntilNextKstDay: false,
    };
  }
  if (status === '013') {
    return {
      emptyResult: true,
      retryPolicy: 'NONE',
      disablesUntilNextKstDay: false,
    };
  }
  if (status === '020') {
    return {
      emptyResult: false,
      retryPolicy: 'NEXT_KST_DAY',
      disablesUntilNextKstDay: true,
    };
  }
  if (status === '800' || status === '900') {
    return {
      emptyResult: false,
      retryPolicy: 'SHORT_BACKOFF',
      disablesUntilNextKstDay: false,
    };
  }
  if (status === '014' && operation === 'DOCUMENT') {
    return {
      emptyResult: false,
      retryPolicy: 'DELAYED_DOCUMENT',
      disablesUntilNextKstDay: false,
    };
  }
  return {
    emptyResult: false,
    retryPolicy: 'NONE',
    disablesUntilNextKstDay: false,
  };
}
