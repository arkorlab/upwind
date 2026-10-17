import type { CacheBindings } from '../src/bindings.ts';
import type * as worker from '../src/standalone/worker.ts';

declare global {
  namespace Cloudflare {
    /** What the suites' Miniflare binds (`vitest.config.mts`): a standalone cache's environment. */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation is an interface, named as the one it merges into
    interface Env extends CacheBindings {}
    /** The standalone cache's exports, as `exports` from `cloudflare:workers` reaches them. */
    interface GlobalProps {
      mainModule: typeof worker;
    }
  }
}
