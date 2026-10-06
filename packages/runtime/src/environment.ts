import { installFetchCacheModes } from './fetch-cache-mode.ts';
import { installFetchCacheWrites } from './fetch-cache-writes.ts';
import { installRandomSafeContext } from './random-safe-context.ts';
import { installResources } from './resources.ts';
import { installTaskScheduler } from './tasks.ts';

/**
 * What the Function's environment must be before any of Next.js is evaluated: the scheduler its
 * prerenders' task boundaries run on (`tasks.ts`), the `fetch` its own will wrap, which takes off
 * a cache mode workerd would throw on (`fetch-cache-mode.ts`), the hook its data cache hands a
 * write to (`fetch-cache-writes.ts`), the symbol the application's storage bindings are read
 * from, which its modules may look at as they are evaluated (`resources.ts`), and the runner
 * Sentry's SDK reads its random values in, which a copy of it resolves at its first read
 * (`random-safe-context.ts`). Imported first by `function.ts`, for its effect alone.
 */

installTaskScheduler();
installFetchCacheModes();
installFetchCacheWrites();
installResources();
installRandomSafeContext();
