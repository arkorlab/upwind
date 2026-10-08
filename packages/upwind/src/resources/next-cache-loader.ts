import { registerHooks } from 'node:module';

import { isResourceCacheBridgeSource, resourceCacheBridge } from '@stayingupwind/core/next';
import { installNextCacheRegistry } from '@stayingupwind/core/paas';

let installed = false;

/** Same-realm hooks cover native require of Turbopack chunks as well as Next's source modules. */
export function installNextResourceCacheLoader(): void {
  if (installed) return;
  installed = true;
  installNextCacheRegistry();
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (
        !url.startsWith('file:') ||
        !url.endsWith('.js') ||
        result.source === null ||
        result.source === undefined
      )
        return result;
      const source =
        typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source);
      if (!isResourceCacheBridgeSource(source)) return result;
      return { ...result, source: resourceCacheBridge(source).contents };
    },
  });
}
