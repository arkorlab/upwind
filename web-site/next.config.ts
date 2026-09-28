import { createRequire } from 'node:module';

import type { NextConfig } from 'next';

/**
 * The deployment adapter, resolved from this project.
 *
 * `next build` loads the adapter by path, and resolves that path from Next.js's own module rather
 * than from here — so a bare package name would be looked for beside Next.js, where a strict
 * `node_modules` does not have it. Resolving it here names the copy this project installed.
 *
 * `import.meta.url` holds however Next.js reads this file. Read as ES modules it is this file; read
 * the way Next.js reads a `next.config.ts` by default — transpiled to CommonJS by SWC — it becomes
 * `pathToFileURL(__filename)`, and the filename that build compiles under is in this directory. Both
 * resolve from the project, which is the only place that has the adapter. Basing it on the current
 * directory instead would be wrong for a `next build ./some-app` run from anywhere else.
 *
 * `upwind build` sets the same thing in the environment, so a build started that way needs nothing
 * from this file. This line is what makes a plain `next build` — from CI, from a script, from
 * anything that does not know about upwind — produce the same deployment bundle.
 *
 * **Except on Vercel**, which builds this site too, from the same commit. An adapter named in a build
 * takes the deployment over: the build writes a bundle Vercel does not read,
 * and, on Next.js 16.3, stops writing the file traces Vercel's own build does
 * (`next-server.js.nft.json`). `VERCEL` is
 * set on every build Vercel runs, and this is the line that has to notice, because a `next.config`
 * that names an adapter outranks anything the environment says — including the nothing `upwind build`
 * says there.
 */
const vercel = process.env['VERCEL'];
const onVercel = vercel !== undefined && vercel !== '';

const config: NextConfig = {
  ...(onVercel
    ? {}
    : { adapterPath: createRequire(import.meta.url).resolve('@stayingupwind/adapter') }),
  experimental: {
    /*
     * The root layout of this site is `app/[locale]/layout.tsx`, because English is served on the
     * bare path and Japanese under `/ja`. A URL that matches no route therefore has no layout above
     * it to render a 404 inside, and `app/global-not-found.tsx` is that page — a whole document,
     * which this flag is what enables (Next.js, "not-found").
     */
    globalNotFound: true,
  },
};

export default config;
