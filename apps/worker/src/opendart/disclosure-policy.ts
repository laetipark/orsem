import { DisclosureDetailType, EventType } from '@orsem/contracts';

/** Explicit capabilities: extending a shared enum must not silently start a poller. */
export const OPENDART_WORKER_TYPES = Object.freeze([
  DisclosureDetailType.D001,
  DisclosureDetailType.D002,
  DisclosureDetailType.D003,
  DisclosureDetailType.D004,
  DisclosureDetailType.D005,
]);

export const DEFAULT_GLOBAL_ALERT_TYPES = Object.freeze([
  DisclosureDetailType.D001,
  DisclosureDetailType.D002,
  DisclosureDetailType.D005,
]);

export function requiresSourceReview(detailType: string): boolean {
  return detailType === 'D003' || detailType === 'D004';
}

export function filingEventType(detailType: string): EventType {
  switch (detailType) {
    case 'D001':
      return EventType.LARGE_HOLDER;
    case 'D002':
      return EventType.INSIDER_OWNERSHIP;
    case 'D003':
      return EventType.PROXY_SOLICITATION;
    case 'D004':
      return EventType.TENDER_OFFER;
    case 'D005':
      return EventType.TRADE_PLAN;
    default:
      throw new Error('Unsupported OpenDART event type.');
  }
}
