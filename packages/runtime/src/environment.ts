import { installFetchCacheModes } from './fetch-cache-mode.ts';
import { installResources } from './resources.ts';
import { installTaskScheduler } from './tasks.ts';

/**
 * What the Worker's environment must be before any of Next.js is evaluated: the scheduler its
 * prerenders' task boundaries run on (`tasks.ts`), the `fetch` its own will wrap, which takes off
 * a cache mode workerd would throw on (`fetch-cache-mode.ts`), and the symbol the application's
 * storage bindings are read from, which its modules may look at as they are evaluated
 * (`resources.ts`). Imported first by `worker.ts`, for its effect alone.
 */

installTaskScheduler();
installFetchCacheModes();
installResources();
