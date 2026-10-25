import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import { runInNewContext } from 'node:vm';

import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare';
import { type Plugin, rolldown } from 'rolldown';
import { afterEach, assert, describe, expect, it } from 'vitest';

import { FUNCTION_COMPATIBILITY_DATE, FUNCTION_COMPATIBILITY_FLAGS } from '../src/function.ts';
import { isStubbedModule, stubSourceFor } from '../src/patches/loader-hooks.ts';
import { stubPlugin } from '../src/patches/rolldown.ts';

/** Every directory a case made, removed once the case has run, however it ended. */
const roots: string[] = [];

async function removeRoots(): Promise<void> {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
}

/**
 * What stands in for the module-loader hooks, held to how OpenTelemetry's instrumentation — the
 * one Sentry's Node SDK installs the moment a DSN configures it — uses them: `new Hook(...)`,
 * named or as the module itself. A stub that is not a constructor throws while Next.js loads the
 * instrumentation hook, and every request the deployment serves is a 500.
 */

interface HookModule {
  new (modules: unknown, options: unknown, onHook: unknown): { unhook: () => void };
  readonly Hook: HookModule;
  readonly addHook: (...args: unknown[]) => void;
  readonly removeHook: (...args: unknown[]) => void;
  readonly createAddHookMessageChannel: () => {
    readonly registerOptions: { readonly data: { readonly include: readonly unknown[] } };
    readonly waitForAllMessagesAcknowledged: () => Promise<void>;
  };
}

/** Explicit no-op for the hook callbacks (an empty body would trip `no-empty-function`). */
function noop(): void {
  // Intentionally empty.
}

function load(specifier: string): HookModule {
  const module = { exports: {} as unknown };
  // eslint-disable-next-line sonarjs/code-eval -- the adapter's own module source, run to be tested
  runInNewContext(stubSourceFor(specifier), { module, Promise });
  return module.exports as HookModule;
}

describe('the module-loader hooks a Worker has nothing to hook with', () => {
  it('stands in for either package, however the build names it', () => {
    expect(isStubbedModule('require-in-the-middle')).toBe(true);
    expect(isStubbedModule('import-in-the-middle')).toBe(true);
    expect(isStubbedModule('import-in-the-middle-a2854492a3d291fa')).toBe(true);
    expect(isStubbedModule('in-the-middle')).toBe(false);
  });

  it('registers a hook that hooks nothing, rather than refusing to be one', () => {
    const Hooks = load('import-in-the-middle');
    const named = new Hooks.Hook(['node:http'], { internals: true }, noop);
    const direct = new Hooks(null, { internals: true }, noop);

    expect(() => {
      named.unhook();
      direct.unhook();
    }).not.toThrow();
  });

  it('answers the loader channel with nothing to wait for', async () => {
    const Hooks = load('require-in-the-middle');
    const channel = Hooks.createAddHookMessageChannel();

    expect(() => {
      Hooks.addHook(noop);
      Hooks.removeHook(noop);
    }).not.toThrow();
    // Compared field by field: the module was evaluated in a context of its own, where an object
    // literal is not of this one's `Object`.
    expect(channel.registerOptions.data.include).toHaveLength(0);
    await expect(channel.waitForAllMessagesAcknowledged()).resolves.toBeUndefined();
  });
});

/**
 * `node:process`, which workerd's `require` does not find although its `import` does: a CommonJS
 * bundle asking for it is handed the global, which is that very module.
 */
describe("the process module workerd's require does not find", () => {
  it('is the global, under either spelling, and nothing that only starts like it', () => {
    expect(isStubbedModule('process')).toBe(true);
    expect(isStubbedModule('node:process')).toBe(true);
    expect(isStubbedModule('process-nextick-args')).toBe(false);

    const running = { env: { NEXT_RUNTIME: 'nodejs' } };
    const module = { exports: {} as unknown };
    // eslint-disable-next-line sonarjs/code-eval -- the adapter's own module source, run to be tested
    runInNewContext(stubSourceFor('node:process'), { module, process: running });

    expect(module.exports).toBe(running);
  });
});

