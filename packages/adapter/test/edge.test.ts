import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type EdgeEntry, edgeBundleOptions, edgeEntrySource } from '../src/edge.ts';

/**
 * The Worker's edge bundle: the table that loads an entrypoint built for Next.js's edge runtime.
 * The generated module is required here and its thunks are called, so what is checked is what the
 * Worker does — the chunks evaluated in the order Next.js lists them, and only when a request
 * needs them — and not a reading of the source.
 */

const ENTRY_KEY = 'middleware_app/api/og/route';

interface EdgeTable {
  readonly entries: Readonly<Record<string, () => { readonly handler: () => string }>>;
}

interface Evaluated {
  evaluated?: string[];
}

describe('edgeEntrySource', () => {
  let dir: string;
  /** The build id an entry's `env` sets for the process, as it was before the case set it (greptile). */
  let buildId: string | undefined;

  beforeEach(async () => {
    buildId = process.env['__NEXT_BUILD_ID'];
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-edge-'));
    Reflect.set(globalThis, 'evaluated', []);
    Reflect.deleteProperty(globalThis, '_ENTRIES');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    Reflect.deleteProperty(globalThis, 'evaluated');
    Reflect.deleteProperty(globalThis, '_ENTRIES');
    Reflect.deleteProperty(globalThis, '__SERVER_FILES_MANIFEST');
    if (buildId === undefined) {
      Reflect.deleteProperty(process.env, '__NEXT_BUILD_ID');
    } else {
      process.env['__NEXT_BUILD_ID'] = buildId;
    }
  });

  /** A chunk as Turbopack writes one: a script that marks that it ran, and may register an entry. */
  async function chunk(name: string, registers: boolean): Promise<string> {
    const file = path.join(dir, name);
    const register = registers
      ? `(globalThis._ENTRIES ||= {})[${JSON.stringify(ENTRY_KEY)}] = { handler: () => "answered" };`
      : '';
    await writeFile(file, `globalThis.evaluated.push(${JSON.stringify(name)});\n${register}\n`);
    return file;
  }

  async function table(entry: EdgeEntry): Promise<EdgeTable> {
    const file = path.join(dir, 'edge.cjs');
    await writeFile(file, edgeEntrySource([entry], dir, path.join(dir, '.next')));
    return createRequire(file)(file) as EdgeTable;
  }

  it('evaluates the chunks of an entry in order, on the first request for it, and not before', async () => {
    const files = [await chunk('dep.js', false), await chunk('entry.js', true)];
    const loaded = await table({
      id: '/api/og',
      entryKey: ENTRY_KEY,
      handlerExport: 'handler',
      files,
      wasm: [],
      inlineAssets: [],
      env: { __NEXT_BUILD_ID: 'build-1' },
    });

    // The Worker has the table; nothing of the application has run.
    expect(Object.keys(loaded.entries)).toStrictEqual(['/api/og']);
    expect((globalThis as Evaluated).evaluated).toStrictEqual([]);

    const { handler } = loaded.entries['/api/og']!();

    expect((globalThis as Evaluated).evaluated).toStrictEqual(['dep.js', 'entry.js']);
    expect(process.env['__NEXT_BUILD_ID']).toBe('build-1');
    expect(handler()).toBe('answered');
  });

  /**
   * `next build` writes the configuration the chunks publish as trusting the `Host` only on a
   * deployment target it recognizes; an entrypoint on the edge runtime named `localhost` for its
   * own URL without it.
   */
  it('publishes the configuration as trusting the Host a request carries', async () => {
    const file = path.join(dir, 'required-server-files.js');
    const manifest = { version: 1, config: { experimental: { trustHostHeader: false } } };
    // `self`, in the Worker; this is Node.js.
    await writeFile(file, `globalThis.__SERVER_FILES_MANIFEST = ${JSON.stringify(manifest)};\n`);
    const loaded = await table({
      id: '/api/og',
      entryKey: ENTRY_KEY,
      handlerExport: 'handler',
      files: [file, await chunk('entry.js', true)],
      wasm: [],
      inlineAssets: [],
      env: {},
    });

    loaded.entries['/api/og']!();

    expect(Reflect.get(globalThis, '__SERVER_FILES_MANIFEST')).toStrictEqual({
      version: 1,
      config: { experimental: { trustHostHeader: true } },
    });
  });

  /**
   * A chunk fetches a file of its own entry as `blob:<name>` — the font an image is drawn with —
   * which Next.js's edge runtime answers from the function's files, and workerd cannot fetch.
   */
  it('answers a fetch of a file its entries carry, and leaves any other fetch alone', async () => {
    const beneath = vi.fn<typeof fetch>(() => Promise.resolve(new Response('from the network')));
    vi.stubGlobal('fetch', beneath);
    const FONT_PATH = '/bundle/.next/server/edge/assets/font.ttf';
    const readFile = fs.readFileSync.bind(fs);
    // Only the Worker has a `/bundle`: the file is read from there, and everything else as it is.
    function asInTheWorker(...args: Parameters<typeof fs.readFileSync>) {
      return args[0] === FONT_PATH ? Buffer.from('font bytes') : readFile(...args);
    }
    const read = vi.spyOn(fs, 'readFileSync').mockImplementation(asInTheWorker);
    try {
      await table({
        id: '/api/og',
        entryKey: ENTRY_KEY,
        handlerExport: 'handler',
        files: [await chunk('entry.js', true)],
        wasm: [],
        inlineAssets: [
          {
            name: 'server/edge/assets/font.ttf',
            filePath: path.join(dir, '.next/server/edge/assets/font.ttf'),
          },
        ],
        env: {},
      });

      const font = await fetch('blob:server/edge/assets/font.ttf');
      const other = await fetch('https://example.test/data');

      await expect(font.text()).resolves.toBe('font bytes');
      expect(read).toHaveBeenCalledWith(FONT_PATH);
      await expect(other.text()).resolves.toBe('from the network');
      expect(beneath).toHaveBeenCalledExactlyOnceWith('https://example.test/data', undefined);
    } finally {
      read.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('names the entry that registered nothing, rather than handing back an empty one', async () => {
    const loaded = await table({
      id: '/api/og',
      entryKey: ENTRY_KEY,
      handlerExport: 'handler',
      files: [await chunk('dep.js', false)],
      wasm: [],
      inlineAssets: [],
      env: {},
    });

    expect(() => loaded.entries['/api/og']!()).toThrow(`${ENTRY_KEY} registered no edge entry`);
  });
});

describe('edgeBundleOptions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'adapter-edge-bundle-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * The runtime the edge bundle is compiled for is the whole reason it is a bundle of its own:
   * `app.cjs` pins `process.env.NEXT_RUNTIME` to `"nodejs"`, which is the test Next.js's edge
   * code branches on.
   */
  it('pins the runtime to the edge, and reports what is left to the Worker', async () => {
    const entry = path.join(dir, 'entry.cjs');
    await writeFile(
      entry,
      'module.exports = { runtime: process.env.NEXT_RUNTIME, hooks: require("node:async_hooks") };\n',
    );
    const externals: string[] = [];
    await using bundle = await rolldown(
      edgeBundleOptions(dir, entry, (specifier) => {
        externals.push(specifier);
      }),
    );
    const { output } = await bundle.generate({ format: 'cjs' });

    expect(output[0].code).toContain('"edge"');
    expect(output[0].code).not.toContain('process.env.NEXT_RUNTIME');
    expect(externals).toStrictEqual(['node:async_hooks']);
  });

  /** The edge bundle built from `entry`, required as the Function requires it. */
  async function built(entry: string, chunks: readonly string[]): Promise<unknown> {
    await using bundle = await rolldown(
      edgeBundleOptions(
        dir,
        entry,
        () => {
          // Nothing here is left to the Worker.
        },
        { chunks },
      ),
    );
    const file = path.join(dir, 'edge.cjs');
    await bundle.write({ format: 'cjs', file });
    return createRequire(file)(file);
  }

  /**
   * Next.js's edge runtime hands its chunks a `process` with the environment and nothing of
   * Node.js's, and code tells the runtimes apart by it (`switchable-runtime`); the Function's own
   * `process` named its Node.js version on an edge page.
   */
  it("gives the chunks the edge runtime's process, and leaves everything else the Function's", async () => {
    const chunk = path.join(dir, 'chunk.js');
    await writeFile(
      chunk,
      [
        // As Next.js's edge globals do: the `process` a chunk sees is made the global one.
        'if (process !== globalThis.process) { globalThis.process = process; }',
        '(globalThis.TURBOPACK ||= []).push(() => {',
        '  function own() {',
        '    const process = { version: "a binding of its own" };',
        '    return process.version;',
        '  }',
        '  let thrown;',
        '  try { process.nextTick(() => {}); } catch (error) { thrown = error.message; }',
        '  return {',
        "    runtime: process.version ? 'Node.js ' + process.version : 'Edge/Browser',",
        '    platform: process.platform,',
        '    env: process.env.UPWIND_EDGE_PROCESS_CASE,',
        '    pinned: process.env.NEXT_RUNTIME,',
        '    own: own(),',
        '    thrown,',
        '  };',
        '});',
        '',
      ].join('\n'),
    );
    const host = path.join(dir, 'host.cjs');
    await writeFile(host, 'module.exports = () => process.version;\n');
    const entry = path.join(dir, 'entry.cjs');
    await writeFile(
      entry,
      'require("./chunk.js");\nmodule.exports = { chunk: globalThis.TURBOPACK.at(-1), host: require("./host.cjs") };\n',
    );
    const global = process;
    vi.stubEnv('UPWIND_EDGE_PROCESS_CASE', 'read');
    try {
      const loaded = (await built(entry, [chunk])) as {
        chunk: () => Record<string, unknown>;
        host: () => string;
      };

      expect(loaded.chunk()).toStrictEqual({
        runtime: 'Edge/Browser',
        platform: undefined,
        env: 'read',
        pinned: 'edge',
        own: 'a binding of its own',
        thrown:
          'A Node.js API is used (process.nextTick) which is not supported in the Edge Runtime.\nLearn more: https://nextjs.org/docs/api-reference/edge-runtime',
      });
      expect(process).toBe(global);
      expect(loaded.host()).toBe(process.version);
    } finally {
      vi.unstubAllEnvs();
      Reflect.deleteProperty(globalThis, 'TURBOPACK');
    }
  });

  it('leaves a chunk that reads nothing of Node.js as Turbopack wrote it', async () => {
    const chunk = path.join(dir, 'chunk.js');
    await writeFile(chunk, 'module.exports = process.env.HOME;\n');
    const entry = path.join(dir, 'entry.cjs');
    await writeFile(entry, 'module.exports = require("./chunk.js");\n');
    await using bundle = await rolldown(
      edgeBundleOptions(
        dir,
        entry,
        () => {
          // Nothing here is left to the Worker.
        },
        { chunks: [chunk] },
      ),
    );
    const { output } = await bundle.generate({ format: 'cjs' });

    expect(output[0].code).not.toContain('upwind:edge-process');
    expect(output[0].code).toContain('process.env.HOME');
  });
});
