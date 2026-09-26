import { createRequire } from 'node:module';

import type { NextConfig } from 'next';

/**
 * The deployment adapter, resolved from this project.
 *
 * `next build` loads the adapter by path, and resolves that path from Next.js's own module rather
 * than from here — so a bare package name would be looked for beside Next.js, where a strict
 * `node_modules` does not have it. Resolving it here names the copy this project installed.
 *
 * `upwind build` sets the same thing in the environment, so a build started that way needs nothing
 * from this file. This line is what makes a plain `next build` — from CI, from a script, from
 * anything that does not know about upwind — produce the same deployment bundle.
 */
const config: NextConfig = {
  adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter'),
};

export default config;
