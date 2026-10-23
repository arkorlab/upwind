// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- consumers need the Workers-native module's narrow declarations without Node's globals.
/// <reference path="../types/node-async-hooks.d.ts" />
// eslint-disable-next-line no-restricted-imports, import-x/no-nodejs-modules -- Workers provides native async context; routing allowances must survive awaits without crossing requests.
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  budgetPatterns,
  createPatternBudget,
  type PatternBudget,
} from '@stayingupwind/core/request';

/** Each incoming request's allowance, kept through awaits and retries of its pointer. */
const budgets = new AsyncLocalStorage<PatternBudget>();

function currentBudget(): PatternBudget | undefined {
  return budgets.getStore();
}

/**
 * Bound all routing tests made for a request together. A nested route, including a retry after a
 * deployment's Worker disappeared, spends the same allowance. Other requests in the isolate have
 * their own, even while this one waits for I/O. Core only reads the allowance through this getter;
 * an application's Function does not install one or pay for the host's async context.
 */
export function withPatternBudget<T>(route: () => T): T {
  budgetPatterns(currentBudget);
  return budgets.getStore() === undefined ? budgets.run(createPatternBudget(), route) : route();
}