/** What a `require` made by `createRequire` is, with the property Node.js's carries. */
type MadeRequire = ((id: string) => unknown) & { readonly resolve?: (id: string) => string };

/** As much of `node:module` as the stub and the cases below reach. */
interface ModuleLike {
  readonly createRequire: (from: string) => MadeRequire;
  readonly isBuiltin: (id: string) => boolean;
  /** Node.js's own, which Next.js's require hook replaces. */
  _resolveFilename: (request: string) => string;
}

/** What Next.js's require hook puts in place of `_resolveFilename`. */
function hookedResolveFilename(request: string): string {
  return `hooked ${request}`;
}

/**
 * workerd's `createRequire`, as far as the stub is concerned: the `require` it makes finds every
 * built-in but `node:process`, under either spelling, which it says is no such module.
 */
function workerdRequire(from: string): MadeRequire {
  return Object.assign(
    (id: string): unknown => {
      if (/^(?:node:)?process$/u.test(id)) {
        throw new Error('No such module "node:process".');
      }
      return { id, from };
    },
    { resolve: (id: string) => `resolved ${id}` },
  );
}

function workerdModule(): ModuleLike {
  return {
    createRequire: workerdRequire,
    isBuiltin: (id) => !id.startsWith('.'),
    _resolveFilename: (request) => request,
  };
}

/** The `node:module` stub, run with `builtin` as the module its own require is handed. */
function loadModuleStub(
  builtin: ModuleLike,
  running: unknown,
): { readonly exports: ModuleLike; readonly required: readonly string[] } {
  const required: string[] = [];
  const module = { exports: {} as unknown };
  // eslint-disable-next-line sonarjs/code-eval -- the adapter's own module source, run to be tested
  runInNewContext(stubSourceFor('node:module'), {
    module,
    process: running,
    require(id: string) {
      required.push(id);
      return builtin;
    },
  });
  return { exports: module.exports as ModuleLike, required };
}

/**
 * `node:module`, whose `createRequire` makes a `require` of workerd's that does not find
 * `node:process` either: a package that loads its built-ins through one at run time, as esbuild's
 * output does, is handed the global for it, and everything else as workerd gives it.
 */
describe('node:module, whose createRequire makes a require that does not find node:process', () => {
  it('stands in for either spelling, and nothing that only starts like it', () => {
    expect(isStubbedModule('module')).toBe(true);
    expect(isStubbedModule('node:module')).toBe(true);
    expect(isStubbedModule('module-alias')).toBe(false);
    expect(isStubbedModule('node:modules')).toBe(false);
  });

  it("makes a require that answers node:process with the global, and the rest as workerd's", () => {
    const running = { env: { NEXT_RUNTIME: 'nodejs' } };
    const { exports, required } = loadModuleStub(workerdModule(), running);
    const made = exports.createRequire('file:///bundle/app.cjs');

    expect(required).toStrictEqual(['node:module']);
    expect(made('process')).toBe(running);
    expect(made('node:process')).toBe(running);
    expect(made('node:path')).toStrictEqual({ id: 'node:path', from: 'file:///bundle/app.cjs' });
    expect(made.resolve?.('node:path')).toBe('resolved node:path');
  });

  it("reads and writes every other member through to workerd's module", () => {
    const builtin = workerdModule();
    const { exports } = loadModuleStub(builtin, {});

    expect(exports.isBuiltin).toBe(builtin.isBuiltin);
    expect(exports.createRequire).not.toBe(builtin.createRequire);

    exports._resolveFilename = hookedResolveFilename;

    expect(builtin._resolveFilename).toBe(hookedResolveFilename);
  });
});

/**
 * What a package compiled to an ES module does with the `require` it makes for itself, as
 * `@vercel/otel`'s Node.js build does while it is evaluated; and `node:module` under both of its
 * names, which are one module.
 */
