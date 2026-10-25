import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appEntrySource } from '../src/app-entry.ts';
import { jsLiteral } from '../src/codegen.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import {
  manifestProofFixture as fixture,
  manifestTemplateProofFixture as templateFixture,
} from './fixtures/node-manifest-turbopack-proof.ts';
function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
type RuntimeKind = 'app-page' | 'pages' | 'app-route' | 'pages-api';
const CLIENT_ASSET_PREFIX = 'https://cdn.example/assets/_next/';
const PREFIX_PROFILES = [
  ['app-page', CLIENT_ASSET_PREFIX],
  ['pages', CLIENT_ASSET_PREFIX],
  ['app-route', '/'],
  ['pages-api', '/'],
] as const;

async function prefixFixture(directory: string, kind: RuntimeKind) {
  return kind === 'app-page' ? fixture(directory) : templateFixture(directory, kind);
}

async function compilerPrefix(
  own: Awaited<ReturnType<typeof fixture>>,
  prefix: string,
): Promise<void> {
  const code = await readFile(own.runtime, 'utf8');
  const original = 'var ASSET_PREFIX = "/";';
  if (!code.includes(original)) throw new Error('Missing source-only compiler prefix fixture');
  const changed = code.replace(original, () => `var ASSET_PREFIX = ${jsLiteral(prefix)};`);
  await writeFile(own.runtime, changed);
  own.sources.set(own.runtime, { file: own.runtime, sha256: digest(changed) });
}

async function sharedPagesCaller(own: Awaited<ReturnType<typeof fixture>>, name = '_app') {
  const file = path.join(own.input.distDir, `server/pages/${name}.js`);
  const code = `var R=require("../chunks/[turbopack]_runtime.js")("server/pages/${name}.js");R.c("server/chunks/app.js");module.exports=R.m(3).exports;`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, code);
  own.sources.set(file, { file, sha256: digest(code) });
  own.imports.set(file, [{ specifier: '../chunks/[turbopack]_runtime.js', target: own.runtime }]);
  own.graph.importers.set(file, []);
  own.graph.importers.get(own.runtime)?.push(file);
  own.graph.retained.add(file);
  const chunk = (await readFile(own.chunk, 'utf8')).replace(
    'module.exports=[',
    'module.exports=[3,((ctx)=>{ctx.v(function Shared(){return null;});}),',
  );
  await writeFile(own.chunk, chunk);
  own.sources.set(own.chunk, { file: own.chunk, sha256: digest(chunk) });
  return { file, assets: { [path.relative(own.input.rootDir, file)]: file } };
}

async function unownedSharedFixture(directory: string, mode: string) {
  const own = await templateFixture(directory, mode === 'API owner' ? 'pages-api' : 'pages');
  const shared = await sharedPagesCaller(own, mode === 'trace-only _error' ? '_error' : '_app');
  if (mode !== 'no trace owner')
    own.input.entryTraces = [{ id: own.input.entries[0]!.id, assets: shared.assets }];
  if (mode === 'unretained caller') own.graph.retained.delete(shared.file);
  return own;
}

