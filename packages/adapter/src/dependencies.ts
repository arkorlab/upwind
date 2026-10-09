import { isBuiltin } from 'node:module';
import path from 'node:path';

import type { FunctionModule } from '@stayingupwind/core/bundle';

import type { DynamicLoad } from './dynamic-loads.ts';
import type { AppliedPatch } from './patches/index.ts';

/**
 * What went into a Function, and what was done to it: written to `.arkor/dependencies.json` so
 * that a change in the bundle's makeup — a package newly pulled in, a Next.js file the patches
 * no longer find, a `require` the bundler could not follow — is visible in a diff and not only
 * in a failing Function. The same record is what the audit reads: a Function that would fail to
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

/** What one of a Function's bundles is made of; a Function has one for its code and one for its edge code. */
export interface BundleDependencies {
  /** Files bundled from the build output (`.next/…`), with the bytes each puts in the bundle. */
  readonly buildOutput: readonly DependencyInput[];
  /** Files bundled from `node_modules`, by package, with the bytes each puts in the bundle. */
  readonly packages: Readonly<Record<string, { readonly files: number; readonly bytes: number }>>;
  /** Files bundled from anywhere else (the generated entry, the stubs). */
  readonly other: readonly DependencyInput[];
  /** Specifiers left for the Function's own resolver: Node built-ins. */
  readonly externals: readonly string[];
  /**
   * Specifiers no module was found for, in a bundle of packages the runtime imports lazily
   * (`linked-externals.ts`): an import that fails in the Function as it would under Node.js, when it
   * runs. Recorded, not refused.
   */
  readonly unresolved?: readonly string[];
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
   * Of those, the loads whose failure the code handles itself: a call that loads, in the block of a
   * `try` whose `catch` has no `throw` of its own, with nothing between them that runs later
   * (`dynamic-loads.ts`). Recorded, not refused — in the Function such a load fails into that
   * `catch`, as it does under Node.js when the module is not installed. One entry per load, as in
   * `dynamicRequires`; absent where there are none.
   */
  readonly guardedRequires?: readonly string[];
  /**
   * The `.wasm` this bundle imported as WebAssembly, each with the global the Function publishes it
   * under. Only what the bundler resolved itself; what Turbopack's own loader asks for is in
   * `patches` instead, as the `wasm-loader` patch's table.
   */
  readonly wasmModules: readonly string[];
}

export interface FunctionDependencies extends BundleDependencies {
  /** The Function's modules, by name, with their type and byte length. */
  readonly modules: readonly {
    readonly name: string;
    readonly type: string;
    readonly bytes: number;
  }[];
  /** What the Function weighs, as Cloudflare measures it. */
  readonly size: FunctionSize;
  /** The same record for the Function's edge bundle, when the build put entrypoints on it. */
  readonly edge?: BundleDependencies;
  /**
   * The same record for the packages the build leaves to the runtime as ES modules, which the
   * Function carries as modules of their own (`linked-externals.ts`), when the chunks import any.
   */
  readonly linked?: BundleDependencies;
}

export interface FunctionSize {
  /** Uncompressed, which is what `MAX_FUNCTION_BYTES` measures — Cloudflare's only limit left. */
  readonly bytes: number;
  /**
   * Gzipped, and enforced nowhere: the compressed limit this used to be measured against is one
   * Cloudflare removed, as `MAX_FUNCTION_BYTES` says. Still worth reading — it is what the upload
   * spends — and worth refusing a build for no longer.
   */
  readonly gzipBytes: number;
}

