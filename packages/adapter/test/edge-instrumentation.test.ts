import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { rolldown } from 'rolldown';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkedEdgeInstrumentationModules,
  edgeInstrumentationFiles,
  edgeInstrumentationOf,
  edgeInstrumentationSource,
} from '../src/edge-instrumentation.ts';
import { bundleEdge, edgeBundleOptions, edgeEntrySource, type EdgeEntry } from '../src/edge.ts';

interface Hook {
  readonly marker?: string;
  readonly register?: (...args: unknown[]) => unknown;
  readonly onRequestError?: (...args: unknown[]) => unknown;
}

interface Setup {
  readonly finish: () => void;
  readonly fail: (error: unknown) => void;
}

interface Registry {
  middleware_instrumentation?: Hook | Promise<Hook>;
}

function hookOf(registry: Registry): Promise<Hook | undefined> {
  return Promise.resolve(registry.middleware_instrumentation);
}

function compiled(
  hosts: readonly (() => Hook)[],
  own = true,
): {
  readonly install: (registry: Registry) => Setup;
  readonly log: ReturnType<typeof vi.fn>;
} {
  const output = { exports: undefined };
  const log = vi.fn();
  // eslint-disable-next-line sonarjs/code-eval -- Only adapter-generated source runs, with stubbed module imports.
  runInNewContext(
    edgeInstrumentationSource(
      hosts.map((_, index) => String(index)),
      own,
    ),
    {
      module: output,
      console: { error: log },
      require: (name: string) => hosts[Number(name)]?.(),
    },
  );
  return { install: output.exports as unknown as (registry: Registry) => Setup, log };
}

