import path from 'node:path';

import type { WorkerModule } from '@upwind/core/bundle';

import type { DynamicLoad } from './dynamic-loads.ts';
import type { AppliedPatch } from './patches/index.ts';

/**
 * What went into a Worker, and what was done to it: written to `.ppr-cdn/dependencies.json` so
 * that a change in the bundle's makeup — a package newly pulled in, a Next.js file the patches
 * no longer find, a `require` the bundler could not follow — is visible in a diff and not only
 * in a failing Worker. The same record is what the audit reads: a Worker that would fail to
 * start or to serve fails the build here instead.
 */

export interface DependencyInput {
  readonly file: string;
  readonly bytes: number;
}

/** A module as the record takes it: by id, with the bytes it puts in the bundle. */
export function bundled(
  file: string,
  module: { readonly renderedLength: number },
): DependencyInput {
  return { file, bytes: module.renderedLength };
}

/** What one of a Worker's bundles is made of; a Worker has one for its code and one for its edge code. */
export interface BundleDependencies {
  /** Files bundled from the build output (`.next/…`), with the bytes each puts in the bundle. */
  readonly buildOutput: readonly DependencyInput[];
  /** Files bundled from `node_modules`, by package, with the bytes each puts in the bundle. */
  readonly packages: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>;
  /** Files bundled from anywhere else (the generated entry, the stubs). */
  readonly other: readonly DependencyInput[];
  /** Specifiers left for the Worker's own resolver: Node built-ins. */
  readonly externals: readonly string[];
  /** Specifiers resolved to an empty module. */
  readonly stubs: readonly string[];
  /** The rewrites applied, and to which files. */
  readonly patches: readonly {
    readonly patch: string;
    readonly file: string;
    readonly edits: number;
    readonly notes: readonly string[];
  }[];
  /**
   * The uses of the loader the bundler could not follow — a `require` or `import()` of anything
   * but one module's name, a method of the loader called or kept (`resolve`, `call`, `bind`),
   * the loader kept for a call the record cannot see, a module object's own loader
   * (`module.require`): each one fails at run time. Named by file, the line in the module as
   * Rolldown rendered it, and the call or the statement.
   */
  readonly dynamicRequires: readonly string[];
  /**
   * The `.wasm` this bundle imported as WebAssembly, each with the global the Worker publishes it
   * under. Only what the bundler resolved itself; what Turbopack's own loader asks for is in
   * `patches` instead, as the `wasm-loader` patch's table.
   */
  readonly wasmModules: readonly string[];
}

export interface WorkerDependencies extends BundleDependencies {
  /** The Worker's modules, by name, with their type and byte length. */
  readonly modules: readonly {
    readonly name: string;
    readonly type: string;
    readonly bytes: number;
  }[];
  /** What the Worker weighs, as Cloudflare measures it. */
  readonly size: WorkerSize;
  /** The same record for the Worker's edge bundle, when the build put entrypoints on it. */
  readonly edge?: BundleDependencies;
}

export interface WorkerSize {
  readonly bytes: number;
  /** Gzipped, which is the number Cloudflare's 10 MiB limit is measured against. */
  readonly gzipBytes: number;
}