const CREATING_ENTRY = `import { createRequire } from 'node:module';
import viaName from 'module';
import viaPrefix from 'node:module';
const require = createRequire(import.meta.url);
export const processModule = require('process');
export const prefixed = require('node:process');
export const other = require('node:path');
export const oneModule = viaName === viaPrefix;
`;

/** The Function's own require, as far as these bundles reach it: the built-ins workerd gives them. */
function functionRequire(builtin: ModuleLike): (id: string) => unknown {
  return (id) => {
    if (id === 'url' || id === 'node:url') return url;
    if (id === 'module' || id === 'node:module') return builtin;
    throw new Error(`No such module "${id}".`);
  };
}

async function bundledCjs(entry: string, plugins: readonly Plugin[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'adapter-create-require-'));
  roots.push(dir);
  await writeFile(path.join(dir, 'entry.mjs'), entry);
  await using build = await rolldown({
    cwd: dir,
    input: path.join(dir, 'entry.mjs'),
    platform: 'node',
    logLevel: 'silent',
    plugins: [...plugins],
  });
  const { output } = await build.generate({ format: 'cjs' });
  return output[0].code;
}

describe('a bundle that loads node:process through createRequire(import.meta.url)', () => {
  afterEach(removeRoots);

  it("is handed the global by the stubbed node:module's require, under either spelling", async () => {
    const stubbed: string[] = [];
    const source = await bundledCjs(CREATING_ENTRY, [
      stubPlugin((specifier) => {
        stubbed.push(specifier);
      }),
    ]);
    const running = { env: { NEXT_RUNTIME: 'nodejs' } };
    const module = { exports: {} as Record<string, unknown> };
    // eslint-disable-next-line sonarjs/code-eval -- the bundle the adapter's plugin made, run to be tested
    runInNewContext(source, {
      module,
      exports: module.exports,
      __filename: '/bundle/app.cjs',
      process: running,
      require: functionRequire(workerdModule()),
    });

    expect(new Set(stubbed)).toStrictEqual(new Set(['module', 'node:module']));
    expect(module.exports['processModule']).toBe(running);
    expect(module.exports['prefixed']).toBe(running);
    expect(module.exports['other']).toStrictEqual({
      id: 'node:path',
      from: url.pathToFileURL('/bundle/app.cjs').href,
    });
    expect(module.exports['oneModule']).toBe(true);
  });
});

const runtimes: Miniflare[] = [];

/**
 * Each bundle loaded as a CommonJS module of a Worker on the Function's compatibility date and
 * flags, as the app bundle is: what it exports, or the message it failed to load with.
 */
async function loadedInWorkerd(bundles: Readonly<Record<string, string>>): Promise<unknown> {
  const names = Object.keys(bundles);
  const loads = names.map((name) => {
    const specifier = JSON.stringify(`./${name}`);
    return `try { loaded[${JSON.stringify(name)}] = (await import(${specifier})).default; } catch (error) { loaded[${JSON.stringify(name)}] = { error: error?.message }; }`;
  });
  const source = `export default {
    async fetch() {
      const loaded = {};
      ${loads.join('\n      ')}
      return Response.json(loaded);
    },
  };`;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'create-require',
      compatibilityDate: FUNCTION_COMPATIBILITY_DATE,
      compatibilityFlags: [...FUNCTION_COMPATIBILITY_FLAGS],
      modulesRoot: '/bundle',
      modules: [
        { type: 'ESModule', path: '/bundle/test.mjs', contents: source },
        ...names.map((name) => {
          const contents = bundles[name] ?? '';
          return { type: 'CommonJS' as const, path: `/bundle/${name}`, contents };
        }),
      ],
      cf: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      outboundService() {
        throw new Error('The createRequire tests cannot use outbound network');
      },
    }),
  );
  runtimes.push(runtime);
  const response = await runtime.dispatchFetch('https://create-require.test/', {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  return value;
}

/** A module that loads `node:process` through `createRequire` as it is evaluated, and no other way. */
const LOADING_ENTRY = `import { createRequire } from 'node:module';
export const isGlobal = createRequire(import.meta.url)('node:process') === globalThis.process;
`;

describe("workerd's require, under the Function's compatibility date and flags", () => {
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.dispose();
    await removeRoots();
  });

  it('loads the module once node:module is stubbed, which it cannot as it stands', async () => {
    const plain = await bundledCjs(LOADING_ENTRY, []);
    const stubbed = await bundledCjs(LOADING_ENTRY, [stubPlugin()]);

    await expect(
      loadedInWorkerd({ 'plain.cjs': plain, 'stubbed.cjs': stubbed }),
    ).resolves.toStrictEqual({
      'plain.cjs': { error: 'No such module "node:process".' },
      'stubbed.cjs': { isGlobal: true },
    });
  }, 20_000);
});

