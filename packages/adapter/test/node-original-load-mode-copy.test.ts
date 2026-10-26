import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import {
  assertFinalOriginalNodeModes,
  nodeOriginalModeMetadata,
} from '../src/node-original-load-mode-archive.ts';
import {
  originalNodeModeHash,
  prepareOriginalNodeModes,
  usePhysicalOriginalNodeModes,
  type OriginalNodeModeGraph,
} from '../src/node-original-load-mode.ts';
import { isNodeProofCompilerModule } from '../src/node-proof.ts';
import { WasmCollector } from '../src/wasm.ts';

async function prepareModes(
  input: { readonly rootDir: string; readonly projectDir: string; readonly distDir: string },
  graph: OriginalNodeModeGraph,
) {
  return prepareOriginalNodeModes(
    input,
    graph,
    [...graph.retained].filter((id) => !isNodeProofCompilerModule(id)),
  );
}

const directories: string[] = [];

async function fixture(external = false) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-goal-'));
  const root = await realpath(temporary);
  directories.push(root);
  const project = path.join(root, 'project');
  const dist = external ? path.join(root, 'built') : path.join(project, '.next');
  await mkdir(path.join(dist, 'server/chunks'), { recursive: true });
  await mkdir(project, { recursive: true });
  const file = path.join(dist, 'server/chunks/page.js');
  await writeFile(file, 'module.exports=42;');
  const pkg = path.join(dist, 'package.json');
  await writeFile(pkg, '{"type":"commonjs"}');
  const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
  const graph = { sources: new Map([['page', source]]), retained: new Set(['page']) };
  const scope = await prepareModes({ rootDir: project, projectDir: project, distDir: dist }, graph);
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: project,
    repoRoot: project,
    outDir: path.join(root, 'output'),
    patch: { projectDir: project, distDir: dist, chunks: [], instrumentation: undefined, wasm: [] },
    entries: [{ id: '/page', filePath: file }],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(root, 'blobs')),
  };
  return { root, project, dist, file, pkg, source, graph, scope, input };
}

function clearCoordinates(paths: ReadonlyMap<string, string>): void {
  if (!(paths instanceof Map)) throw new TypeError('missing authored map snapshot');
  paths.clear();
}