/** What `bundleApp` collects while it runs, for `workerDependencies` to record afterwards. */
export interface BundleTrace {
  /** Every module bundled — a file by absolute path, a stub by its id — with its bytes in the output. */
  readonly inputs: readonly DependencyInput[];
  /** Specifiers the bundler left for the Worker's own resolver. */
  readonly externals: readonly string[];
  readonly patches: readonly AppliedPatch[];
  readonly stubs: readonly string[];
  /** `.wasm` the bundler resolved to the Worker's own module, as `<file> -> <global>`. */
  readonly wasmModules: readonly string[];
  /** `require` and `import()` calls the bundler could not follow, where each module makes them. */
  readonly dynamicLoads: readonly DynamicLoad[];
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/** The package a `node_modules` path belongs to: the innermost `node_modules/<name>`. */
function packageOf(file: string): string | undefined {
  const at = file.lastIndexOf(NODE_MODULES);
  if (at === -1) {
    return undefined;
  }
  const inside = file.slice(at + NODE_MODULES.length).split(path.sep);
  const [head, second] = inside;
  if (head === undefined) {
    return undefined;
  }
  return second !== undefined && head.startsWith('@') ? `${head}/${second}` : head;
}

/**
 * A file as the record names it: from the project for its own, from the package for a
 * dependency's; a module that is not a file (a stub) by its id.
 */
function displayPath(projectDir: string, file: string): string {
  if (!path.isAbsolute(file)) {
    // A bundler's own module is marked with a leading NUL, the convention for a virtual one.
    return file.replace(/^\0/u, '');
  }
  const at = file.lastIndexOf(NODE_MODULES);
  const inside = at === -1 ? undefined : file.slice(at + NODE_MODULES.length);
  return (inside ?? path.relative(projectDir, file)).split(path.sep).join('/');
}

/** The Worker as it will be uploaded: the modules it carries, and what they weigh together. */
export interface WorkerUpload {
  readonly modules: readonly WorkerModule[];
  readonly size: WorkerSize;
}

export function workerDependencies(
  projectDir: string,
  distDir: string,
  trace: BundleTrace,
  upload: WorkerUpload,
): WorkerDependencies {
  return {
    ...bundleDependencies(projectDir, distDir, trace),
    modules: upload.modules.map((module) => moduleRecord(module)),
    size: upload.size,
  };
}

const KIB = 1024;
const MIB = KIB * KIB;
const GZIP_LIMIT_MIB = 10;
const RAW_LIMIT_MIB = 64;
/** Cloudflare's per-Worker limits: 10 MiB gzipped on a paid plan, 64 MiB before compression. */
const MAX_WORKER_GZIP_BYTES = GZIP_LIMIT_MIB * MIB;
const MAX_WORKER_BYTES = RAW_LIMIT_MIB * MIB;
const MIB_DIGITS = 1;
/** Enough to show where the room went without printing the whole record. */
const HEAVIEST_MODULES = 5;

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(MIB_DIGITS)} MiB`;
}

/** Which limit a Worker is over, said as the message will say it; `undefined` when it is under. */
function overLimit(size: WorkerSize): string | undefined {
  if (size.gzipBytes > MAX_WORKER_GZIP_BYTES) {
    return `${mib(size.gzipBytes)} gzipped, over Cloudflare's ${mib(MAX_WORKER_GZIP_BYTES)} limit`;
  }
  if (size.bytes > MAX_WORKER_BYTES) {
    return `${mib(size.bytes)}, over Cloudflare's ${mib(MAX_WORKER_BYTES)} limit before compression`;
  }
  return undefined;
}