describe('edge host instrumentation composition', () => {
  it('captures early Next reads and awaits one host-first registration without losing the Edge hook', async () => {
    const order: string[] = [];
    const { promise: pendingHost, resolve: releaseHost } = Promise.withResolvers<undefined>();
    const ownRegister = vi.fn(function ownRegistration(this: Hook) {
      expect(this.marker).toBe('compiled-edge');

      order.push('own');
    });
    const { install } = compiled([
      () => {
        return {
          register: async () => {
            order.push('host');
            await pendingHost;
          },
        };
      },
    ]);
    const registry: Registry = {};
    const setup = install(registry);
    // next/server may start this read while the project's instrumentation module is evaluating.
    const early = Promise.resolve(registry.middleware_instrumentation);
    let resolved = false;
    const observed = (async () => {
      await early;
      resolved = true;
    })();
    await Promise.resolve();

    expect(resolved).toBe(false);

    registry.middleware_instrumentation = Promise.resolve({
      marker: 'compiled-edge',
      register: ownRegister,
    });
    setup.finish();
    const hook = await early;
    await observed;
    const first = hook?.register?.();
    const second = hook?.register?.();

    expect(first).toBe(second);

    await Promise.resolve();

    expect(order).toStrictEqual(['host']);

    releaseHost(undefined);
    await first;

    expect(order).toStrictEqual(['host', 'own']);
    expect(ownRegister).toHaveBeenCalledExactlyOnceWith();
    expect((await hookOf(registry))?.marker).toBe('compiled-edge');
    expect(
      Object.hasOwn(
        Object.getOwnPropertyDescriptor(registry, 'middleware_instrumentation') ?? {},
        'get',
      ),
    ).toBe(false);
  });

  it('isolates host load and hook failures and preserves the original own error, arguments and receiver', async () => {
    const original = new Error('own hook failed');
    const args = [new Error('request failed'), { path: '/?q=one' }, { routeType: 'proxy' }];
    const order: string[] = [];
    const own: Hook = {
      onRequestError: function onRequestError(this: Hook, ...received) {
        expect(this).toBe(own);
        expect(received).toStrictEqual(args);

        order.push('own');
        throw original;
      },
    };
    const { install, log } = compiled([
      () => {
        throw new Error('host load failed');
      },
      () => {
        return {
          onRequestError() {
            order.push('host');
            throw new Error('host hook failed');
          },
        };
      },
    ]);
    const registry: Registry = {};
    const setup = install(registry);
    registry.middleware_instrumentation = own;
    setup.finish();
    const hook = await hookOf(registry);

    await expect(hook?.onRequestError?.(...args)).rejects.toBe(original);
    expect(order).toStrictEqual(['host', 'own']);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('keeps a rejected own register rejected and does not rerun it', async () => {
    const original = new Error('own registration failed');
    const register = vi.fn(() => Promise.reject(original));
    const { install } = compiled([() => ({ register: () => Promise.resolve() })]);
    const registry: Registry = {};
    const setup = install(registry);
    registry.middleware_instrumentation = { register };
    setup.finish();
    const hook = await hookOf(registry);

    await expect(hook?.register?.()).rejects.toBe(original);
    await expect(hook?.register?.()).rejects.toBe(original);
    expect(register).toHaveBeenCalledExactlyOnceWith();
  });

  it('handles registration started by a host import and still runs the own hook after a host failure', async () => {
    const registry: Registry = {};
    const order: string[] = [];
    let early: Promise<unknown> | undefined;
    const { install, log } = compiled([
      () => {
        early = (async () => {
          const hook = await hookOf(registry);
          return hook?.register?.();
        })();
        return {
          register() {
            order.push('host');
            throw new Error('host register failed');
          },
        };
      },
    ]);
    const setup = install(registry);
    registry.middleware_instrumentation = {
      register() {
        order.push('own');
      },
    };
    setup.finish();
    await early;

    expect(order).toStrictEqual(['host', 'own']);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "upwind: the host's register failed",
      expect.objectContaining({ message: 'host register failed' }),
    );
  });

  it('provides the host hook when the project has none', async () => {
    const register = vi.fn();
    const { install } = compiled([() => ({ register })], false);
    const registry: Registry = {};
    const setup = install(registry);
    setup.finish();
    const hook = await hookOf(registry);
    await hook?.register?.();

    expect(register).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates a rejected original module to an early reader', async () => {
    const original = new Error('original initialization failed');
    const { install } = compiled([]);
    const registry: Registry = {};
    const setup = install(registry);
    const early = Promise.resolve(registry.middleware_instrumentation);
    registry.middleware_instrumentation = Promise.reject(original);
    setup.finish();

    await expect(early).rejects.toBe(original);
  });

  it('preserves a synchronous original initialization failure', async () => {
    const original = new Error('chunk evaluation failed');
    const { install } = compiled([]);
    const registry: Registry = {};
    const setup = install(registry);
    const early = Promise.resolve(registry.middleware_instrumentation);
    setup.fail(original);

    await expect(early).rejects.toBe(original);
  });

  it.each([0, 2])(
    'refuses %i own registrations instead of silently omitting or replacing one',
    async (count) => {
      const { install } = compiled([]);
      const registry: Registry = {};
      const setup = install(registry);
      for (let index = 0; index < count; index += 1) registry.middleware_instrumentation = {};

      expect(() => {
        setup.finish();
      }).toThrow('registration count');
      await expect(registry.middleware_instrumentation).rejects.toThrow('registration count');
    },
  );

  it('refuses instrumentation that already ran before the host could be composed', () => {
    const { install } = compiled([]);

    expect(() => install({ middleware_instrumentation: {} })).toThrow('loaded before composition');
  });
});

describe('edge instrumentation build boundaries', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([
    { hostInstrumentation: false, target: 'node-target', other: 'edge-target' },
    { hostInstrumentation: true, target: 'edge-target', other: 'node-target' },
  ])(
    'resolves host packages for the intended runtime: $target',
    async ({ hostInstrumentation, target, other }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'upwind-edge-resolution-'));
      temporary.push(root);
      const fixture = path.join(root, 'node_modules', 'conditional-host');
      const legacy = path.join(root, 'node_modules', 'legacy-host');
      await mkdir(fixture, { recursive: true });
      await mkdir(legacy, { recursive: true });
      await writeFile(
        path.join(fixture, 'package.json'),
        JSON.stringify({
          exports: { node: './node.cjs', 'edge-light': './edge.cjs', default: './node.cjs' },
        }),
      );
      await writeFile(path.join(fixture, 'node.cjs'), 'module.exports = "node-target";');
      await writeFile(path.join(fixture, 'edge.cjs'), 'module.exports = "edge-target";');
      const formatFixture = path.join(root, 'node_modules', 'format-host');
      await mkdir(formatFixture, { recursive: true });
      await writeFile(
        path.join(formatFixture, 'package.json'),
        JSON.stringify({ exports: { import: './import.mjs', require: './require.cjs' } }),
      );
      await writeFile(path.join(formatFixture, 'import.mjs'), 'export default "import-target";');
      await writeFile(
        path.join(formatFixture, 'require.cjs'),
        'module.exports = "require-target";',
      );
      await writeFile(
        path.join(root, 'esm-host.mjs'),
        'import value from "format-host"; export default value;',
      );
      await writeFile(path.join(legacy, 'package.json'), JSON.stringify({ main: './main.cjs' }));
      await writeFile(path.join(legacy, 'main.cjs'), 'module.exports = "legacy-main-target";');
      const entry = path.join(root, 'entry.cjs');
      await writeFile(
        entry,
        'module.exports = [require("conditional-host"), require("format-host"), require("./esm-host.mjs"), require("legacy-host"), require("node:async_hooks"), require("fs")];',
      );
      const external = vi.fn();
      await using build = await rolldown(
        edgeBundleOptions(root, entry, external, { hostInstrumentation }),
      );
      const { output } = await build.generate({ format: 'cjs' });
      const chunk = output.find((item) => item.type === 'chunk');

      expect(chunk?.code).toContain(target);
      expect(chunk?.code).not.toContain(other);
      expect(chunk?.code).toContain('legacy-main-target');
      expect(chunk?.code).toContain('import-target');
      expect(chunk?.code).toContain('require-target');
      expect(external).toHaveBeenCalledTimes(2);
      expect(external).toHaveBeenCalledWith('fs');
      expect(external).toHaveBeenCalledWith('node:async_hooks');
    },
  );

  it('carries a dynamically imported host SDK in the single emitted Edge module', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upwind-edge-dynamic-'));
    temporary.push(root);
    const distDir = path.join(root, '.next');
    await mkdir(distDir);
    const entry = path.join(distDir, 'entry.js');
    const module = path.join(root, 'host.cjs');
    const sdk = path.join(root, 'host-sdk.mjs');
    await writeFile(entry, 'globalThis._ENTRIES.middleware = { handler() {} };');
    await writeFile(sdk, 'export const marker = "dynamic-sdk-target";');
    await writeFile(
      module,
      'module.exports = () => ({ finish() { return import("./host-sdk.mjs"); }, fail(error) { throw error; } });',
    );
    const entrySpec: EdgeEntry = {
      id: '/_middleware',
      entryKey: 'middleware',
      handlerExport: 'handler',
      files: [entry],
      env: {},
      wasm: [],
      inlineAssets: [],
    };
    const result = await bundleEdge({
      kind: 'middleware',
      projectDir: root,
      distDir,
      workDir: root,
      entries: [entrySpec],
      instrumentation: { module, files: [], own: false },
    });

    await expect(readFile(result.outFile, 'utf8')).resolves.toContain('dynamic-sdk-target');
    expect(result.trace.inputs.some((input) => input.file.endsWith('/host-sdk.mjs'))).toBe(true);
  });

  it('keeps the existing emitted Edge entry bytes when the new option is absent', () => {
    expect(checkedEdgeInstrumentationModules(undefined)).toStrictEqual([]);

    const entry: EdgeEntry = {
      id: '/_middleware',
      entryKey: 'middleware',
      handlerExport: 'handler',
      files: ['/project/.next/server/edge/middleware.js'],
      env: {},
      wasm: [],
      inlineAssets: [],
    };
    // Computed independently from the pre-option entry generator at 824e7f4e.
    const source = edgeEntrySource([entry], '/project', '/project/.next');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'e98f52a1955c9856ac54e482caaaa3ddbdc577c2bf7f4009f7e623fc5c0dc2fb',
    );
  });

  it.each([
    { value: null },
    { value: '/host.js' },
    { value: ['relative.js'] },
    { value: [7] },
    { value: ['/host\0.js'] },
  ])('refuses invalid explicit Edge module paths: $value', ({ value }) => {
    expect(() => checkedEdgeInstrumentationModules(value)).toThrow('absolute module paths');
  });

  it('captures only the explicitly supplied Edge module list', () => {
    const paths = ['/host-edge.js'];
    const selected = checkedEdgeInstrumentationModules(paths);
    paths.push('/later-node-world.js');

    expect(selected).toStrictEqual(['/host-edge.js']);
  });

  it.each([
    {},
    { instrumentation: { files: [] } },
    { instrumentation: { files: ['../escape.js'] } },
    { instrumentation: { files: ['/outside.js'] } },
  ])('refuses an unknown or escaping manifest shape', (raw) => {
    expect(() => edgeInstrumentationFiles(raw, '/build/.next')).toThrow(
      'unsupported Edge instrumentation manifest',
    );
  });

  it('leaves builds without hosts or Edge outputs untouched, and refuses omitted own assets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'upwind-edge-hook-'));
    temporary.push(root);
    const distDir = path.join(root, '.next');
    const outDir = path.join(root, '.out');
    await mkdir(path.join(distDir, 'server', 'instrumentation'), { recursive: true });
    await mkdir(outDir);
    await writeFile(path.join(distDir, 'server', 'instrumentation.js'), 'node hook');
    await writeFile(
      path.join(distDir, 'server', 'instrumentation', 'middleware-manifest.json'),
      JSON.stringify({ instrumentation: { files: ['server/edge/hook.js'] } }),
    );
    const entry: EdgeEntry = {
      id: '/_middleware',
      entryKey: 'middleware',
      handlerExport: 'handler',
      files: [],
      wasm: [],
      inlineAssets: [],
      env: {},
    };

    await expect(
      edgeInstrumentationOf({ distDir, outDir, entries: [entry], hosts: [] }),
    ).resolves.toBeUndefined();
    await expect(
      edgeInstrumentationOf({ distDir, outDir, entries: [], hosts: ['host.js'] }),
    ).resolves.toBeUndefined();
    await expect(
      edgeInstrumentationOf({ distDir, outDir, entries: [entry], hosts: ['host.js'] }),
    ).rejects.toThrow('does not begin with its instrumentation files');

    const files = [path.join(distDir, 'server', 'edge', 'hook.js')];
    const hook = await edgeInstrumentationOf({
      distDir,
      outDir,
      entries: [{ ...entry, files }],
      hosts: ['host.js'],
    });

    expect(hook?.files).toStrictEqual(files);
    expect(hook?.own).toBe(true);
  });
});