/** What `bundleApp` collects while it runs, for `functionDependencies` to record afterwards. */
export interface BundleTrace {
  /** Every module bundled — a file by absolute path, a stub by its id — with its bytes in the output. */
  readonly inputs: readonly DependencyInput[];
  /** Specifiers the bundler left for the Function's own resolver. */
  readonly externals: readonly string[];
  /** Specifiers the bundler found nothing for, where that is not a failure (`unresolved`). */
  readonly unresolved?: readonly string[];
  readonly patches: readonly AppliedPatch[];
  readonly stubs: readonly string[];
  /** `.wasm` the bundler resolved to the Function's own module, as `<file> -> <global>`. */
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

/** The Function as it will be uploaded: the modules it carries, and what they weigh together. */
export interface FunctionUpload {
  readonly modules: readonly FunctionModule[];
  readonly size: FunctionSize;
}

export function functionDependencies(
  projectDir: string,
  distDir: string,
  trace: BundleTrace,
  upload: FunctionUpload,
): FunctionDependencies {
  return {
    ...bundleDependencies(projectDir, distDir, trace),
    modules: upload.modules.map((module) => moduleRecord(module)),
    size: upload.size,
  };
}

const KIB = 1024;
const MIB = KIB * KIB;
const RAW_LIMIT_MIB = 64;
/**
 * Cloudflare's per-Function limit: 64 MiB, uncompressed, on every plan.
 *
 * It used to be a compressed one as well — 3 MB free, 10 MB paid — and Cloudflare removed that on
 * 2026-09-04: "Cloudflare now only checks the uncompressed size of your bundle, which is 64 MiB
 * across all plans", and the gzipped figure is "shown for reference but is no longer a limit".
 * Wrangler still prints it, and so does the record this module writes, for the same reason: it is
 * worth knowing and it decides nothing.
 *
 * A Function held to a limit its platform has dropped is one this adapter refuses to build for no
 * reason anybody can act on, which is what the compressed check had become.
 */
export const MAX_FUNCTION_BYTES = RAW_LIMIT_MIB * MIB;
const MIB_DIGITS = 1;
/** Enough to show where the room went without printing the whole record. */
const HEAVIEST_MODULES = 5;

function mib(bytes: number): string {
  return `${(bytes / MIB).toFixed(MIB_DIGITS)} MiB`;
}

/** Whether a Function is over the limit, said as the message will say it; `undefined` when under. */
function overLimit(size: FunctionSize): string | undefined {
  if (size.bytes > MAX_FUNCTION_BYTES) {
    return `${mib(size.bytes)}, over the ${mib(MAX_FUNCTION_BYTES)} limit`;
  }
  return undefined;
}

/** What one bundle of a Function is made of; `edge` in the record is this, for `edge.cjs`. */
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
  const guarded = trace.dynamicLoads
    .filter((load) => load.guarded)
    .map((load) => describeLoad(projectDir, load));
  return {
    buildOutput: buildOutput.toSorted((a, b) => a.file.localeCompare(b.file)),
    packages: Object.fromEntries(
      Object.entries(packages).toSorted(([a], [b]) => a.localeCompare(b)),
    ),
    other: other.toSorted((a, b) => a.file.localeCompare(b.file)),
    externals: [...new Set(trace.externals)].toSorted((a, b) => a.localeCompare(b)),
    ...(trace.unresolved !== undefined && {
      unresolved: [...new Set(trace.unresolved)].toSorted((a, b) => a.localeCompare(b)),
    }),
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
    ...(guarded.length > 0 && { guardedRequires: guarded }),
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

function moduleRecord(module: FunctionModule): { name: string; type: string; bytes: number } {
  return { name: module.name, type: module.type, bytes: module.blob.byteLength };
}

/**
 * The Node built-ins a Function may import, with or without the `node:` prefix: what the bundled
 * Next.js — and what an application bundles beside it, an error reporter say — reaches for today. Under `nodejs_compat` every built-in
 * import resolves — the ones workerd does not implement are stubs that throw when used — so
 * this is not what starts the Function but what is known to be reached only where it works, by
 * the runtime tests. A new one is a question — does workerd implement it, and is it called? —
 * asked here, at build time, rather than by a request that fails.
 */
const ALLOWED_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  // workerd provides these four natively (`src/node/` in workerd); the Workflow SDK's runtime
  // imports each of them, and the match is exact, so each subpath needs a line of its own.
  'assert/strict',
  'async_hooks',
  'buffer',
  // Imported by Sentry's Node SDK and never called from a Function: a stub in workerd.
  'child_process',
  'console',
  // workerd implements it with the real values — `O_RDONLY`, `SIGTERM` and the rest — rather than a
  // stub. Required by `graceful-fs`, so by `fs-extra` and everything built on it.
  'constants',
  'crypto',
  // Imported by OpenTelemetry's Node.js SDK, for an exporter a Function does not send through: a
  // stub in workerd. Like `dns` and `http2`, it is found by `require` under the Function's
  // compatibility date and flags, as `process` is not (see `loader-hooks.ts`).
  'dgram',
  'diagnostics_channel',
  // workerd provides it natively. Imported by OpenTelemetry's Node.js SDK.
  'dns',
  'events',
  'fs',
  'fs/promises',
  'http',
  // Imported by OpenTelemetry's Node.js SDK, for its gRPC exporter: a stub in workerd.
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  // workerd provides it natively; the match is exact, so the subpath needs a line of its own.
  'path/posix',
  'perf_hooks',
  // workerd implements it in full, encoding and decoding both. Deprecated in Node.js and still
  // imported by `tough-cookie`, so by `request` and the HTTP clients that kept its cookie jar.
  'punycode',
  'querystring',
  // Imported by Sentry's context-lines integration, never called from a Function: a stub in workerd.
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
  'util/types',
  'worker_threads',
  'zlib',
]);

