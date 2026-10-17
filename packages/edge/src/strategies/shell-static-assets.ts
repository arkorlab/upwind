import { staticAssetShellPath } from '@stayingupwind/core/artifact';
import type { ShellDeliveryStrategy } from '@stayingupwind/host/delivery';

import type { EdgeContext } from './context.ts';

const ASSETS_ORIGIN = 'https://assets.local';
const OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;

/**
 * An edge with no Static Assets binding (`EdgeBindings.ASSETS`, which says why it is usually
 * absent) has nowhere to read from for a policy naming this backend: an infrastructure fact, which
 * the loader folds into `unavailable` and the document handler answers through the application's
 * Worker.
 */
class NoStaticAssetsError extends Error {
  constructor() {
    super('the edge declares no Static Assets binding for the static-assets shell backend');
    this.name = 'NoStaticAssetsError';
  }
}

/** Shells uploaded as Workers Static Assets under `/__arkor/shell/<sha256>`. */
export const staticAssetsShellStrategy: ShellDeliveryStrategy<EdgeContext, 'static-assets'> = {
  id: 'static-assets',
  async getShell(ref, ctx) {
    const assets = ctx.env.ASSETS;
    if (assets === undefined) {
      throw new NoStaticAssetsError();
    }
    const startedAt = ctx.runtime.now();
    const response = await assets.fetch(
      new Request(`${ASSETS_ORIGIN}${staticAssetShellPath(ref.sha256)}`),
    );
    // Only a 404 says the shell is not there. Any other answer is the binding failing to read it, an
    // infrastructure fact the loader folds into `unavailable`, as it does a binding that is absent.
    if (response.status !== OK_STATUS) {
      await response.body?.cancel();
      if (response.status === NOT_FOUND_STATUS) {
        return;
      }
      throw new Error(`Static Assets answered ${String(response.status)} for a shell`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, source: 'static-assets', latencyMs: ctx.runtime.now() - startedAt };
  },
};