/** A project with Next.js's two modules, and an entry that requires both, as its server does. */
async function projectRequiringBoth(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'adapter-stubs-'));
  roots.push(dir);
  await writeFile(
    path.join(dir, 'entry.js'),
    "module.exports = [require('next/dist/compiled/ws'), require('next/dist/compiled/jsonwebtoken')];\n",
  );
  for (const name of ['ws', 'jsonwebtoken']) {
    const compiled = path.join(dir, 'node_modules', 'next', 'dist', 'compiled', name);
    await mkdir(compiled, { recursive: true });
    await writeFile(path.join(compiled, 'index.js'), `module.exports = { carried: '${name}' };\n`);
  }
  return dir;
}

async function bundledWith(
  previewData: boolean,
): Promise<{ readonly source: string; readonly stubbed: string[] }> {
  const dir = await projectRequiringBoth();
  const stubbed: string[] = [];
  await using build = await rolldown({
    cwd: dir,
    input: path.join(dir, 'entry.js'),
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      stubPlugin(
        (specifier) => {
          stubbed.push(specifier);
        },
        { previewData },
      ),
    ],
  });
  const { output } = await build.generate({ format: 'cjs' });
  return { source: output[0].code, stubbed };
}

/**
 * Two modules Next.js ships for code that cannot run in a Function: the WebSocket client it puts on
 * the global where there is none, which workerd never lacks, and — in a build with no Pages Router
 * route to sign any — the library that verifies preview data. Each resolves to a module that says
 * why it is not there if it is ever loaded, which is what the code around each require expects of a
 * module that cannot load.
 */
describe('the modules Next.js ships for code a Function cannot run', () => {
  afterEach(removeRoots);

  it("stands in for the WebSocket client under either of Next.js's names, and nothing else", () => {
    expect(isStubbedModule('next/dist/compiled/ws')).toBe(true);
    expect(isStubbedModule('next-10f02c336b0cb774/dist/compiled/ws')).toBe(true);
    expect(isStubbedModule('ws')).toBe(false);
    expect(isStubbedModule('an-sdk/dist/compiled/ws')).toBe(false);
  });

  it('leaves the preview-data library to the build, and refuses to load either, saying why', () => {
    expect(isStubbedModule('next/dist/compiled/jsonwebtoken')).toBe(false);
    expect(() => load('next/dist/compiled/ws')).toThrow(/workerd has a WebSocket of its own/u);
    expect(() => load('next/dist/compiled/jsonwebtoken')).toThrow(/no Pages Router route/u);
  });

  it('carries the preview-data library where the build has a Pages Router route', async () => {
    const { source, stubbed } = await bundledWith(true);

    expect(stubbed).toStrictEqual(['next/dist/compiled/ws']);
    // Rolldown writes the fake modules' strings in quotes of its own choosing.
    expect(source).toMatch(/carried: ["']jsonwebtoken["']/u);
    expect(source).not.toMatch(/carried: ["']ws["']/u);
  });

  it('carries neither where it has none', async () => {
    const { source, stubbed } = await bundledWith(false);

    expect(stubbed.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
      'next/dist/compiled/jsonwebtoken',
      'next/dist/compiled/ws',
    ]);
    expect(source).not.toContain('carried:');
    expect(source).toContain('no Pages Router route to set preview data');
  });
});
