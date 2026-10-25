import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assertNodeManifestTurbopackRuntime,
  type NodeManifestTurbopackRuntimeInput,
} from '../src/node-manifest-turbopack-runtime.ts';

const DIST_DIR = '/work/project/.next';
const ROOT_DIR = '/work/project';
const RUNTIME_FILE = `${DIST_DIR}/server/chunks/[turbopack]_runtime.js`;
const PREFIX = [
  'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
  'var RELATIVE_ROOT_PATH = "..";',
  'var ASSET_PREFIX = "/";',
].join('\n');
const FORWARDED_GLOBALS = `if (typeof require !== 'undefined') {
  try {
    var { workerData } = require('worker_threads');
    if (workerData?.__turbopack_globals__) {
      Object.assign(globalThis, workerData.__turbopack_globals__);
      delete workerData.__turbopack_globals__;
    }
  } catch (_) {}
}`;
function source(code: string): { code: string; sha256: string } {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
async function input(
  options: {
    readonly asyncModules?: boolean;
    readonly renamedModule?: boolean;
    readonly forwardedGlobals?: boolean;
  } = {},
): Promise<NodeManifestTurbopackRuntimeInput> {
  const primary = await readFile(
    new URL('fixtures/node-runtime/production.txt', import.meta.url),
    'utf8',
  );
  let body = primary.split('\n').slice(3).join('\n');
  if (options.asyncModules === true) {
    let async = await readFile(
      new URL('fixtures/node-runtime/async-module.txt', import.meta.url),
      'utf8',
    );
    if (options.renamedModule === true) async = async.replaceAll(/\bmodule\b/gu, 'module1');
    const insertion = body.indexOf('async function externalImport(id) {');
    if (insertion === -1) throw new Error('Missing fixed shared-runtime composition point');
    body = `${body.slice(0, insertion)}${async}\n${body.slice(insertion)}`;
  }
  const preamble = options.forwardedGlobals === true ? `${FORWARDED_GLOBALS}\n` : '';
  const code = `${PREFIX}\n${preamble}${body}`;
  return { source: source(code), file: RUNTIME_FILE, distDir: DIST_DIR, rootDir: ROOT_DIR };
}
function changed(
  current: NodeManifestTurbopackRuntimeInput,
  before: string,
  after: string,
): NodeManifestTurbopackRuntimeInput {
  const code = current.source.code.replace(before, () => after);
  if (code === current.source.code)
    throw new Error('The intended primary-source mutation did not occur');
  return { ...current, source: source(code) };
}

describe('fixed producer-derived Turbopack Node runtime', () => {
  it.each([
    { asyncModules: false },
    { asyncModules: true },
    { asyncModules: true, renamedModule: true },
    { asyncModules: true, forwardedGlobals: true },
  ])('seals the complete fixed runtime semantics for %j', async (options) => {
    const own = await input(options);
    const proof = assertNodeManifestTurbopackRuntime(own);

    expect(proof.file).toBe(RUNTIME_FILE);
    expect([proof.runtimeRoot, proof.rootDir, proof.assetPrefix]).toStrictEqual([
      DIST_DIR,
      ROOT_DIR,
      '/',
    ]);
    expect(proof.sha256).toBe(own.source.sha256);
    expect([proof.asyncModules, Object.isFrozen(proof)]).toStrictEqual([
      options.asyncModules,
      true,
    ]);
  });

  it('accepts source formatting without allowing a changed runtime operation', async () => {
    const own = await input();
    const candidate = { ...own, source: source(`// Source inspection only\n${own.source.code}\n`) };

    expect(assertNodeManifestTurbopackRuntime(candidate).sha256).toBe(candidate.source.sha256);
  });

  it.each([
    [
      'context import',
      'contextPrototype.x = externalRequire',
      'contextPrototype.x = externalImport',
    ],
    [
      'factory arguments',
      'moduleFactory(context, module1, exports)',
      'moduleFactory(module1, context, exports)',
    ],
    ['module lookup', 'moduleFactories.get(id)', 'moduleFactories.get(0)'],
    [
      'namespace export',
      'contextPrototype.n = exportNamespace',
      'contextPrototype.n = exportValue',
    ],
    [
      'chunk root',
      'path.resolve(RUNTIME_ROOT, chunkPath)',
      'path.resolve(ABSOLUTE_ROOT, chunkPath)',
    ],
  ])('refuses a changed %s even when its new SHA is supplied', async (_title, before, after) => {
    const own = await input();
    const candidate = changed(own, before, after);

    expect(() => assertNodeManifestTurbopackRuntime(candidate)).toThrow(
      'changed production context semantics',
    );
  });

  it('refuses unknown appended code and a changed optional worker preamble', async () => {
    const own = await input({ forwardedGlobals: true });
    const extra = { ...own, source: source(`${own.source.code}\nglobalThis.ctx = Context;`) };
    const forwarded = changed(
      own,
      'Object.assign(globalThis, workerData.__turbopack_globals__)',
      'Object.defineProperties(globalThis, workerData.__turbopack_globals__)',
    );

    expect(() => assertNodeManifestTurbopackRuntime(extra)).toThrow(
      'changed production context semantics',
    );
    expect(() => assertNodeManifestTurbopackRuntime(forwarded)).toThrow(
      'forwarded globals preamble',
    );
  });

  it.each([
    ['public path', 'server/chunks/[turbopack]_runtime.js', 'other/[turbopack]_runtime.js'],
    ['root', 'var RELATIVE_ROOT_PATH = "..";', 'var RELATIVE_ROOT_PATH = "../..";'],
    ['asset prefix', 'var ASSET_PREFIX = "/";', 'var ASSET_PREFIX = "/other/";'],
    ['binding', 'var RUNTIME_PUBLIC_PATH =', 'const RUNTIME_PUBLIC_PATH ='],
  ])(
    'binds the generated %s scalar to trusted build coordinates',
    async (_title, before, after) => {
      const own = await input();
      const candidate = changed(own, before, after);

      expect(() => assertNodeManifestTurbopackRuntime(candidate)).toThrow(
        'Unproved Next.js Turbopack runtime',
      );
    },
  );

  it('rejects a source above the finite runtime budget before parsing it', async () => {
    const own = await input();
    const oversized = { ...own, source: source(own.source.code.repeat(4)) };

    expect(() => assertNodeManifestTurbopackRuntime(oversized)).toThrow(
      'source byte identity or bounds',
    );
  });

  it('rejects wrong source bytes, outside output paths and syntactically invalid sources', async () => {
    const own = await input();
    const wrong = { ...own, source: { ...own.source, sha256: source('other').sha256 } };
    const outside = { ...own, file: '/elsewhere/[turbopack]_runtime.js' };
    const syntax = { ...own, source: source('not valid JavaScript =') };

    expect(() => assertNodeManifestTurbopackRuntime(wrong)).toThrow('source byte identity');
    expect(() => assertNodeManifestTurbopackRuntime(outside)).toThrow('runtime public path');
    expect(() => assertNodeManifestTurbopackRuntime(syntax)).toThrow('runtime syntax');
  });
});
