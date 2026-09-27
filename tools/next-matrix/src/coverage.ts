/**
 * What a build of each fixture has to show, as data both checkers read.
 *
 * `run.ts` builds the fixtures from this and holds a real build to it. `check-patches.ts` reads the
 * same thing to hold the *declarations* to it: a patch that says it reaches `build-output` is a patch
 * no published package can show, so the only thing that can exercise it is a fixture here — and a
 * patch nobody listed would otherwise be checked by nothing at all. Pull-request CI runs that checker,
 * which is why the cross-check lives there rather than in this tool.
 */

/** The patch names more than one of the lists below spells, kept in one place. */
const FETCH_CACHE_WAIT_UNTIL = 'fetch-cache-wait-until';
const GRAPH_MANIFESTS = 'graph-manifests';
const TURBOPACK_RUNTIME = 'turbopack-runtime';

/** The rewrites that reach Next.js's own package, and so every build of any fixture. */
const PACKAGE_PATCHES = [
  'cache-signal-timers',
  FETCH_CACHE_WAIT_UNTIL,
  GRAPH_MANIFESTS,
  'hanging-input-abort',
  'instrumentation',
  'load-manifest',
  'resume-cache-limit',
  'task-timers',
] as const;

export interface FixtureCoverage {
  /** Every patch a build of this fixture has to apply, in one Function or the other. */
  readonly expected: readonly string[];
  /**
   * Of those, the patches that have to rewrite something this build *wrote*.
   *
   * Which they are is a fact about the fixture and not about the patches: `hanging-input-abort`
   * reaches a chunk in `next-minimal`, where Turbopack copied the module it rewrites into one, and
   * reaches only Next.js's own file in `next-edge`, where it did not. Each list was read off a real
   * build rather than reasoned about.
   */
  readonly chunks: readonly string[];
}

export const FIXTURE_COVERAGE: Readonly<Record<string, FixtureCoverage>> = {
  // Every patch there is: this fixture exists to be the one build that reaches all of them.
  'next-minimal': {
    expected: [
      ...PACKAGE_PATCHES,
      TURBOPACK_RUNTIME,
      'wasm-loader',
      'vercel-og',
      'vercel-og-font',
      'vercel-og-image-response',
    ],
    chunks: [
      FETCH_CACHE_WAIT_UNTIL,
      GRAPH_MANIFESTS,
      'hanging-input-abort',
      TURBOPACK_RUNTIME,
      'vercel-og',
      'wasm-loader',
    ],
  },
  // No `wasm-loader`: WebAssembly on the edge runtime travels as `wasmAssets` under Turbopack's own
  // global and never reaches the Node.js loader that patch rewrites. No `vercel-og` either — nothing
  // here renders an image. And `hanging-input-abort` reaches no chunk: this build put the module it
  // rewrites in none of its own.
  'next-edge': {
    expected: [...PACKAGE_PATCHES, TURBOPACK_RUNTIME],
    chunks: [FETCH_CACHE_WAIT_UNTIL, GRAPH_MANIFESTS, TURBOPACK_RUNTIME],
  },
};
