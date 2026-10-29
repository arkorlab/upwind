import { writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { type InputOptions, type OutputChunk, rolldown } from 'rolldown';

import { buildPaths, type BuildPaths } from './build-paths.ts';
import { jsLiteral } from './codegen.ts';
import { constExportSettersPlugin } from './const-export-setters.ts';
import { bundled, type BundleTrace } from './dependencies.ts';
import { dynamicLoadsInChunk } from './dynamic-loads.ts';
import type { EdgeInstrumentation } from './edge-instrumentation.ts';
import { edgeProcessPlugin } from './edge-process.ts';
import type { KeptMaps } from './kept-maps.ts';
import { externalsPlugin, FUNCTION_BANNER } from './patches/index.ts';
import { sourceMapsPlugin, sourcemapOutput } from './source-maps.ts';
import { GLOBAL_OBJECT, globalObjectPlugin, THROWING_GLOBALS } from './throwing-globals.ts';

/**
 * The Function's second bundle: the entrypoints `next build` put on Next.js's deprecated edge
 * runtime.
 *
 * Such an entrypoint is not a module the Function can require. Turbopack builds it into chunks that
 * register a Web handler in the global edge entry registry as they are evaluated, and Next.js
 * names the registration in `output.edgeRuntime` — `modulePath`, `entryKey`, `handlerExport` —
 * which is the documented way to reach one (Adapters, "Invoking Entrypoints"). The chunk loader
 * in those chunks reads no files at run time (`loadChunkCached` throws), so evaluating every
 * chunk of an entry is the whole of loading it, and nothing here needs the chunk-table rewrite
 * the Node.js build needs.
 *
 * It is a bundle of its own, and not part of `app.cjs`, because the two are compiled for
 * different runtimes: `app.cjs` is built with `process.env.NEXT_RUNTIME` pinned to `"nodejs"`,
 * which is exactly the test the edge code branches on.
 *
 * Like `app.cjs`, it is a table of thunks: the module the Function loads at startup is the table,
 * and an entry's chunks are evaluated by the first request that needs them. A deployment with no
 * edge entrypoint has no such module at all.
 */

export interface EdgeEntry {
  /** Key the runtime asks for: the route's pathname, or `/_middleware`. */
  readonly id: string;
  /** Name the entry registers itself under in `globalThis._ENTRIES`. */
  readonly entryKey: string;
  /** Export of the registered entry to invoke (`handler`). */
  readonly handlerExport: string;
  /** Absolute paths of the chunks to evaluate, in the order Next.js lists them. */
  readonly files: readonly string[];
  /**
   * The WebAssembly those chunks read, by the global they read it from. Nothing here loads it:
   * the Function publishes each global before a request reaches a thunk (see `wasm.ts`), which is
   * the contract Turbopack's edge loader was compiled against.
   */
  readonly wasm: readonly { global: string; filePath: string }[];
  /**
   * The files the chunks fetch as `blob:<name>` — the font an image is drawn with, fetched from
   * `new URL('./font.ttf', import.meta.url)` — by the name Next.js gave each and its path.
   */
  readonly inlineAssets: readonly { name: string; filePath: string }[];
  /** Build-time environment the entry is compiled against (`__NEXT_BUILD_ID`, preview mode ids). */
  readonly env: Readonly<Record<string, string>>;
}

export const EDGE_MODULE = 'edge.cjs';
/**
 * What the generated module does before anything else, for the files its entries fetch as
 * `blob:<name>` (`EdgeEntry.inlineAssets`): Next.js's own edge runtime answers such a fetch from
 * the files the function carries (`fetchInlineAsset`, in `server/web/sandbox`), and workerd has
 * no such URL to fetch. Here each file travels as a module of the Function's (`inlineAssetFiles`)
 * and the fetch is answered with it; any other `fetch` goes on as it came. An image drawn with a
 * font of its own on the edge runtime failed without it (`app-dir/metadata-font`). A deployment
 * whose entries fetch no such file gets none of this.
 */
function inlineAssetsSource(entries: readonly EdgeEntry[], paths: BuildPaths): string[] {
  const files = new Map<string, string>();
  for (const entry of entries) {
    for (const asset of entry.inlineAssets) {
      const file = paths.runtimePath(asset.filePath);
      if (file !== undefined && !files.has(asset.name)) {
        files.set(asset.name, file);
      }
    }
  }
  if (files.size === 0) {
    return [];
  }
  return [
    `const inlineAssets = new Map(${jsLiteral([...files])});`,
    'const fetchBeneath = globalThis.fetch;',
    'globalThis.fetch = function fetch(input, init) {',
    '  const url =',
    "    typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;",
    "  const file = url?.startsWith('blob:') ? inlineAssets.get(url.slice(5)) : undefined;",
    '  return file === undefined',
    '    ? fetchBeneath(input, init)',
    // A file that cannot be read rejects, as a fetch that fails does, rather than throwing.
    "    : new Promise((resolve) => resolve(new Response(require('node:fs').readFileSync(file))));",
    '};',
  ];
}

/**
 * The generated entry: one thunk per entrypoint, each evaluating its chunks and handing back the
 * handler the registry then holds.
 *
 * The environment is applied first and over what the Function already has, as Next.js's own edge
 * runtime applies it: these are constants of the build the chunks were compiled against (the
 * build id, the preview mode ids, the key Server Actions are encrypted with), and a Function
 * binding of the same name from another build would not match the code.
 *
 * The configuration the chunks publish (`__SERVER_FILES_MANIFEST`) is made to trust the `Host` a
 * request carries, as `next build` writes it for a platform it supports (`hasNextSupport`, in
 * `build/index.ts`) and not for one it does not know: the edge hands the Function the host the
 * client asked. An entrypoint on the edge runtime reads its own URL off that alone (`prepare`,
 * in `route-module.ts`) and named `localhost` without it, so a Server Action that redirected
 * fetched the page it redirects to from there and failed
 * (`server-actions-redirect-middleware-rewrite`, "in edge runtime").
 */
export function edgeEntrySource(
  entries: readonly EdgeEntry[],
  projectDir: string,
  distDir: string,
  instrumentation?: EdgeInstrumentation,
): string {
  const table = entries.map((entry) => {
    const env = jsLiteral(entry.env);
    return [
      `    ${jsLiteral(entry.id)}: () => {`,
      ...(Object.keys(entry.env).length === 0 ? [] : [`      Object.assign(process.env, ${env});`]),
      ...(instrumentation === undefined ? [] : ['      prepareInstrumentation();']),
      ...entry.files.map((file) => `      require(${jsLiteral(file)});`),
      '      trustingHost();',
      `      return registered(${jsLiteral(entry.entryKey)}, ${jsLiteral(entry.handlerExport)});`,
      '    },',
    ].join('\n');
  });
  return [
    '// Generated by @stayingupwind/adapter: the entrypoints `next build` built for the edge runtime.',
    ...inlineAssetsSource(entries, buildPaths(projectDir, distDir)),
    ...(instrumentation === undefined ? [] : instrumentationLoader(instrumentation)),
    'function trustingHost() {',
    '  const experimental = globalThis.__SERVER_FILES_MANIFEST?.config?.experimental;',
    '  if (experimental !== undefined) {',
    '    experimental.trustHostHeader = true;',
    '  }',
    '}',
    'function registered(key, handlerExport) {',
    '  const entry = globalThis._ENTRIES?.[key];',
    '  if (entry === undefined) {',
    "    throw new Error('@stayingupwind/adapter: ' + key + ' registered no edge entry');",
    '  }',
    '  return { handler: entry[handlerExport] };',
    '}',
    'module.exports = {',
    '  entries: {',
    ...table,
    '  },',
    '};',
    '',
  ].join('\n');
}

/** The first Edge entry loads the composed hook; every other entry shares that exact module. */
function instrumentationLoader(input: EdgeInstrumentation): string[] {
  return [
    'let instrumentation;',
    'function prepareInstrumentation() {',
    '  if (instrumentation !== undefined) {',
    '    if (instrumentation.failed) throw instrumentation.failure;',
    '    return;',
    '  }',
    `  const install = require(${jsLiteral(input.module)});`,
    '  const setup = install(globalThis._ENTRIES ||= {});',
    '  instrumentation = { failed: false };',
    '  try {',
    ...input.files.map((file) => `    require(${jsLiteral(file)});`),
    '    setup.finish();',
    '  } catch (error) {',
    '    instrumentation.failed = true;',
    '    instrumentation.failure = error;',
    '    setup.fail(error);',
    '    throw error;',
    '  }',
    '}',
  ];
}

/**
 * How the edge bundle is built. The Turbopack output it carries is self-contained — every
 * dependency is already inlined for the edge target — so the only plugin is the one that reports
 * what is left to the Function's own resolver, for the audit to refuse. Whatever Rolldown cannot
 * resolve is reported the same way, as in `appBundleOptions`.
 */
export function edgeBundleOptions(
  projectDir: string,
  entryFile: string,
  onExternal: (specifier: string) => void,
  /** Compose the maps the build wrote into this bundle's; `kept`, the ones a hook took away. */
  settings: {
    readonly sourceMaps?: { readonly kept?: KeptMaps | undefined } | undefined;
    readonly hostInstrumentation?: boolean;
    /** The files Next.js built for the edge runtime, which read its `process` (`edge-process.ts`). */
    readonly chunks?: readonly string[];
  } = {},
): InputOptions {
  return {
    cwd: projectDir,
    input: entryFile,
    // Node platform adds its own export condition even when conditionNames is explicit. Keep
    // legacy builds as they were; newly added Edge hosts must not select a Node export first.
    platform: settings.hostInstrumentation === true ? 'neutral' : 'node',
    ...(settings.hostInstrumentation === true && {
      resolve: {
        conditionNames: ['edge-light', 'workerd', 'worker', 'default'],
        mainFields: ['main', 'module'],
      },
      // Neutral platform does not externalize built-ins itself. Preserve both spellings and
      // their audit records, leaving resolution to the Function rather than bundling a shim.
      external(specifier: string) {
        if (!isBuiltin(specifier)) return false;
        onExternal(specifier);
        return true;
      },
    }),
    plugins: [
      globalObjectPlugin(),
      externalsPlugin(onExternal),
      // No patch reaches this bundle, so there is nothing for the map to be wrong about; see
      // `sourceMapsPlugin` for why order matters where one does.
      ...(settings.sourceMaps === undefined ? [] : [sourceMapsPlugin(settings.sourceMaps.kept)]),
      // Turbopack writes an edge entry's chunks as it writes the app's (`const-export-setters.ts`).
      constExportSettersPlugin(),
      // Last: it reprints a chunk it rewrites, which the plugins above match by the text they find.
      edgeProcessPlugin(settings.chunks ?? []),
    ],
    transform: {
      inject: GLOBAL_OBJECT,
      define: {
        ...THROWING_GLOBALS,
        'process.env.NEXT_RUNTIME': '"edge"',
        'process.env.NODE_ENV': '"production"',
      },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined) {
        onExternal(log.exporter);
      }
    },
  };
}

