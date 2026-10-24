import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

import { isStubbedModule, stubSourceFor } from '../src/patches/loader-hooks.ts';
import { stubPlugin } from '../src/patches/rolldown.ts';

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

/** A project with Next.js's two modules, and an entry that requires both, as its server does. */
async function projectRequiringBoth(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'adapter-stubs-'));
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
