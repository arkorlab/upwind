/**
 * What a build of each fixture has to show, as data both checkers read.
 *
 * `run.ts` builds the fixtures from this and holds a real build to it. `check-patches.ts` reads the
 * same thing to hold the *declarations* to it: a patch that says it reaches `build-output` is a patch
 * no published package can show, so the only thing that can exercise it is a fixture here — and a
 * patch nobody listed would otherwise be checked by nothing at all. Pull-request CI runs that checker,
 * which is why the cross-check lives there rather than in this tool.
 *
 * The names below are the fixtures. `run.ts` builds one for each of them rather than keeping a list of
 * its own, because the two lists drifting apart would drift the wrong way quietly: a name here that
 * nothing built would leave a `build-output` patch reading as exercised by a build that never ran.
 */

/** The patch names more than one of the lists below spells, kept in one place. */
const FETCH_CACHE_WAIT_UNTIL = 'fetch-cache-wait-until';
const GRAPH_MANIFESTS = 'graph-manifests';
const TURBOPACK_RUNTIME = 'turbopack-runtime';
/** The same runtime chunk's roots, rewritten wherever the runtime is (`patches/turbopack-root.ts`). */
const TURBOPACK_ROOT = 'turbopack-root';
/** The Workflow SDK's QuickJS engine, its WebAssembly shipped compiled (`patches/workflow-quickjs.ts`). */
const WORKFLOW_QUICKJS = 'workflow-quickjs-wasm';
/**
 * The Turbopack WebAssembly loader, in the two shapes the range holds it: a module of its own from
 * 16.3, and the Turbopack runtime itself in 16.2 (`patches/wasm-loader.ts`).
 */
const WASM_LOADER = ['wasm-loader', 'runtime-wasm-loader'] as const;

/** The rewrites that reach Next.js's own package, and so every build of any fixture. */
const PACKAGE_PATCHES = [
  'cache-signal-timers',
  'fast-immediates',
  FETCH_CACHE_WAIT_UNTIL,
  GRAPH_MANIFESTS,
  'hanging-input-abort',
  'instrumentation',
  'load-manifest',
  'resume-cache-limit',
  'task-timers',
] as const;

/**
 * A patch a build has to apply, or — where Next.js has shipped one thing in two shapes across the
 * supported range — the patches of which exactly one must fire. The Turbopack WebAssembly loader is
 * the case in point: a module of its own from 16.3, the Turbopack runtime itself in 16.2, and which
 * of the two a build reaches is the version's business rather than the fixture's. Naming both is
 * what lets one coverage record hold for the whole range; requiring exactly one is what keeps it
 * from quietly passing when a marker starts claiming what is not its shape.
 */
export type Expected = string | readonly string[];

export interface FixtureCoverage {
  /** Every patch a build of this fixture has to apply, in one Function or the other. */
  readonly expected: readonly Expected[];
  /**
   * Of those, the patches that have to rewrite something this build *wrote*.
   *
   * Which they are is a fact about the fixture and not about the patches: `hanging-input-abort`
   * reaches a chunk in `next-minimal`, where Turbopack copied the module it rewrites into one, and
   * reaches only Next.js's own file in `next-edge`, where it did not. Each list was read off a real
   * build rather than reasoned about.
   */
  readonly chunks: readonly Expected[];
}

/** Every patch a coverage entry names, groups flattened. */
export function namesIn(expected: readonly Expected[]): string[] {
  return expected.flatMap((one) => (typeof one === 'string' ? [one] : [...one]));
}

export const FIXTURE_COVERAGE = {
  // Every patch an application reaches without the Workflow SDK: this fixture exists to be the one
  // build that reaches all of them. The SDK's own patch is `next-workflow`'s, below.
  'next-minimal': {
    expected: [
      ...PACKAGE_PATCHES,
      TURBOPACK_RUNTIME,
      TURBOPACK_ROOT,
      WASM_LOADER,
      'vercel-og',
      'vercel-og-font',
      'vercel-og-image-response',
    ],
    chunks: [
      FETCH_CACHE_WAIT_UNTIL,
      GRAPH_MANIFESTS,
      'hanging-input-abort',
      TURBOPACK_RUNTIME,
      TURBOPACK_ROOT,
      'vercel-og',
      WASM_LOADER,
    ],
  },
  // No WebAssembly loader: on the edge runtime it travels as `wasmAssets` under Turbopack's own
  // global and never reaches the Node.js loader either shape of that patch rewrites. No `vercel-og` either — nothing
  // here renders an image. And `hanging-input-abort` reaches no chunk: this build put the module it
  // rewrites in none of its own.
  'next-edge': {
    expected: [...PACKAGE_PATCHES, TURBOPACK_RUNTIME, TURBOPACK_ROOT],
    chunks: [FETCH_CACHE_WAIT_UNTIL, GRAPH_MANIFESTS, TURBOPACK_RUNTIME, TURBOPACK_ROOT],
  },
  // The Workflow SDK, whose engine embeds its WebAssembly in a chunk of the flow route's: the one
  // patch here that `next-minimal` cannot reach, and it fires in the workflow Function alone.
  'next-workflow': {
    expected: [...PACKAGE_PATCHES, TURBOPACK_RUNTIME, TURBOPACK_ROOT, WORKFLOW_QUICKJS],
    chunks: [
      FETCH_CACHE_WAIT_UNTIL,
      GRAPH_MANIFESTS,
      TURBOPACK_RUNTIME,
      TURBOPACK_ROOT,
      WORKFLOW_QUICKJS,
    ],
  },
} as const satisfies Readonly<Record<string, FixtureCoverage>>;

/**
 * The fixtures there are, as a type: what `run.ts` has to say `holds` for, and nothing else. `satisfies`
 * above is what keeps both — the shape is checked as an annotation would check it, and the names stay the
 * literals they are written as, so one added here without a `holds` is a type error rather than a fixture
 * that builds nothing.
 */
export type FixtureName = keyof typeof FIXTURE_COVERAGE;
