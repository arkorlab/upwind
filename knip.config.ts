import type { KnipConfig } from 'knip';

/**
 * Dead-code detection for every workspace package: CI fails on an unused file or an unused
 * dependency.
 *
 * Unused *exports* are not checked, and cannot be. Everything here is a library, and its readers
 * are a host's own code and the suites that drive it — none of which is in this repository. Knip
 * would report every export that only they use, which is most of them.
 */
const config: KnipConfig = {
  exclude: ['exports', 'types', 'nsExports', 'nsTypes'],
  workspaces: {
    // `playwright` is installed and run inside the Next.js checkout the deploy-tests workflow makes,
    // which is not a dependency of this repository and never will be.
    '.': {
      ignoreBinaries: ['playwright'],
      // CI invokes the pinned official native fixture control directly.
      entry: ['tools/native-addon-next-ci.mts'],
    },
    // Native host templates are bundled by path; their Function import is generated per build.
    'packages/adapter': {
      entry: ['src/native/server.ts'],
      ignoreDependencies: ['arkor'],
    },
    // Three entry points, and `exports` names the `dist` they are built into — the same arrangement
    // as the SDK below, and named here for the same reason.
    'packages/auth': { entry: ['src/{index,next,client}.ts'] },
    'packages/core': {},
    'packages/host': {},
    'packages/deploy': {},
    // `cloudflare:workers` and `cloudflare:test` are the Workers runtime's own, not npm packages.
    'packages/cache': {
      // The native file-safety regression creates a FIFO with the host's own utility.
      ignoreBinaries: ['mkfifo'],
      ignoreDependencies: ['cloudflare'],
    },
    'packages/edge': { ignoreDependencies: ['cloudflare', 'arkor'] },
    // A local stack's Workers are bundled by path (`bundleWorker`), so nothing imports them; `cloudflare:*`
    // is the Workers runtime's own.
    'packages/local': {
      entry: ['src/workers/{agent,edge,outbound}.ts'],
      ignoreDependencies: ['cloudflare'],
    },
    // `templates/` is what this package copies, not what it runs: files nothing imports, on purpose.
    'packages/create-upwind': { ignore: ['templates/**'] },
    // `arkor:*` are the modules the adapter generates beside the runtime and resolves for it;
    // `cloudflare:*` are the Workers runtime's own. Neither is an npm package.
    'packages/runtime': {
      // The native compiler selects these through build-time aliases rather than source imports.
      entry: ['src/native/{function,environment,cache-host}.ts'],
      ignoreDependencies: ['cloudflare', 'arkor'],
    },
    // Seven entry points, and `exports` names the `dist` they are built into — so the sources behind
    // them are named here rather than looked for through files this has not built.
    'packages/sdk': {
      entry: [
        'src/{index,db,kv,blob,durable-object,ai,service}.ts',
        'scripts/check-ai-types.ts',
        'test/consumer-types/service.ts',
      ],
    },
    // Reached by path rather than by import: it is the module `upwind build` tells the processes
    // below it to `--import`, so nothing in this repository imports it and `bin` does not lead there.
    'packages/upwind': {
      // The Workers a deploy ships are bundled by path, so each is an entry of its own.
      entry: ['src/resources/entry.ts', 'src/deploy/workers/{agent,edge}.ts'],
      // Imported by `@stayingupwind/local`, which the command's `dist` bundles, and kept out of that
      // bundle for the Public Suffix List it carries: the command installs it instead.
      ignoreDependencies: ['tldts'],
    },
    'tools/benchmark': { entry: ['src/main.ts', 'src/publish.ts'] },
    // The readers, and the server a local target serves a fixture with, are started as child
    // processes by path, so nothing here imports them.
    'tools/deploy-tests': {
      entry: [
        'src/read-env.ts',
        'src/read-suite-env.ts',
        'src/install-npm.ts',
        'src/serve-cloudflare.ts',
      ],
      // Local release-verification fixtures use the host's GnuPG installation.
      ignoreBinaries: ['gpg', 'gpgconf'],
    },
    // The lifetime control is run directly by CI, beside the Next.js matrix runner.
    'tools/next-matrix': { entry: ['src/node-handler-lifetime.ts'] },
    // The file-safety regression creates a FIFO with the host's own utility.
    'tools/vocabulary': { ignoreBinaries: ['mkfifo'] },
  },
  // Applications the matrix builds with a Next.js of their own, not code of this repository's — and
  // the site, which is an application too: its own project, its own lockfile, and its own install of
  // the published packages, none of which this workspace's dependency graph knows anything about.
  ignore: [
    'fixtures/**',
    'web-site/**',
    // Pinned public compiler inputs are copied into an isolated CI project with its own install.
    'tools/native-pages-handler-profile/fixture/**',
  ],
};

export default config;
