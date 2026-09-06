import type { NaverNewsStatus } from '../types';

/** The server checks the same free allowance for automatic and manual searches. */
export function naverBudgetAvailable(status: NaverNewsStatus): boolean {
  return (
    status.configured &&
    status.automaticAllowed &&
    status.remainingToday !== null &&
    status.remainingToday > 0 &&
    status.remainingMonth !== null &&
    status.remainingMonth > 0
  );
}
