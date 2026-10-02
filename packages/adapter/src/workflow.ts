import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { AdapterOutput } from 'next';

import { jsLiteral } from './codegen.ts';
import { exists } from './fs.ts';
import { arkorWasmGlobal, type WasmCollector } from './wasm.ts';

/**
 * The Workflow SDK (`workflow`: Vercel's `"use workflow"` and `"use step"`), as a deployment carries
 * it.
 *
 * `withWorkflow` from `workflow/next` writes the SDK's routes into the project before `next build`
 * runs: `/.well-known/workflow/v1/flow`, which the SDK's queue delivers every run's messages to and
 * which replays the workflow and runs its steps, and `/.well-known/workflow/v1/webhook/[token]`,
 * which a caller outside resumes a run through. Three things about the first one shape this module.
 *
 * - **It does not go in the app Function.** It is answered by a Function of its own, `workflow`,
 *   built from that one route: nothing a visitor asks for reaches it, so it needs no answer to who
 *   may call it, and the engine it carries — a JavaScript interpreter compiled to WebAssembly,
 *   below — weighs on no Function that serves a page.
 * - **The workflow runs on the SDK's QuickJS engine.** A workflow is replayed in a sandbox, which
 *   the SDK builds with `node:vm` unless told otherwise, and workerd's `node:vm` answers every call
 *   with `ERR_METHOD_NOT_IMPLEMENTED`: evaluating code at run time is what workerd refuses. The SDK
 *   ships an engine for exactly such a platform (`WORKFLOW_VM=quickjs`, which the runtime sets),
 *   and that is the first SDK release to: so nothing before 5 is accepted.
 * - **That engine carries its WebAssembly as base64.** The SDK decodes it and calls
 *   `WebAssembly.compile`, which workerd refuses as well (`Wasm code generation disallowed by
 *   embedder`). So each module embedded in the chunk becomes a module the Function carries,
 *   compiled when it is uploaded like any other (`wasm.ts`), and the literal a read of the global it
 *   is published under (the `workflow-quickjs-wasm` patch).
 *
 * What the SDK stores and queues is its World's business, and a host's: the World a deployment
 * talks to is the host's own module (`workflowWorldModule`), registered where the SDK looks for
 * one before any route asks for it (`writeWorldRegistration`).
 */

/** The SDK's flow route, under the project's `basePath`. */
export const WORKFLOW_FLOW_PATH = '/.well-known/workflow/v1/flow';

/** The first release with an engine that does not need `node:vm`. */
const MINIMUM_SDK_MAJOR = 5;

const PACKAGE_MANIFEST = 'package.json';

/** The package a project installs, whose version a bundle records. */
const SDK_PACKAGE = 'workflow';

/**
 * A WebAssembly module embedded in a chunk: a call of the decoder on a base64 literal that starts
 * with the module's magic number and version 1 (`\0asm\1\0\0\0`). Whatever the minifier named the
 * decoder, it is one identifier called with one string literal, which is the shape matched.
 */
