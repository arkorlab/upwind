import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type Plugin, rolldown } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generatedModulesPlugin } from '../src/generated-modules.ts';

const HOST = '/project/host.mjs';
const REQUIRED = '\0arkor:cache-host-with-blob-reader';
const READER = 'createBundleBlobReader';
const ERROR = /statically named ESM createBundleBlobReader/u;
const CACHE = 'export function createCacheHost() { return undefined; }';
const BOTH = `${CACHE} export function createBundleBlobReader() { return undefined; }`;

interface LinkedCase {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

function plugin(required: boolean, hostModule: string | undefined = HOST): Plugin {
  return generatedModulesPlugin({
    modules: { app: 'app.cjs', edge: 'edge.cjs' },
    edge: false,
    wasm: false,
    cacheHostModule: hostModule,
    requireBundleBlobReader: required,
  });
}

async function invoke(
  hook: unknown,
  context: Record<string, unknown>,
  args: unknown[] = [],
): Promise<unknown> {
  if (typeof hook !== 'function') throw new TypeError('Expected the plugin hook');
  const pending: unknown = Reflect.apply(hook, context, args);
  return await pending;
}

describe('required reader plugin hooks', () => {
  it('keeps the default host mapping without imposing the new export contract', async () => {
    await expect(invoke(plugin(false).resolveId, {}, ['arkor:cache-host'])).resolves.toBe(HOST);
    await expect(invoke(plugin(false).buildEnd, {})).resolves.toBeUndefined();
  });

  it('names a real reexport without evaluating or inserting the supplied path as code', async () => {
    const host = '/project/host";throw new Error("unexpected").mjs';
    const required = plugin(true, host);

    await expect(invoke(required.resolveId, {}, ['arkor:cache-host'])).resolves.toBe(REQUIRED);
    await expect(invoke(required.load, {}, [REQUIRED])).resolves.toBe(
      `export * from ${JSON.stringify(host)};export { ${READER} } from ${JSON.stringify(host)};`,
    );
  });

  it.each(['cjs', 'unknown', undefined])(
    'refuses an unprovable direct host format %s',
    async (inputFormat) => {
      const required = plugin(true);
      const context = {
        resolve: () => Promise.resolve({ id: HOST, external: false }),
        getModuleInfo: () => ({ inputFormat }),
      };
      await invoke(required.resolveId, context, [HOST, REQUIRED, {}]);

      await expect(invoke(required.buildEnd, context)).rejects.toThrow(ERROR);
    },
  );

  it('accepts the resolved direct ESM format without invoking the host', async () => {
    const required = plugin(true);
    const context = {
      resolve: () => Promise.resolve({ id: HOST, external: false }),
      getModuleInfo: () => ({ inputFormat: 'es' }),
    };
    await invoke(required.resolveId, context, [HOST, REQUIRED, {}]);

    await expect(invoke(required.buildEnd, context)).resolves.toBeUndefined();
  });

  it.each([null, { id: HOST, external: true }])(
    'refuses an unresolved or external host %j',
    async (resolution) => {
      const required = plugin(true);
      const context = { resolve: () => Promise.resolve(resolution) };

      await expect(invoke(required.resolveId, context, [HOST, REQUIRED, {}])).rejects.toThrow(
        ERROR,
      );
    },
  );
});

describe('required reader through the actual runtime bundler plugin', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'upwind-reader-export-'));
    await writeFile(
      path.join(directory, 'entry.mjs'),
      'import * as host from "arkor:cache-host"; export const selected = host;',
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function emit(files: Readonly<Record<string, string>>, required = true): Promise<string> {
    for (const [name, code] of Object.entries(files))
      await writeFile(path.join(directory, name), code);
    const hostName = Object.keys(files)[0];
    if (hostName === undefined) throw new Error('A host source is required');
    await using bundle = await rolldown({
      input: path.join(directory, 'entry.mjs'),
      platform: 'node',
      plugins: [plugin(required, path.join(directory, hostName))],
      onLog() {
        // Assertions use fatal linking failures, without printing expected missing-name warnings.
      },
    });
    const { output } = await bundle.generate({ format: 'esm' });
    return output.map((item) => (item.type === 'chunk' ? item.code : '')).join('\n');
  }

  it.each<LinkedCase>([
    { name: 'direct ESM', files: { 'host.mjs': BOTH } },
    {
      name: 'TypeScript',
      files: {
        'host.ts': `${CACHE} export function createBundleBlobReader(_input: unknown) { return undefined; }`,
      },
    },
    {
      name: 'named alias reexport',
      files: {
        'host.mjs': `${CACHE} export { reader as createBundleBlobReader } from './reader.mjs';`,
        'reader.mjs': 'export function reader() { return undefined; }',
      },
    },
    {
      name: 'named reexport',
      files: {
        'host.mjs': `${CACHE} export { createBundleBlobReader } from './reader.mjs';`,
        'reader.mjs': 'export function createBundleBlobReader() { return undefined; }',
      },
    },
    {
      name: 'star reexport',
      files: { 'host.mjs': "export * from './reader.mjs';", 'reader.mjs': BOTH },
    },
    {
      name: 'throwing top level without execution',
      files: { 'host.mjs': `throw new Error('host must not execute during build'); ${BOTH}` },
    },
  ])('links the $name contract without evaluating it', async ({ files }) => {
    await expect(emit(files)).resolves.toContain(READER);
  });

  it('rejects a legacy ESM host only when omission is enabled', async () => {
    await expect(emit({ 'host.mjs': CACHE })).rejects.toThrow(READER);
    await expect(emit({ 'host.mjs': CACHE }, false)).resolves.toContain('createCacheHost');
  });

  it('refuses direct CommonJS even when interop could synthesize the requested name', async () => {
    await expect(
      emit({
        'host.cjs':
          'exports.createCacheHost = () => undefined; exports.createBundleBlobReader = () => undefined;',
      }),
    ).rejects.toThrow(ERROR);
  });

  it('does not accept a type-only TypeScript export as the runtime reader', async () => {
    await expect(
      emit({ 'host.ts': `${CACHE} export type createBundleBlobReader = () => undefined;` }),
    ).rejects.toThrow(READER);
  });

  it('lets the bundler reject ambiguous star reexports', async () => {
    await expect(
      emit({
        'host.mjs': `${CACHE} export * from './one.mjs'; export * from './two.mjs';`,
        'one.mjs': 'export function createBundleBlobReader() {}',
        'two.mjs': 'export function createBundleBlobReader() {}',
      }),
    ).rejects.toThrow(READER);
  });
});
