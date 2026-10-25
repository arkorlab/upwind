import { AsyncLocalStorage } from 'node:async_hooks';

import {
  installNextCacheRegistry,
  installResourcePrimaryReadStorage,
} from '@stayingupwind/core/paas';

import { installFetchCacheWrites } from '../fetch-cache-writes.ts';
import { installHeadersIterator } from '../headers-iterator.ts';
import { installRandomSafeContext } from '../random-safe-context.ts';

// Native Node already provides task boundaries and fetch cache modes. Install only the shared
// hooks Next.js and application libraries read, before any lazy application entry is evaluated.
// Turbopack's native output uses the global supplied by Next.js's own server bootstrap.
if (!Reflect.has(globalThis, 'AsyncLocalStorage'))
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
installHeadersIterator();
installFetchCacheWrites();
installNextCacheRegistry();
installResourcePrimaryReadStorage(new AsyncLocalStorage<true>());
installRandomSafeContext();
