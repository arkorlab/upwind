// eslint-disable-next-line n/no-unsupported-features/node-builtins -- synchronous same-realm hooks are available since Node 22.15; this CLI requires Node 24
import { registerHooks } from 'node:module';

import { isResourceCacheBridgeSource, resourceCacheBridge } from '@stayingupwind/core/next';
import { installNextCacheRegistry } from '@stayingupwind/core/paas';

const state = { installed: false };

/** Same-realm hooks cover native require of Turbopack chunks as well as Next's source modules. */
export function installNextResourceCacheLoader(): void {
  if (state.installed) return;
  state.installed = true;
  installNextCacheRegistry();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith('file:') || !url.endsWith('.js') || result.source === undefined)
        return result;
      const source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      if (!isResourceCacheBridgeSource(source)) return result;
      try {
        return { ...result, source: resourceCacheBridge(source).contents };
      } catch (error) {
        throw new Error(
          `upwind: failed to bridge Next cache module ${url}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    },
  });
}