/** What one bundle of a Worker is made of; `edge` in the record is this, for `edge.cjs`. */
export function bundleDependencies(
  projectDir: string,
  distDir: string,
  trace: BundleTrace,
): BundleDependencies {
  const buildOutput: DependencyInput[] = [];
  const packages: Record<string, { files: number; bytes: number }> = {};
  const other: DependencyInput[] = [];
  for (const { file, bytes } of trace.inputs) {
    if (file.startsWith(`${distDir}${path.sep}`)) {
      buildOutput.push({ file: displayPath(projectDir, file), bytes });
      continue;
    }
    const pkg = packageOf(file);
    if (pkg === undefined) {
      other.push({ file: displayPath(projectDir, file), bytes });
      continue;
    }
    const entry = packages[pkg] ?? { files: 0, bytes: 0 };
    packages[pkg] = { files: entry.files + 1, bytes: entry.bytes + bytes };
  }
  return {
    buildOutput: buildOutput.toSorted((a, b) => a.file.localeCompare(b.file)),
    packages: Object.fromEntries(
      Object.entries(packages).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    other: other.toSorted((a, b) => a.file.localeCompare(b.file)),
    externals: [...new Set(trace.externals)].toSorted((a, b) => a.localeCompare(b)),
    stubs: [...new Set(trace.stubs)].toSorted((a, b) => a.localeCompare(b)),
    patches: trace.patches.map((applied) => {
      return {
        patch: applied.patch,
        file: displayPath(projectDir, applied.file),
        edits: applied.result.edits,
        notes: applied.result.notes,
      };
    }),
    dynamicRequires: trace.dynamicLoads.map((load) => describeLoad(projectDir, load)),
    wasmModules: [...new Set(trace.wasmModules)]
      .map((entry) => {
        const [file, global] = entry.split(' -> ', 2);
        return `${displayPath(projectDir, file ?? entry)} -> ${global ?? ''}`;
      })
      .toSorted((a, b) => a.localeCompare(b)),
  };
}

/** A load as the record names it: the file that makes it, the line, and the call. */
function describeLoad(projectDir: string, load: DynamicLoad): string {
  return `${displayPath(projectDir, load.file)}:${load.line}: ${load.text}`;
}

function moduleRecord(module: WorkerModule): { name: string; type: string; bytes: number } {
  return { name: module.name, type: module.type, bytes: module.blob.byteLength };
}

/**
 * The Node built-ins a Worker may import, with or without the `node:` prefix: what the bundled
 * Next.js — and what an application bundles beside it, an error reporter say — reaches for today. Under `nodejs_compat` every built-in
 * import resolves — the ones workerd does not implement are stubs that throw when used — so
 * this is not what starts the Worker but what is known to be reached only where it works, by
 * the runtime tests. A new one is a question — does workerd implement it, and is it called? —
 * asked here, at build time, rather than by a request that fails.
 */
const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'async_hooks',
  'buffer',
  // Imported by Sentry's Node SDK and never called from a Worker: a stub in workerd.
  'child_process',
  'crypto',
  'diagnostics_channel',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  // workerd provides it natively; the match is exact, so the subpath needs a line of its own.
  'path/posix',
  'perf_hooks',
  'querystring',
  // Imported by Sentry's context-lines integration, never called from a Worker: a stub in workerd.
  'readline',
  // Imported by better-auth's Kysely adapter for the SQLite it can drive; not the one here.
  'sqlite',
  'stream',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'timers',
  'timers/promises',
  'tls',
  'tty',
  'url',
  'util',
  'worker_threads',
  'zlib',
]);

function isAllowedExternal(specifier: string): boolean {
  return ALLOWED_BUILTINS.has(specifier.replace(/^node:/u, ''));
}

/**
 * The uses of the loader Next.js's own code makes that the bundler could not follow, known — as
 * the built-ins above are — to be reached only where they work: the Turbopack runtime's
 * `externalImport(id)`, an `import()` of an external of the build, which here is a Node
 * built-in; the server runtime's `import(e)` of a module it is handed; the Turbopack runtime's
 * `externalRequire.resolve`, a `require.resolve` for a module that asks the runtime to; the
 * loader the same runtime keeps on its module context (`contextPrototype.t`, `typeof require
 * === "function" ? require : ...`), for a module compiled to ask the runtime for it; and the
 * resolver the require hook keeps (`let resolve = ... : require.resolve`, as rendered) for the
 * aliases it installs. They stay in the record, for a Next.js that moves them to show in a
 * diff; a use of the loader anywhere else fails the build.
 *
 * The edge bundle's chunks carry a Turbopack runtime of their own, with the same three: an
 * `import()` of an external of the build, the `require.resolve` it offers a module that asks for
 * one, and the loader it keeps on its module context for a module compiled to ask the runtime for
 * it. None is reached: the edge build inlines every dependency, having no external to leave.
 *
 * That runtime is inlined, minified, into the chunk Turbopack builds from Next.js's edge-wrapper
 * template, which is the entry chunk of every edge entrypoint and carries no application code —
 * the wrapper's own body is a load by module id. The exception is tied to that chunk by name, so
 * a dynamic `import()` an application makes, which lands in a chunk of its own, is refused as it
 * is anywhere else. A Turbopack that names the chunk otherwise fails the build here, which is
 * where the question belongs. The hashes on either side of the template's name are Turbopack's,
 * whose alphabet has `-` and `_` beside the letters and digits (`0a-s4i-`, `06bu--d` are ones it
 * made), so they are matched as such and nothing else about the name is.
 */