describe('physical mode metadata augmentation; no application executes', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('keeps copied raw bytes stable across selector-time disk mutation while final modes refuse stale source', async () => {
    const own = await fixture();
    const before = new Uint8Array(await readFile(own.file));
    const physical = await nodePhysicalFiles(own.input, [], [], async (sourcePaths) => {
      await usePhysicalOriginalNodeModes(own.scope, sourcePaths);
      await writeFile(own.file, 'module.exports=99;');
      return nodeOriginalModeMetadata(own.scope);
    });
    const copied = new Map(physical.files.map((entry) => [entry.name, entry]));

    expect(copied.get(physical.nameOf(own.file))?.bytes).toStrictEqual(before);

    await expect(
      assertFinalOriginalNodeModes(own.scope, {
        files: copied,
        sourcePaths: physical.sourcePaths,
        links: physical.links,
        nameOf: physical.nameOf,
      }),
    ).rejects.toThrow('source bytes changed');
  });

  it('keeps selector coordinate mutations isolated from the captured physical sources', async () => {
    const own = await fixture();
    const physical = await nodePhysicalFiles(own.input, [], [], async (sourcePaths) => {
      await usePhysicalOriginalNodeModes(own.scope, sourcePaths);
      clearCoordinates(sourcePaths);
      return nodeOriginalModeMetadata(own.scope);
    });

    expect([...physical.sourcePaths.values()]).toContain(own.file);

    await assertFinalOriginalNodeModes(own.scope, {
      files: new Map(physical.files.map((entry) => [entry.name, entry])),
      sourcePaths: physical.sourcePaths,
      links: physical.links,
      nameOf: physical.nameOf,
    });
  });

  it.each([false, true])(
    'rejects selected metadata conflicting with copied bytes (external=%s)',
    async (external) => {
      const own = await fixture(external);

      await expect(
        nodePhysicalFiles(own.input, [], [], async (sourcePaths) => {
          await usePhysicalOriginalNodeModes(own.scope, sourcePaths);
          return [{ file: own.pkg, sha256: 'wrong' }];
        }),
      ).rejects.toThrow('conflicts with copied bytes');
    },
  );

  it('preserves prior normalization pin conflicts against correctly selected mode metadata', async () => {
    const own = await fixture();
    const prior = [{ file: own.pkg, sha256: 'wrong prior digest' }];

    await expect(
      nodePhysicalFiles(own.input, [], prior, async (sourcePaths) => {
        await usePhysicalOriginalNodeModes(own.scope, sourcePaths);
        return nodeOriginalModeMetadata(own.scope);
      }),
    ).rejects.toThrow('conflicting source digests');
  });

  it('preserves conflicts between prior normalization pins even with no new mode metadata', async () => {
    const own = await fixture();
    const prior = [
      { file: own.pkg, sha256: 'first' },
      { file: own.pkg, sha256: 'second' },
    ];

    await expect(
      nodePhysicalFiles(own.input, [], prior, () => Promise.resolve([])),
    ).rejects.toThrow('conflicting source digests');
  });

  it('keeps non-package prior normalization sources separate from package-only mode additions', async () => {
    const own = await fixture();
    const physical = await nodePhysicalFiles(own.input, [], [own.source], async (sourcePaths) => {
      await usePhysicalOriginalNodeModes(own.scope, sourcePaths);
      return nodeOriginalModeMetadata(own.scope);
    });

    expect([...physical.sourcePaths.values()]).toContain(own.file);

    await assertFinalOriginalNodeModes(own.scope, {
      files: new Map(physical.files.map((entry) => [entry.name, entry])),
      sourcePaths: physical.sourcePaths,
      links: physical.links,
      nameOf: physical.nameOf,
    });
  });

  it('rejects duplicate selected metadata with differing digests before augmentation', async () => {
    const own = await fixture();

    await expect(
      nodePhysicalFiles(own.input, [], [], () => {
        return Promise.resolve([
          { file: own.pkg, sha256: 'first' },
          { file: own.pkg, sha256: 'second' },
        ]);
      }),
    ).rejects.toThrow('conflicting source digests');
  });

  it('rejects selected metadata outside the captured owned layout', async () => {
    const own = await fixture();
    const file = path.join(own.root, 'package.json');
    await writeFile(file, '{"type":"commonjs"}');
    const sha256 = originalNodeModeHash(await readFile(file));

    await expect(
      nodePhysicalFiles(own.input, [], [], () => Promise.resolve([{ file, sha256 }])),
    ).rejects.toThrow('escapes both');
  });

  it('rejects non-package selected inputs instead of expanding the raw source inventory', async () => {
    const own = await fixture();

    await expect(
      nodePhysicalFiles(own.input, [], [], () => Promise.resolve([own.source])),
    ).rejects.toThrow('canonical package.json');
  });

  it('propagates metadata selector failure without falling back to the preliminary snapshot', async () => {
    const own = await fixture();

    await expect(
      nodePhysicalFiles(own.input, [], [], () =>
        Promise.reject(new Error('authored selector failure')),
      ),
    ).rejects.toThrow('authored selector failure');
  });

  it('keeps the final dlopen alias guard after a selector with no new metadata', async () => {
    const own = await fixture();
    const binary = path.join(own.dist, 'server/chunks/authored.node');
    const logical = path.join(own.dist, 'server/chunks/alias.node');
    const other = path.join(own.dist, 'server/chunks/other.node');
    await writeFile(binary, 'authored inert bytes');
    await writeFile(other, 'different inert bytes');
    await symlink(binary, logical);
    const input = { ...own.input, files: [{ name: 'authored.node', filePath: binary }] };
    const native = [
      {
        kind: 'dlopen' as const,
        importer: own.file,
        binary,
        binaryAlias: logical,
        owners: [own.project],
      },
    ];

    await expect(
      nodePhysicalFiles(input, native, [], async () => {
        await rm(logical);
        await symlink(other, logical);
        return [];
      }),
    ).rejects.toThrow('changed physical target');
  });
});
