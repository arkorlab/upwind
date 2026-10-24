import { PatternBudgetExceededError } from '@stayingupwind/core/request';

/** Requests already made before this pattern failure; the same error keeps its identity. */
const REQUESTS = new WeakMap<PatternBudgetExceededError, number>();

/** Retain an existing source count only when a pattern failure bypasses its normal result. */
export function addImagePatternRequests(error: unknown, requests: number): void {
  if (error instanceof PatternBudgetExceededError) {
    REQUESTS.set(error, (REQUESTS.get(error) ?? 0) + requests);
  }
}

/** A pattern failure before any source dispatch has no requests to carry. */
export function imagePatternRequests(error: PatternBudgetExceededError): number {
  return REQUESTS.get(error) ?? 0;
}

/** A synchronous source selection retains its spent requests if pattern matching throws. */
export function withImagePatternRequests<Answer>(requests: number, answer: () => Answer): Answer {
  try {
    return answer();
  } catch (error) {
    addImagePatternRequests(error, requests);
    throw error;
  }
}
