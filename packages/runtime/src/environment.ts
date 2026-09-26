// Named here for its evaluation alone: the module takes the header methods the platform's own
// trust boundary uses before the application can replace them (`settledForHost`).
import '@stayingupwind/core/request';
import { installFetchCacheModes } from './fetch-cache-mode.ts';
import { installFetchCacheWrites } from './fetch-cache-writes.ts';
import { installResources } from './resources.ts';
import { installTaskScheduler } from './tasks.ts';

/**
 * What the Function's environment must be before any of Next.js is evaluated: the scheduler its
 * prerenders' task boundaries run on (`tasks.ts`), the `fetch` its own will wrap, which takes off
 * a cache mode workerd would throw on (`fetch-cache-mode.ts`), the hook its data cache hands a
 * write to (`fetch-cache-writes.ts`), and the symbol the application's storage bindings are read
 * from, which its modules may look at as they are evaluated (`resources.ts`). Imported first by
 * `function.ts`, for its effect alone.
 */

installTaskScheduler();
installFetchCacheModes();
installFetchCacheWrites();
installResources();
