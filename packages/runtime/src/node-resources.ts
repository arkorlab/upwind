import { AsyncLocalStorage } from 'node:async_hooks';

import {
  installNextCacheRegistry,
  installResourcePrimaryReadStorage,
  RESOURCES_SYMBOL_KEY,
  resourcesOf,
} from '@stayingupwind/core/paas';

import { nodeFunctionEnv } from './node-bindings.ts';

/** The same published service capabilities as a Worker, without importing Worker bindings. */
export function installResources(): void {
  installNextCacheRegistry();
  installResourcePrimaryReadStorage(new AsyncLocalStorage<true>());
  const key = Symbol.for(RESOURCES_SYMBOL_KEY);
  if (Object.hasOwn(globalThis, key)) return;
  const resources = resourcesOf(nodeFunctionEnv());
  Object.defineProperty(globalThis, key, {
    configurable: false,
    enumerable: false,
    value: resources,
    writable: false,
  });
}