describe('sealed Turbopack producers through the real manifest proof entry', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-tpack-proof-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['_app', '_document'])(
    'admits trace-owned retained Pages %s without extending route or compiler authority',
    async (name) => {
      const own = await templateFixture(directory, 'pages');
      const shared = await sharedPagesCaller(own, name);
      own.input.entryTraces = [{ id: own.input.entries[0]!.id, assets: shared.assets }];
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.entries.map((entry) => entry.filePath)).toStrictEqual([
        own.entry,
      ]);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
      expect(proof.codeSources.some((source) => source.file === shared.file)).toBe(true);
      expect(proof.inspectionCode(shared.file, 'eval("unproved")')).toBe('eval("unproved")');
    },
  );

  it.each(['no trace owner', 'unretained caller', 'trace-only _error', 'API owner'] as const)(
    'preserves all-source runtime caller refusal for %s',
    async (mode) => {
      const own = await unownedSharedFixture(directory, mode);

      await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
        'unknown runtime API caller',
      );
    },
  );

  it.each(PREFIX_PROFILES)(
    'propagates trusted client config through the complete %s manifest proof',
    async (kind, expectedPrefix) => {
      const own = await prefixFixture(directory, kind);
      await compilerPrefix(own, expectedPrefix);
      const proof = await proveNodeManifests(
        { ...own.input, clientAssetPrefix: CLIENT_ASSET_PREFIX },
        own.graph,
      );

      expect(proof.normalization?.runtimeRootDir).toBe(directory);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
    },
  );

  it.each(PREFIX_PROFILES)(
    'refuses a %s runtime prefix from the other endpoint profile instead of trusting its declaration',
    async (kind, expectedPrefix) => {
      const own = await prefixFixture(directory, kind);
      await compilerPrefix(own, expectedPrefix === '/' ? CLIENT_ASSET_PREFIX : '/');

      await expect(
        proveNodeManifests({ ...own.input, clientAssetPrefix: CLIENT_ASSET_PREFIX }, own.graph),
      ).rejects.toThrow('asset prefix');
    },
  );

  it('closes all actual boot importers before emitting compiler source and immutable root metadata', async () => {
    const own = await fixture(directory);
    const proof = await proveNodeManifests(own.input, own.graph);

    expect({
      root: proof.normalization?.runtimeRootDir,
      frozen: Object.isFrozen(proof.normalization),
      entriesFrozen: Object.isFrozen(proof.normalization?.entries),
      entryFrozen: Object.isFrozen(proof.normalization?.entries[0]),
      compilers: proof.approvedCompilerSources,
    }).toStrictEqual({
      root: directory,
      frozen: true,
      entriesFrozen: true,
      entryFrozen: true,
      compilers: [own.sources.get(own.runtime)],
    });
    expect(proof.codeSources.map((source) => source.file)).toStrictEqual(
      expect.arrayContaining([own.entry, own.chunk, own.runtime]),
    );
    expect(proof.codeSources.some((source) => source.file === own.manifest)).toBe(false);
    expect(proof.inspectionCode(own.runtime, 'eval("unknown")')).toBe('eval("unknown")');
  });

  it('requires independently supplied absolute compiler root coordinates', async () => {
    const own = await fixture(directory);
    own.input.rootDir = 'relative-untrusted';

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'missing trusted compiler root',
    );
  });

  it('closes the full manifest proof with an ordinary scalar-exporting factory in the same table', async () => {
    const own = await fixture(directory);
    const code = (await readFile(own.chunk, 'utf8')).replace(
      'module.exports=[',
      'module.exports=[3,((ctx)=>{ctx.v(42);}),',
    );
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.normalization?.runtimeRootDir).toBe(directory);
    expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
  });

  it('closes a string-ID protected route while retaining a distinct numeric factory in the same table', async () => {
    const own = await fixture(directory);
    const code = (await readFile(own.chunk, 'utf8'))
      .replace('module.exports=[1,', 'module.exports=[1,((ctx)=>{ctx.v(42);}),"1",')
      .replace('ctx.i(2)', 'ctx.i("2")')
      .replace('}),2,', '}),"2",');
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });
    const entry = (await readFile(own.entry, 'utf8')).replaceAll('R.m(1)', 'R.m("1")');
    await writeFile(own.entry, entry);
    own.sources.set(own.entry, { file: own.entry, sha256: digest(entry) });
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.normalization?.runtimeRootDir).toBe(directory);
    expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
  });

  it('refuses a raw protected consumer sharing an otherwise certified physical factory table', async () => {
    const own = await fixture(directory);
    const body = `var p=require(${jsLiteral(SPECIFIER)});ctx.v(p);`;
    const code = (await readFile(own.chunk, 'utf8')).replace(
      'module.exports=[',
      () => `module.exports=[3,((ctx)=>{${body}}),`,
    );
    await writeFile(own.chunk, code);
    own.sources.set(own.chunk, { file: own.chunk, sha256: digest(code) });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('Unproved Next.js');
  });

  it.each(['pages', 'app-route', 'pages-api'] as const)(
    'connects the published projected %s body through every physical importer to the SDK root',
    async (kind) => {
      const own = await templateFixture(directory, kind);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.runtimeRootDir).toBe(directory);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
      expect(proof.codeSources.map((source) => source.file)).toStrictEqual(
        expect.arrayContaining([own.entry, own.chunk]),
      );
    },
  );

  it('refuses a private Pages API handler without the exact Node requestMeta facade', async () => {
    const own = await templateFixture(directory, 'pages-api');
    const code = appEntrySource(own.input.entries, {
      external: true,
      runtimeDistDir: own.input.distDir,
    });
    await writeFile(own.analysisEntry, code);
    own.sources.set(own.analysisEntry, { file: own.analysisEntry, sha256: digest(code) });

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unproved SDK entry terminal',
    );
  });

  it.each([
    ['pages', 'dist/compiled/next-server/pages.runtime.prod.js'],
    ['pages', 'dist/compiled/next-server/pages-turbo.runtime.prod.js'],
    ['pages-api', 'dist/compiled/next-server/pages-api.runtime.prod.js'],
    ['pages-api', 'dist/compiled/next-server/pages-api-turbo.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-turbo.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-experimental.runtime.prod.js'],
    ['app-route', 'dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js'],
  ] as const)(
    'closes a %s constructor directly from selected runtime %s',
    async (kind, runtime) => {
      const own = await templateFixture(directory, kind, runtime);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.runtimeRootDir).toBe(directory);
      expect(proof.approvedCompilerSources).toStrictEqual([own.sources.get(own.runtime)]);
    },
  );

  it.each([
    ['different constructor family', 'dist/compiled/next-server/app-route.runtime.prod.js'],
    ['unreviewed AppPage class path', 'dist/compiled/next-server/app-page.runtime.prod.js'],
  ])(
    'refuses direct runtime with %s even when its bytes are a known Next source',
    async (_name, runtime) => {
      const own = await templateFixture(directory, 'pages', runtime);

      await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow('Unproved Next.js');
    },
  );

  it('refuses a second physical importer that escapes the SDK normalization terminal', async () => {
    const own = await fixture(directory);
    const other = path.join(directory, 'other.cjs');
    const code = `module.exports=require(${jsLiteral(own.entry)});`;
    await writeFile(other, code);
    own.sources.set(other, { file: other, sha256: digest(code) });
    own.imports.set(other, [{ specifier: own.entry, target: own.entry }]);
    own.graph.importers.get(own.entry)?.push(other);
    own.graph.importers.set(other, []);
    own.graph.retained.add(other);

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unknown consumer or export escape',
    );
  });
});