function isAllowedExternal(specifier: string): boolean {
  return (
    [
      'cloudflare:email',
      'cloudflare:node',
      'cloudflare:sockets',
      'cloudflare:workers',
      'cloudflare:workflows',
    ].includes(specifier) ||
    (isBuiltin(specifier) && ALLOWED_BUILTINS.has(specifier.replace(/^node:/u, '')))
  );
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
 * That runtime is inlined — minified, unless the application turns Turbopack's minifier off
 * (`experimental.turbopackMinify: false`, which `middleware-basic` does), when it reads as the
 * Node.js runtime's does — into the chunk Turbopack builds from Next.js's edge-wrapper
 * template, which is the entry chunk of every edge entrypoint and carries no application code —
 * the wrapper's own body is a load by module id. The exception is tied to that chunk by name, so
 * a dynamic `import()` an application makes, which lands in a chunk of its own, is refused as it
 * is anywhere else. A Turbopack that names the chunk otherwise fails the build here, which is
 * where the question belongs.
 *
 * What identifies the chunk is the template it was built from, and only that. The hashes on either
 * side of the template's name are Turbopack's, and their alphabet is not one to enumerate: it was
 * taken for letters, digits, `-` and `_` until a build produced `11s91~v`, which failed an audit
 * over a character nothing here has any business having an opinion about. So the hashes are
 * whatever is not a path separator, and the name is read for the one part of it that means
 * something.
 */
const ALLOWED_DYNAMIC_LOADS: readonly RegExp[] = [
  // The Workflow SDK's loader for a World named by `WORKFLOW_TARGET_WORLD` (`createWorld` in
  // `@workflow/core`'s `runtime/world.ts`), which turns a path into a `file://` URL to import. It is
  // reached only when no World was registered, and a deployment that carries the SDK has its host's
  // registered before any route runs (`workflowWorldModule`); in a Function it could only fail, as
  // there is no file to import. Turbopack puts the SDK in whichever chunk it likes.
  /^\.next\/server\/chunks\/[^:]+:\d+: import\(function\([\w$]+\) \{\s*if \([\w$]+\.startsWith\("file:\/\/"\)\) return [\w$]+;/u,
  /^\.next\/server\/chunks\/(?:ssr\/)?\[turbopack\]_runtime\.js:\d+: (?:import\(|require\.resolve\(|contextPrototype\.t = typeof require )/u,
  /^\.next\/server\/edge\/chunks\/(?:ssr\/)?[^/]+_next_dist_esm_build_templates_edge-wrapper_[^/]+\.js:\d+: (?:import\(|require\.resolve\(|\w+\.t = "function" == typeof require \? require :|contextPrototype\.t = typeof require === "function" \? require :)/u,
  /^next\/dist\/compiled\/next-server\/[\w-]+\.runtime\.prod\.js:\d+: import\(/u,
  /^next\/dist\/server\/require-hook\.js:\d+: (?:const|let) resolve = /u,
];

/** Where the patterns above find the build's output: `.next`, unless `distDir` says otherwise. */
const NAMED_OUTPUT = '.next';

/**
 * Where a project's build output is, as the record names a file of it (`displayPath`): `.next`, and
 * otherwise wherever its `distDir` put it — `build` for `distDir: 'build'`, `../.next` for a package
 * that writes it beside itself, as a monorepo's tools do (`upward-distdir`).
 */
export function outputNameOf(projectDir: string, distDir: string): string {
  return displayPath(projectDir, distDir);
}

/**
 * Whether a load is one of those above, read with the build's output named `.next/` as they name it.
 * Read as it is, every build whose output is anywhere else failed the audit on the Turbopack
 * runtime's own loads.
 */
function isAllowedDynamicLoad(load: string, output: string): boolean {
  const named =
    output !== NAMED_OUTPUT && load.startsWith(`${output}/`)
      ? `${NAMED_OUTPUT}${load.slice(output.length)}`
      : load;
  return ALLOWED_DYNAMIC_LOADS.some((pattern) => pattern.test(named));
}

/** What must not survive in a bundled app: each is a Function that fails to start or to serve. */
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
 * Refuse a build whose output is outside its project — `distDir: '../.next'`, as a monorepo's tools
 * write it beside their packages (`upward-distdir`, `nx-handling`). The Function carries the build's
 * files under the names they have from the project (`displayPath`), and `workerd` loads no module whose
 * name climbs out of its own (`../.next/BUILD_ID`): the Function would be deployed and never start.
 * Said here, where the configuration is, rather than as a deployment that does not answer.
 */
export function refuseOutputOutsideProject(projectDir: string, distDir: string): void {
  const relative = path.relative(projectDir, distDir);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AuditError(
      `@stayingupwind/adapter: the build's output (\`distDir\`, ${outputNameOf(projectDir, distDir)}) is outside the project (${projectDir}); the Function names the files it carries from the project, and none can be named outside it`,
    );
  }
}

/**
 * A file the application reads, under a name the Function already carries a module of its own under
 * — `runtime.json`, the deployment's manifest, say. The file is found at its path in the project,
 * and the application would be handed that module where it asked for its file, so the build is
 * refused rather than one silently read in place of the other.
 */
export function auditTracedFiles(
  kind: string,
  modules: readonly { readonly name: string }[],
  files: readonly { readonly name: string }[],
): void {
  const taken = new Set(modules.map((module) => module.name));
  const clashing = files.filter((file) => taken.has(file.name)).map((file) => file.name);
  if (clashing.length > 0) {
    throw new AuditError(
      `@stayingupwind/adapter: the application reads ${clashing.join(', ')}, which the ${kind} Function carries a module of its own under; rename the file`,
    );
  }
}

/**
 * What Cloudflare will refuse to accept, refused here instead.
 *
 * A Function that is too large fails at upload, long after the build that made it and with a
 * message about a number rather than about a deployment. WebAssembly is what makes this worth
 * checking: `@vercel/og`'s two modules are 1.4 MiB on their own, and an application may bring
 * more.
 *
 * The message carries the heaviest modules rather than pointing at `dependencies.json`: the
 * build throws here, before that file is written, so in exactly the case where the breakdown is
 * wanted there would be none to read.
 */
export function auditFunctionSize(kind: string, upload: FunctionUpload, deferred = false): void {
  // A Function the caller is still weighing (`deferSizeAudit`) is held to the limit once it is final.
  const over = deferred ? undefined : overLimit(upload.size);
  if (over === undefined) {
    return;
  }
  const heaviest = upload.modules
    .toSorted((left, right) => right.blob.byteLength - left.blob.byteLength)
    .slice(0, HEAVIEST_MODULES)
    .map((module) => `${module.name} (${mib(module.blob.byteLength)})`);
  throw new AuditError(
    `@stayingupwind/adapter: the ${kind} server bundle is ${over}; its largest modules are ${heaviest.join(', ')}`,
  );
}

/** What would fail the Function in one of its bundles: the source as rendered, and its record. */
function problemsIn(source: string, bundle: BundleDependencies, output: string): string[] {
  const problems: string[] = [];
  for (const [pattern, what] of FORBIDDEN_IN_APP) {
    if (pattern.test(source)) {
      problems.push(`${what} survived bundling (${String(pattern)})`);
    }
  }
  for (const external of bundle.externals) {
    if (!isAllowedExternal(external)) {
      problems.push(
        `${external} is imported but not known to be provided by the deployment runtime`,
      );
    }
  }
  // Counted rather than looked up: two loads on one line of a minified module read the same, and
  // one of them being guarded says nothing of the other.
  const guarded = new Map<string, number>();
  if (bundle.guardedRequires !== undefined) {
    for (const load of bundle.guardedRequires) {
      guarded.set(load, (guarded.get(load) ?? 0) + 1);
    }
  }
  for (const dynamic of bundle.dynamicRequires) {
    const left = guarded.get(dynamic) ?? 0;
    if (left > 0) {
      guarded.set(dynamic, left - 1);
    } else if (!isAllowedDynamicLoad(dynamic, output)) {
      problems.push(`a load the bundler could not follow: ${dynamic}`);
    }
  }
  return problems;
}

/** Fail the build on what would fail the Function: each of its bundles is held to the same rules. */
export function auditFunction(
  kind: string,
  sources: { readonly app: string; readonly edge?: string; readonly linked?: string },
  dependencies: FunctionDependencies,
  output = NAMED_OUTPUT,
): void {
  const problems = problemsIn(sources.app, dependencies, output);
  if (sources.edge !== undefined && dependencies.edge !== undefined) {
    problems.push(...problemsIn(sources.edge, dependencies.edge, output));
  }
  if (sources.linked !== undefined && dependencies.linked !== undefined) {
    problems.push(...problemsIn(sources.linked, dependencies.linked, output));
  }
  if (problems.length > 0) {
    const list = problems.map((problem) => `  - ${problem}`).join('\n');
    throw new AuditError(`@stayingupwind/adapter: the ${kind} Function would not run:\n${list}`);
  }
}
