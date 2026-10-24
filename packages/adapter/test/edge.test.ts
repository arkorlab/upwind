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
});