export interface BundleEdgeInput {
  readonly kind: string;
  readonly projectDir: string;
  readonly distDir: string;
  readonly workDir: string;
  readonly entries: readonly EdgeEntry[];
  readonly instrumentation?: EdgeInstrumentation | undefined;
  /** Compose the maps the build already wrote through into this bundle's own. */
  readonly sourceMaps?: boolean | undefined;
  /** Where to find a chunk's map that a hook took away (`kept-maps.ts`). */
  readonly keptMaps?: KeptMaps | undefined;
}

interface EdgeHostOutput {
  readonly type: 'chunk' | 'asset';
  readonly fileName: string;
  readonly sourcemapFileName?: string | null;
  readonly map?: unknown;
}

/** Host imports must fit the one JavaScript module the Function carries, plus its requested map. */
export function assertEdgeHostOutput(output: readonly EdgeHostOutput[], sourceMaps: boolean): void {
  const chunks = output.filter((item) => item.type === 'chunk');
  const chunk = chunks[0];
  if (chunk === undefined || chunks.length !== 1) {
    throw new Error(
      '@stayingupwind/adapter: Edge host instrumentation requires one JavaScript chunk',
    );
  }
  for (const item of output) {
    if (item.type === 'chunk') continue;
    if (
      sourceMaps &&
      chunk.map !== null &&
      chunk.map !== undefined &&
      item.fileName === chunk.sourcemapFileName
    )
      continue;
    throw new Error(
      `@stayingupwind/adapter: Edge host instrumentation emitted an unsupported asset: ${item.fileName}`,
    );
  }
}

