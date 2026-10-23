import type { StandaloneEnv } from '../src/standalone/env.ts';

declare global {
  namespace Cloudflare {
    /** What the suites' Miniflare binds (`vitest.config.mts`): a standalone edge's environment. */
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- an augmentation is an interface, named as the one it merges into
    interface Env extends StandaloneEnv {}
  }
}