const ALLOWED_DYNAMIC_LOADS: readonly RegExp[] = [
  /^\.next\/server\/chunks\/(?:ssr\/)?\[turbopack\]_runtime\.js:\d+: (?:import\(|require\.resolve\(|contextPrototype\.t = typeof require )/u,
  /^\.next\/server\/edge\/chunks\/(?:ssr\/)?[\w-]+_next_dist_esm_build_templates_edge-wrapper_[\w-]+\.js:\d+: (?:import\(|require\.resolve\(|\w+\.t = "function" == typeof require \? require :)/u,
  /^next\/dist\/compiled\/next-server\/[\w-]+\.runtime\.prod\.js:\d+: import\(/u,
  /^next\/dist\/server\/require-hook\.js:\d+: (?:const|let) resolve = /u,
];

function isAllowedDynamicLoad(load: string): boolean {
  return ALLOWED_DYNAMIC_LOADS.some((pattern) => pattern.test(load));
}

/** What must not survive in a bundled app: each is a Worker that fails to start or to serve. */
const FORBIDDEN_IN_APP: readonly (readonly [RegExp, string])[] = [
  [/require\(["'`](?:node:)?vm["'`]\)/u, 'a use of node:vm'],
  [/runInNewContext/u, 'a use of node:vm'],
  [/require\(["'`](?:require|import)-in-the-middle/u, 'a module-loader hook'],
  [/path\.resolve\(RUNTIME_ROOT,\s*chunkPath\)/u, 'a chunk loader that resolves paths'],
];

export class AuditError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuditError';
  }
}

/**
 * What Cloudflare will refuse to accept, refused here instead.
 *
 * A Worker that is too large fails at upload, long after the build that made it and with a
 * message about a number rather than about a deployment. WebAssembly is what makes this worth
 * checking: `@vercel/og`'s two modules are 1.4 MiB on their own, and an application may bring
 * more.
 *
 * The message carries the heaviest modules rather than pointing at `dependencies.json`: the
 * build throws here, before that file is written, so in exactly the case where the breakdown is
 * wanted there would be none to read.
 */
export function auditWorkerSize(kind: string, upload: WorkerUpload): void {
  const over = overLimit(upload.size);
  if (over === undefined) {
    return;
  }
  const heaviest = upload.modules
    .toSorted((left, right) => right.blob.byteLength - left.blob.byteLength)
    .slice(0, HEAVIEST_MODULES)
    .map((module) => `${module.name} (${mib(module.blob.byteLength)})`);
  throw new AuditError(
    `@upwind/adapter: the ${kind} Worker is ${over}; its largest modules are ${heaviest.join(', ')}`,
  );
}

/** What would fail the Worker in one of its bundles: the source as rendered, and its record. */
function problemsIn(source: string, bundle: BundleDependencies): string[] {
  const problems: string[] = [];
  for (const [pattern, what] of FORBIDDEN_IN_APP) {
    if (pattern.test(source)) {
      problems.push(`${what} survived bundling (${String(pattern)})`);
    }
  }
  for (const external of bundle.externals) {
    if (!isAllowedExternal(external)) {
      problems.push(`${external} is imported but not known to be provided by the Workers runtime`);
    }
  }
  for (const dynamic of bundle.dynamicRequires) {
    if (!isAllowedDynamicLoad(dynamic)) {
      problems.push(`a load the bundler could not follow: ${dynamic}`);
    }
  }
  return problems;
}

/** Fail the build on what would fail the Worker: each of its bundles is held to the same rules. */
export function auditWorker(
  kind: string,
  sources: { readonly app: string; readonly edge?: string },
  dependencies: WorkerDependencies,
): void {
  const problems = problemsIn(sources.app, dependencies);
  if (sources.edge !== undefined && dependencies.edge !== undefined) {
    problems.push(...problemsIn(sources.edge, dependencies.edge));
  }
  if (problems.length > 0) {
    const list = problems.map((problem) => `  - ${problem}`).join('\n');
    throw new AuditError(`@upwind/adapter: the ${kind} Worker would not run:\n${list}`);
  }
}