export async function bundleEdge(
  input: BundleEdgeInput,
): Promise<{ outFile: string; trace: BundleTrace }> {
  const entryFile = path.join(input.workDir, `${input.kind}-edge-entry.cjs`);
  const outFile = path.join(input.workDir, `${input.kind}-${EDGE_MODULE}`);
  await writeFile(
    entryFile,
    edgeEntrySource(input.entries, input.projectDir, input.distDir, input.instrumentation),
  );
  const externals = new Set<string>();
  await using bundle = await rolldown(
    edgeBundleOptions(input.projectDir, entryFile, (specifier) => externals.add(specifier), {
      sourceMaps: input.sourceMaps === true ? { kept: input.keptMaps } : undefined,
      hostInstrumentation: input.instrumentation !== undefined,
      chunks: [
        ...input.entries.flatMap((entry) => entry.files),
        ...(input.instrumentation?.files ?? []),
      ],
    }),
  );
  const { output } = await bundle.write({
    format: 'cjs',
    file: outFile,
    // A host may lazily import an Edge SDK. Keep its initializer in this Function's one
    // module instead of emitting an additional chunk that the Function does not carry.
    ...(input.instrumentation !== undefined && { codeSplitting: false }),
    // Next.js's storages read `globalThis.AsyncLocalStorage` once, as they do in `app.cjs`, and
    // workerd has it only under `node:async_hooks`.
    banner: FUNCTION_BANNER,
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
    ...sourcemapOutput(input.sourceMaps === true),
  });
  if (input.instrumentation !== undefined) {
    assertEdgeHostOutput(output, input.sourceMaps === true);
  }
  const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
  if (chunk === undefined) {
    throw new Error(
      `@stayingupwind/adapter: the ${input.kind} Function's edge bundle made no chunk`,
    );
  }
  return {
    outFile,
    trace: {
      inputs: Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      externals: [...externals],
      patches: [],
      stubs: [],
      // Nothing here resolves a `.wasm`: Turbopack inlined every dependency of an edge
      // entrypoint, and what its chunks read they read off a global. Which global, and from
      // which file, is what Next.js named in `wasmAssets` — recorded so a deployment's
      // WebAssembly is in the record whichever runtime asked for it.
      wasmModules: input.entries.flatMap((entry) =>
        entry.wasm.map((asset) => `${asset.filePath} -> ${asset.global}`),
      ),
      dynamicLoads: dynamicLoadsInChunk(chunk),
    },
  };
}
