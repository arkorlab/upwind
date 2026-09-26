import { PlatformFetchCache, useCacheHandler } from './handlers.ts';
import { platformRevalidate } from './revalidate.ts';

/**
 * The two globals Next.js reads the platform's hooks from, put in place when this module is
 * evaluated — before any of Next.js. `@next/cache-handlers` names the handlers its data caches
 * run through; a `next.config` naming its own is refused at build, so these are the only ones.
 * The router server methods are what a Pages Router `res.revalidate()` reaches for, keyed by the
 * project directory the runtime names in every request's metadata.
 */

const CACHE_HANDLERS = Symbol.for('@next/cache-handlers');
const ROUTER_SERVER_METHODS = Symbol.for('@next/router-server-methods');
/** `requestMeta.relativeProjectDir`, as `serve.ts` sets it. */
const PROJECT_DIR = '.';

function install(key: symbol, hooks: unknown): void {
  if (__ARKOR_FUNCTION_KIND__ === 'app' && !Reflect.has(globalThis, key)) {
    Reflect.set(globalThis, key, hooks);
  }
}

install(CACHE_HANDLERS, {
  FetchCache: PlatformFetchCache,
  DefaultCache: useCacheHandler('default'),
  RemoteCache: useCacheHandler('remote'),
});
install(ROUTER_SERVER_METHODS, { [PROJECT_DIR]: { revalidate: platformRevalidate } });