export const EMBEDDED_WASM_CALL =
  /(?<![\w$])[\w$]+\((?<quote>["'`])(?<base64>AGFzbQEAAAA[\d+/A-Za-z]*={0,2})\k<quote>\)/gu;

/**
 * Whether a chunk is the SDK's QuickJS asset module: it names the init function of the engine's
 * `structured-clone` extension, which nothing but that module does, and it embeds WebAssembly.
 */
export function isQuickjsAssetsChunk(source: string): boolean {
  return source.includes('qjs_ext_structured_clone_init') && source.includes('AGFzbQEAAAA');
}

/** The base64 of every module a chunk embeds, in the order it embeds them. */
export function embeddedWasmLiterals(source: string): string[] {
  return [...source.matchAll(EMBEDDED_WASM_CALL)].flatMap((match) =>
    match.groups?.['base64'] === undefined ? [] : [match.groups['base64']],
  );
}

type AppRouteOutput = AdapterOutput['APP_ROUTE'];

/** The flow route among a build's outputs, when the project uses the SDK. */
export function flowRouteOf(
  appRoutes: readonly AppRouteOutput[],
  basePath: string,
): AppRouteOutput | undefined {
  const pathname = `${basePath}${WORKFLOW_FLOW_PATH}`;
  return appRoutes.find((output) => output.pathname === pathname);
}

/**
 * The directory of the package a module belongs to: the nearest one up whose `package.json` names
 * it. `workflow` does not export its `package.json`, so it is found from what it does export.
 */
async function packageDirOf(entry: string, name: string): Promise<string | undefined> {
  let dir = path.dirname(entry);
  for (;;) {
    const manifest = path.join(dir, PACKAGE_MANIFEST);
    if (await exists(manifest)) {
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name?: unknown };
      if (parsed.name === name) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * The SDK release the project installed, refused when it is older than the engine a Function can
 * run. Read from the project's own resolution of the package, which is the copy its build bundled.
 */
export async function workflowSdkVersion(projectDir: string): Promise<string> {
  const require = createRequire(path.join(projectDir, PACKAGE_MANIFEST));
  let entry: string;
  try {
    entry = require.resolve(SDK_PACKAGE);
  } catch (error) {
    throw new Error(
      `@stayingupwind/adapter: this build carries the Workflow SDK's routes, but \`${SDK_PACKAGE}\` cannot be resolved from ${projectDir}`,
      { cause: error },
    );
  }
  const dir = await packageDirOf(entry, SDK_PACKAGE);
  if (dir === undefined) {
    throw new Error(
      `@stayingupwind/adapter: no package.json of \`${SDK_PACKAGE}\` was found above ${entry}`,
    );
  }
  const { version } = JSON.parse(await readFile(path.join(dir, PACKAGE_MANIFEST), 'utf8')) as {
    version?: unknown;
  };
  if (typeof version !== 'string') {
    throw new TypeError(`@stayingupwind/adapter: \`${SDK_PACKAGE}\` names no version`);
  }
  const major = Number.parseInt(version, 10);
  if (Number.isNaN(major) || major < MINIMUM_SDK_MAJOR) {
    throw new Error(
      `@stayingupwind/adapter: \`${SDK_PACKAGE}\` ${version} runs workflows on \`node:vm\`, which workerd does not implement; ${String(MINIMUM_SDK_MAJOR)}.0.0 is the first release with an engine that runs there (QuickJS). Upgrade \`${SDK_PACKAGE}\` and build again.`,
    );
  }
  return version;
}

/**
 * Offer the WebAssembly the SDK's engine embeds in `chunks` to `collector`, published under the
 * names the `workflow-quickjs-wasm` patch reads it by, and answer the digests offered.
 *
 * Every Function's chunks are asked, not only the workflow Function's: a chunk the patch rewrites
 * has to find each of its modules published, wherever it was bundled. It is the flow route that
 * reaches the engine, so in practice only that Function finds any.
 */
export async function offerEmbeddedWasm(
  chunks: readonly string[],
  collector: WasmCollector,
): Promise<ReadonlySet<string>> {
  const offered = new Set<string>();
  for (const chunk of chunks) {
    const source = await readFile(chunk, 'utf8');
    if (!isQuickjsAssetsChunk(source)) {
      continue;
    }
    for (const base64 of embeddedWasmLiterals(source)) {
      const sha256 = await collector.offerBytes(new Uint8Array(Buffer.from(base64, 'base64')));
      collector.publish(sha256, arkorWasmGlobal(sha256));
      offered.add(sha256);
    }
  }
  return offered;
}

/** The registration's name under the build's own directory. */
const REGISTRATION_MODULE = 'workflow-world.cjs';

/**
 * Write the module that registers the host's World and answer its path; it goes among the host's
 * instrumentation modules, so its `register` runs before any route of the deployment does.
 *
 * It does what the SDK's own `setWorld()` does (`@workflow/core`, `runtime/world.ts`): the World
 * is kept on `globalThis` under the SDK's keys, which every copy of the SDK in the Function reads —
 * Next.js compiles one per layer, and `getWorld()` in each of them finds it there. A factory that
 * answers a promise is registered as the promise the SDK awaits. The project's own hook runs after
 * the host's, so a project that calls `setWorld()` itself still has the last word.
 *
 * Importing `workflow/runtime` to call `setWorld()` would do the same thing at the price of a
 * second copy of the SDK in the Function: the copy the routes use is compiled into Turbopack's
 * chunks, which nothing outside them can import.
 */
export async function writeWorldRegistration(outDir: string, worldModule: string): Promise<string> {
  const source = [
    '// Generated by @stayingupwind/adapter: the host’s World, where the Workflow SDK looks for one.',
    `const host = require(${jsLiteral(worldModule)});`,
    "const CACHE = Symbol.for('@workflow/world//cache');",
    "const STUBBED_CACHE = Symbol.for('@workflow/world//stubbedCache');",
    "const CACHE_PROMISE = Symbol.for('@workflow/world//cachePromise');",
    "const STUBBED_CACHE_PROMISE = Symbol.for('@workflow/world//stubbedCachePromise');",
    'module.exports = {',
    '  register() {',
    '    const world = host.createWorld();',
    "    if (typeof world?.then === 'function') {",
    '      globalThis[CACHE] = undefined;',
    '      globalThis[STUBBED_CACHE] = undefined;',
    '      globalThis[CACHE_PROMISE] = world;',
    '      globalThis[STUBBED_CACHE_PROMISE] = world;',
    '      return;',
    '    }',
    '    globalThis[CACHE] = world;',
    '    globalThis[STUBBED_CACHE] = world;',
    '    globalThis[CACHE_PROMISE] = undefined;',
    '    globalThis[STUBBED_CACHE_PROMISE] = undefined;',
    '  },',
    '};',
    '',
  ].join('\n');
  const file = path.join(outDir, REGISTRATION_MODULE);
  await writeFile(file, source);
  return file;
}

/**
 * The SDK's own Worlds, which a Function cannot run, and the module each is replaced by.
 *
 * `@workflow/core` imports both of them statically (`runtime/world.ts`), for the `createWorld()` it
 * falls back on when nothing registered a World, so both are compiled into every route that touches
 * the SDK: a megabyte of the app Function, an HTTP client with a WebAssembly parser of its own and
 * Vercel's credential helpers among it — for Worlds that keep their state on a file system or reach
 * Vercel's own queue, neither of which a Function has. Each is replaced, at the Turbopack build, by a
 * module whose `createWorld()` says so; the SDK asks for nothing else of them. A subpath is a request
 * of its own and is left alone: the SDK still reads `@workflow/world-vercel/run-id`.
 */
const BUILTIN_WORLDS: Readonly<Record<string, { readonly file: string; readonly why: string }>> = {
  '@workflow/world-local': {
    file: 'workflow-world-local.mjs',
    why: 'it keeps its runs on a file system and delivers them over localhost',
  },
  '@workflow/world-vercel': {
    file: 'workflow-world-vercel.mjs',
    why: "it reaches Vercel's own queue and storage, with Vercel's credentials",
  },
};

function builtinWorldSource(name: string, why: string): string {
  const message = `${name} cannot run in a Function: ${why}. The host registers the World this deployment uses.`;
  return [
    `// Generated by @stayingupwind/adapter: ${name}, which a Function cannot run.`,
    'export function createWorld() {',
    `  throw new Error(${jsLiteral(message)});`,
    '}',
    '',
  ].join('\n');
}

/** Whether the project can resolve the SDK, which is what puts its Worlds in the build. */
function resolvesSdk(projectDir: string): boolean {
  try {
    createRequire(path.join(projectDir, PACKAGE_MANIFEST)).resolve(SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

/** The part of the config this module touches, as Next.js declares it. */
interface TurbopackConfig {
  turbopack?: { resolveAlias?: Record<string, unknown> | undefined } | undefined;
}

/**
 * Point the SDK's own Worlds at modules that refuse to run, for a project that installed the SDK:
 * written into the build's own directory, since Turbopack resolves nothing outside the project, and
 * named relative to the project root as `resolveAlias` takes them. An alias the project set for
 * either name is the project's, and is left as it is.
 */
export async function aliasBuiltinWorlds(
  config: TurbopackConfig,
  projectDir: string,
  outDirName: string,
): Promise<void> {
  if (!resolvesSdk(projectDir)) {
    return;
  }
  const own = config.turbopack?.resolveAlias ?? {};
  const aliases: Record<string, string> = {};
  await mkdir(path.join(projectDir, outDirName), { recursive: true });
  for (const [name, world] of Object.entries(BUILTIN_WORLDS)) {
    if (own[name] !== undefined) {
      continue;
    }
    await writeFile(
      path.join(projectDir, outDirName, world.file),
      builtinWorldSource(name, world.why),
    );
    aliases[name] = `./${outDirName}/${world.file}`;
  }
  config.turbopack = { ...config.turbopack, resolveAlias: { ...own, ...aliases } };
}
