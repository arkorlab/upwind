import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  certifyNodeManifestRuntimeCallers,
  proveNodeManifestRuntimeCallers,
} from '../src/node-manifest-runtime-callers.ts';
import {
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFile,
} from '../src/node-manifest-turbopack-graph.ts';

function source(code: string): { readonly code: string; readonly sha256: string } {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

async function fixture(directory: string) {
  const distDir = path.join(directory, '.next');
  const entry = path.join(distDir, 'server/pages/post.js');
  const shared = path.join(distDir, 'server/pages/_app.js');
  const runtime = path.join(distDir, 'server/chunks/runtime.js');
  const chunk = path.join(distDir, 'server/chunks/pages.js');
  const sources: NodeManifestTurbopackGraphFile[] = [];
  const put = async (file: string, code: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, code);
    sources.push({ id: file, file, source: source(code), imports: [] });
  };
  await put(
    entry,
    'var R=require("../chunks/runtime.js")("server/pages/post.js");R.c("server/chunks/pages.js");module.exports=R.m(1).exports;',
  );
  await put(
    shared,
    'var R=require("../chunks/runtime.js")("server/pages/_app.js");R.c("server/chunks/pages.js");R.m(3);module.exports=R.m(3).exports;',
  );
  // This helper checks caller topology; the enclosing production consumer separately seals runtime bytes.
  await put(runtime, 'module.exports=runtime;');
  await put(chunk, 'module.exports=[1,((ctx)=>{ctx.v(1);}),3,((ctx)=>{ctx.v(3);})];');
  const linked = sources.map((file) => {
    if (file.file === entry || file.file === shared)
      return { ...file, imports: [{ specifier: '../chunks/runtime.js', target: runtime }] };
    if (file.file === runtime) return { ...file, imports: [{ specifier: chunk, target: chunk }] };
    return file;
  });
  return {
    entry,
    shared,
    runtime,
    chunk,
    distDir,
    sources: linked,
    input: {
      rootDir: directory,
      distDir,
      entries: [{ id: '/post', canonicalFilePath: entry }],
      routes: [{ kind: 'pages', pathname: '/post', file: entry }],
      entryTraces: [{ id: '/post', assets: { [path.relative(directory, shared)]: shared } }],
      sources: linked,
      retained: new Set(linked.map((file) => file.id)),
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type MissingOwnership =
  | 'no trace'
  | 'other owner'
  | 'importer only'
  | 'not retained'
  | 'API only'
  | 'unretained owner';

function missingOwnership(own: Fixture, mode: MissingOwnership) {
  const trace = own.input.entryTraces[0]!;
  const retained = new Set(own.input.retained);
  if (mode === 'not retained') retained.delete(own.shared);
  else if (mode === 'unretained owner') retained.delete(own.entry);
  const entryTraces =
    mode === 'no trace'
      ? []
      : [
          {
            ...trace,
            id: mode === 'other owner' ? '/other' : '/post',
            assets: mode === 'importer only' ? {} : trace.assets,
            importers: [own.shared],
          },
        ];
  return {
    ...own.input,
    retained,
    entryTraces,
    routes: mode === 'API only' ? [] : own.input.routes,
  };
}

describe('owned runtime caller inventory', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-runtime-callers-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps trace-owned shared callers separate from trusted entry ownership and freezes their source identities', async () => {
    const own = await fixture(directory);
    const proof = await certifyNodeManifestRuntimeCallers(own.input);

    expect(
      proof.callers.map((caller) => [caller.file, caller.role, caller.ownerIds]),
    ).toStrictEqual([
      [own.entry, 'input-entry', ['/post']],
      [own.shared, 'pages-app', ['/post']],
    ]);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.callers)).toBe(true);
    expect(
      proof.callers.every((caller) => Object.isFrozen(caller) && Object.isFrozen(caller.ownerIds)),
    ).toBe(true);
  });

  it('also admits document by the exact owned Pages trace, without making it a route entry', async () => {
    const own = await fixture(directory);
    const file = path.join(own.distDir, 'server/pages/_document.js');
    await writeFile(file, 'document');
    const sources = [...own.sources, { id: file, file, source: source('document'), imports: [] }];
    const proof = await certifyNodeManifestRuntimeCallers({
      ...own.input,
      sources,
      retained: new Set(sources.map((item) => item.id)),
      entryTraces: [{ id: '/post', assets: { [path.relative(directory, file)]: file } }],
    });

    expect(proof.callers.map((caller) => caller.role)).toStrictEqual([
      'input-entry',
      'pages-document',
    ]);
  });

  it.each([
    'no trace',
    'other owner',
    'importer only',
    'not retained',
    'API only',
    'unretained owner',
  ] as const)('does not grant shared authority for %s', async (mode) => {
    const own = await fixture(directory);
    const proof = await certifyNodeManifestRuntimeCallers(missingOwnership(own, mode));

    expect(proof.callers.some((caller) => caller.file === own.shared)).toBe(false);
  });

  it('never elevates trace-only _error or unrelated assets and ignores unsupported unrelated rows', async () => {
    const own = await fixture(directory);
    const file = path.join(own.distDir, 'server/pages/_error.js');
    await writeFile(file, 'error');
    const sources = [...own.sources, { id: file, file, source: source('error'), imports: [] }];
    const proof = await certifyNodeManifestRuntimeCallers({
      ...own.input,
      sources,
      retained: new Set(sources.map((item) => item.id)),
      entryTraces: [
        { id: '/post', assets: { [file]: file, 'next_additional_roots/absent': '/missing' } },
      ],
    });

    expect(proof.callers.map((caller) => caller.file)).toStrictEqual([own.entry]);
  });

  it('binds logical symlink keys and declared symlink roots to the canonical shared file', async () => {
    const own = await fixture(directory);
    const logical = 'app-alias.js';
    await symlink(own.shared, path.join(directory, logical));
    const declared = path.join(directory, 'root-alias');
    await symlink(directory, declared, 'dir');
    const proof = await certifyNodeManifestRuntimeCallers({
      ...own.input,
      rootDir: declared,
      entryTraces: [{ id: '/post', assets: { [logical]: own.shared } }],
    });

    expect(proof.callers.some((caller) => caller.file === own.shared)).toBe(true);
  });

  it('uses declared root-relative ../ keys for an external distDir', async () => {
    const own = await fixture(directory);
    const rootDir = path.join(directory, 'project');
    await mkdir(rootDir);
    const proof = await certifyNodeManifestRuntimeCallers({
      ...own.input,
      rootDir,
      entryTraces: [{ id: '/post', assets: { [path.relative(rootDir, own.shared)]: own.shared } }],
    });

    expect(proof.callers.some((caller) => caller.file === own.shared)).toBe(true);
  });

  it.each(['virtual root', 'absolute key', 'noncanonical key', 'mismatched key'] as const)(
    'refuses a matching shared value with an unproved %s',
    async (mode) => {
      const own = await fixture(directory);
      const logical = path.relative(directory, own.shared);
      const keys = {
        'virtual root': `next_additional_roots/other/${logical}`,
        'absolute key': own.shared,
        'noncanonical key': `.next/../${logical}`,
        'mismatched key': 'not-the-shared-file',
      };

      await expect(
        certifyNodeManifestRuntimeCallers({
          ...own.input,
          entryTraces: [{ id: '/post', assets: { [keys[mode]]: own.shared } }],
        }),
      ).rejects.toThrow('Unproved Next.js runtime caller');
    },
  );

  it('checks complete caller boot/runtime/chunk/evaluation bindings using the certified inventory', async () => {
    const own = await fixture(directory);
    const inventory = await certifyNodeManifestRuntimeCallers(own.input);
    const graph = nodeManifestTurbopackEntryGraph({
      distDir: own.distDir,
      sources: own.sources,
      entry: { file: own.entry, page: '/post', pathname: '/post', kind: 'pages' },
    });
    const proof = proveNodeManifestRuntimeCallers({
      inventory,
      graphs: [graph],
      sources: own.sources,
      distDir: own.distDir,
    });

    expect(proof.callers.map((caller) => [caller.file, caller.invoked])).toStrictEqual([
      [own.entry, [`${own.chunk}#turbopack:1`]],
      [own.shared, [`${own.chunk}#turbopack:3`]],
    ]);
    expect(() => {
      return proveNodeManifestRuntimeCallers({
        inventory: { ...inventory },
        graphs: [graph],
        sources: own.sources,
        distDir: own.distDir,
      });
    }).toThrow('uncertified caller inventory');
  });

  it.each([
    ['public path', 'server/pages/_app.js', 'server/pages/other.js', 'boot public path'],
    ['unknown module', 'R.m(3)', 'R.m(99)', 'unregistered boot evaluation'],
    ['distinct string module', 'R.m(3)', 'R.m("3")', 'unregistered boot evaluation'],
    ['dynamic module', 'R.m(3)', 'R.m(dynamic)', 'invalid entry module id'],
    ['unclosed chunk', 'server/chunks/pages.js', 'server/chunks/missing.js', 'unclosed boot chunk'],
    ['extra executable statement', 'R.m(3);', 'R.m(3);unknown();', 'entry runtime receiver'],
  ])('refuses an owned shared boot with %s', async (_name, before, after, reason) => {
    const own = await fixture(directory);
    const sources = own.sources.map((file) => {
      return file.file === own.shared
        ? { ...file, source: source(file.source.code.replaceAll(before, () => after)) }
        : file;
    });
    const inventory = await certifyNodeManifestRuntimeCallers({ ...own.input, sources });
    const graph = nodeManifestTurbopackEntryGraph({
      distDir: own.distDir,
      sources,
      entry: { file: own.entry, page: '/post', pathname: '/post', kind: 'pages' },
    });

    expect(() => {
      return proveNodeManifestRuntimeCallers({
        inventory,
        graphs: [graph],
        sources,
        distDir: own.distDir,
      });
    }).toThrow(reason);
  });
});
