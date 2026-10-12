import { kvArtifactKey } from '@stayingupwind/core/artifact';
import type { ShellDeliveryStrategy } from '@stayingupwind/host/delivery';

import type { EdgeContext } from './context.ts';

/**
 * How long KV may hold a shell lookup in this colo.
 *
 * The bytes are immutable per content hash, so a long life would be safe for a hit — but KV caches
 * a miss under the same TTL, and the shells, the manifest and the pointer are separate keys whose
 * propagation order is not guaranteed. A colo that sees the manifest first would read `null`, cache
 * that, and delegate the document to the origin for the whole TTL. Long-lived caching of a *found*
 * shell is the Cache API layer's job (`shell-loader.ts`), which never caches a miss; KV's minimum
 * of 30 is all that is wanted here.
 */
const SHELL_KV_CACHE_TTL_SECONDS = 30;

export const kvShellStrategy: ShellDeliveryStrategy<EdgeContext> = {
  id: 'kv',
  async getShell(ref, ctx) {
    const startedAt = ctx.runtime.now();
    const buffer = await ctx.env.EDGE_STATE.get(kvArtifactKey(ref.sha256), {
      type: 'arrayBuffer',
      cacheTtl: SHELL_KV_CACHE_TTL_SECONDS,
    });
    if (buffer === null) {
      return;
    }
    return {
      bytes: new Uint8Array(buffer),
      source: 'kv',
      latencyMs: ctx.runtime.now() - startedAt,
    };
  },
};
