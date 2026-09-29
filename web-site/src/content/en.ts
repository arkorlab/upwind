import type { Copy } from './copy.ts';

/**
 * The site in English, served on the bare path.
 *
 * Claims only what the packages do: every sentence here is one a reader can check against the
 * readmes this page links to, and none of it describes a host's control plane, a price or a roadmap.
 *
 * Backticks are inline code. `components/prose.tsx` is what turns them into `<code>`, so a name
 * written between them is set in the mono face in both languages and in neither's markup.
 */
export const en = {
  meta: {
    title: 'upwind — a Next.js deployment adapter',
    description:
      'upwind runs inside next build and writes a deployment bundle: every route, prerender and static file by content, and the Functions that serve them. For Next.js 16.3 and every 16 after it.',
    siteName: 'upwind',
    ogImageAlt: 'upwind — a Next.js deployment adapter and the runtime that serves what it builds',
  },
  nav: {
    skipToContent: 'Skip to content',
    repository: 'GitHub',
    npm: 'npm',
  },
  hero: {
    tagline: 'A Next.js deployment adapter, and the runtime that serves what it builds.',
    body: 'The adapter runs inside your own `next build` and writes a deployment bundle — every route, prerender and static file by content, and the Functions that run the application’s code. The build talks to nothing and needs no credentials: what comes out is a directory, and uploading it is the host’s half of the arrangement.',
    commandCaption: 'Start an application',
    commandNote:
      'Writes a Next.js 16 application with Tailwind 4, wired to upwind, and installs it.',
    primary: 'Read it on GitHub',
    secondary: 'Packages on npm',
  },
  bundle: {
    title: 'What a build writes',
    body: 'Next.js calls the adapter through its own Adapter API — `modifyConfig` before the build, `onBuildComplete` after it — and everything a deployment needs is written under one directory, `.arkor/`.',
    items: [
      {
        term: '`bundle.json`',
        description:
          'Entrypoints, prerenders, routing tables, header rules, cache-life profiles: what to serve, and what may be served out of storage rather than by a Function.',
      },
      {
        term: 'Blobs, by content',
        description:
          'Every prerendered shell and static file addressed by the hash of what is in it, so a deployment that changed one page ships one blob.',
      },
      {
        term: 'The `app` Function',
        description:
          'The application’s own code, bundled for workerd with `nodejs_compat`: its pages, its route handlers, its cache.',
      },
      {
        term: 'The `middleware` Function',
        description:
          'The project’s `proxy.ts`, built on its own, so a request that only needs a rewrite never wakes the application.',
      },
    ],
    note: 'Nothing in the adapter talks to Cloudflare, and no build needs an account to produce a bundle.',
  },
  dev: {
    title: 'Development, with the front door in place',
    body: 'A deployment has an edge in front of it, and the platform’s own paths are the edge’s to answer. Under `next dev` there is no edge. `upwind dev` is that front door locally: it holds the port, answers its own paths, and hands every other request to the project’s own Next.js — the same dev bundler, the same HMR, the same error overlay.',
    endpoints: [
      {
        term: '`/__upwind`',
        description:
          'What this run is: the versions, the address, the project directory, the adapter it named.',
      },
      {
        term: '`/__upwind/health`',
        description: '`200` once Next.js is ready, `503` while it is starting.',
      },
    ],
    note: 'Both are answered by the front door rather than by the application, which is why they answer while the application is still compiling — and while a compile of it is failing.',
  },
  serves: {
    title: 'What it serves',
    body: 'One bundle per build, whatever the application turned out to be made of.',
    items: [
      {
        term: 'App Router',
        description:
          'Server Components and streaming, with a prerendered shell served from storage and resumed by the Function.',
      },
      {
        term: 'Pages Router',
        description:
          'Including the `_next/data` outputs the client router asks for by name, under the build id.',
      },
      {
        term: 'Images',
        description:
          '`/_next/image`, optimized at the edge, in the formats and sizes the application configured.',
      },
      {
        term: '`proxy.ts`',
        description:
          'A project’s proxy becomes a Function of its own, run before a request reaches the application.',
      },
      {
        term: 'Scheduled work',
        description:
          'Cron jobs declared beside `next.config`, checked at build time and carried into the bundle.',
      },
      {
        term: 'Static export',
        description:
          '`output: export` writes the same bundle with the server parts empty, every document served from storage.',
      },
      {
        term: 'WebAssembly',
        description: 'A compiled module travels with the Function whose code reads it.',
      },
      {
        term: '`next/og`',
        description:
          'Open Graph images, drawn by the build where a route is static and by the Function where it is not — including the card this page shares.',
      },
    ],
    rangeLabel: 'Next.js',
    rangeNote:
      'The range the adapter’s rewrites of Next.js’s own output are held to, on every release in it and against the canary.',
  },
  packages: {
    title: 'One release, one generation',
    body: 'Every package here is versioned with the others and published from one signed tag — so what scaffolds a project and what runs it are always of the same generation.',
    summaries: {
      upwind:
        'The CLI. `upwind dev` runs the project’s Next.js behind upwind’s front door; `upwind build` is the project’s own `next build` with the adapter named.',
      adapter:
        'Runs inside `next build`, writes the bundle, and builds the Functions that serve what it wrote.',
      runtime:
        'What a deployment’s Function is: the routing tables, the middleware, the prerenders and the cache, written for workerd.',
      core: 'The vocabulary the others speak — the bundle’s shape, the cache’s terms, and the protocol between an edge and a Function.',
      sdk: 'An application’s own D1, KV and R2, read the same way locally and in a deployment, with nothing to configure.',
      create: '`pnpm create upwind`, and the application it writes.',
    },
    npmLabel: 'npm',
    readmeLabel: 'Readme',
  },
  status: {
    title: 'Before 1.0',
    body: 'Early software, and it says so rather than letting you find out.',
    points: [
      'The deployment bundle carries a version of its own, and its shape is expected to change before it settles.',
      'No release carries a compatibility shim for the minor before it.',
      'A build nobody here has seen is the most useful thing you can send: what your application does that this does not serve yet.',
    ],
    licence: { label: 'Licence', conjunction: 'or', note: ', at the recipient’s option' },
    contributing: 'How to contribute',
    issues: 'Report a bug',
  },
  footer: {
    builtWith: 'This site is a Next.js application, built by `upwind build` and hosted on Arkor.',
    repository: 'GitHub',
    npm: 'npm',
    licence: 'Licence',
  },
  notFound: {
    title: 'Not here',
    body: 'There is no page at that address.',
    home: 'Back to the front page',
  },
} satisfies Copy;
