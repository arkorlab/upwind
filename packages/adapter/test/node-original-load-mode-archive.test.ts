import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodeArtifactArchive } from '../src/node-archive.ts';
import { nodePhysicalFiles } from '../src/node-files.ts';
import {
  assertFinalOriginalNodeModes,
  nodeOriginalModeMetadata,
  nodeOriginalModeProofFiles,
} from '../src/node-original-load-mode-archive.ts';
import {
  originalNodeModeArchiveName,
  originalNodeModeHash,
  inspectOriginalNodeMode,
  prepareOriginalNodeModes,
  useOriginalCommonJsMode,
  usePhysicalOriginalNodeModes,
  type OriginalNodeModeGraph,
} from '../src/node-original-load-mode.ts';
import { assertNodeProofFiles, isNodeProofCompilerModule } from '../src/node-proof.ts';
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

async function fixture(
  extension = '.js',
  metadata: string | null = '{"type":"commonjs"}',
  external = false,
) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-goal-'));
  const root = await realpath(temporary);
  directories.push(root);
  const project = path.join(root, 'project');
  const dist = external ? path.join(root, 'built') : path.join(project, '.next');
  await mkdir(path.join(dist, 'server/chunks'), { recursive: true });
  await mkdir(project, { recursive: true });
  const file = path.join(dist, `server/chunks/page${extension}`);
  await writeFile(file, 'module.exports=42;');
  const pkg = path.join(dist, 'package.json');
  if (metadata !== null) await writeFile(pkg, metadata);
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
  async function copied() {
    const physical = await nodePhysicalFiles(input, [], nodeOriginalModeMetadata(scope));
    const proof = { files: nodeOriginalModeProofFiles(scope, [source]), native: [] };
    assertNodeProofFiles(proof, physical, new Map());
    return { physical, proof, files: new Map(physical.files.map((entry) => [entry.name, entry])) };
  }
  return { root, project, dist, file, pkg, source, graph, scope, input, copied };
}

async function unsupportedMetadata(
  own: Awaited<ReturnType<typeof fixture>>,
  kind: 'oversize' | 'symlink',
) {
  if (kind === 'oversize') {
    await writeFile(own.pkg, JSON.stringify({ type: 'commonjs', padding: 'x'.repeat(70_000) }));
    return;
  }
  const target = path.join(own.project, 'authored-scope.json');
  await writeFile(target, '{"type":"commonjs"}');
  await rm(own.pkg);
  await symlink(target, own.pkg);
}

function corruptOverlay(
  own: Awaited<ReturnType<typeof fixture>>,
  copied: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['copied']>>,
  field: string,
) {
  const pkg = copied.physical.nameOf(own.pkg);
  let links = copied.physical.links;
  let nameOf = copied.physical.nameOf;
  switch (field) {
    case 'omit': {
      copied.files.delete(pkg);
      break;
    }
    case 'changed': {
      copied.files.set(pkg, { name: pkg, bytes: new TextEncoder().encode('{"type":"module"}') });
      break;
    }
    case 'closer': {
      const name = copied.physical.nameOf(path.join(own.dist, 'server/package.json'));
      copied.files.set(name, { name, bytes: new TextEncoder().encode('{"type":"commonjs"}') });

      break;
    }
    case 'alias': {
      links = [{ path: path.posix.dirname(pkg), target: 'other' }];
      break;
    }
    case 'relocation': {
      nameOf = () => 'wrong';
      break;
    }
    // No default
  }
  return { files: copied.files, sourcePaths: copied.physical.sourcePaths, links, nameOf };
}

describe('original CommonJS mode source facts; no application executes', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([false, true])(
    'closes FS→used metadata→real physicalcopy→final archive (external=%s)',
    async (external) => {
      const own = await fixture('.js', '{"name":"authored","type":"commonjs"}', external);

      await expect(inspectOriginalNodeMode(own.scope, 'page')).resolves.toMatchObject({
        kind: 'commonjs-candidate',
      });
      expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([]);

      const preliminary = await nodePhysicalFiles(own.input, [], []);

      expect([...preliminary.sourcePaths.values()]).toContain(own.source.file);

      const proof = await useOriginalCommonJsMode(own.scope, 'page', own.source);

      expect(proof).toBeDefined();
      expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([
        { file: own.pkg, sha256: originalNodeModeHash(await readFile(own.pkg)) },
      ]);

      const copied = await own.copied();
      await assertFinalOriginalNodeModes(own.scope, {
        files: copied.files,
        sourcePaths: copied.physical.sourcePaths,
        links: copied.physical.links,
        nameOf: copied.physical.nameOf,
      });

      expect(nodeArtifactArchive([...copied.files.values()]).byteLength).toBeGreaterThan(0);
      expect(
        copied.files.get(originalNodeModeArchiveName(own.scope, own.pkg))?.bytes,
      ).toStrictEqual(new Uint8Array(await readFile(own.pkg)));
    },
  );

  it.each(['.cjs', '.js'])(
    'retains the old physical-copy/archive path for root-owned %s when the unused output is absent',
    async (extension) => {
      const own = await fixture();
      const file = path.join(own.project, `root${extension}`);
      await writeFile(file, 'module.exports=1;');
      await writeFile(path.join(own.project, 'package.json'), '{"type":"commonjs"}');
      const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
      const graph = { sources: new Map([['root', source]]), retained: new Set(['root']) };
      const dist = path.join(own.project, 'not-created');
      const input = {
        ...own.input,
        entries: [{ id: '/root', filePath: file }],
        patch: { ...own.input.patch, distDir: dist },
      };
      const scope = await prepareModes(
        { rootDir: own.project, projectDir: own.project, distDir: dist },
        graph,
      );
      const preliminary = await nodePhysicalFiles(input, []);
      await usePhysicalOriginalNodeModes(scope, preliminary.sourcePaths);
      const physical = await nodePhysicalFiles(input, [], nodeOriginalModeMetadata(scope));
      const proof = { files: nodeOriginalModeProofFiles(scope, [source]), native: [] };
      assertNodeProofFiles(proof, physical, new Map());
      await assertFinalOriginalNodeModes(scope, {
        files: new Map(physical.files.map((entry) => [entry.name, entry])),
        sourcePaths: physical.sourcePaths,
        links: physical.links,
        nameOf: physical.nameOf,
      });

      expect(nodeArtifactArchive(physical.files).byteLength).toBeGreaterThan(0);
    },
  );

  it('uses .cjs by actual extension without requiring package metadata', async () => {
    const own = await fixture('.cjs', null);

    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeDefined();
    expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([]);

    const copied = await own.copied();
    await assertFinalOriginalNodeModes(own.scope, {
      files: copied.files,
      sourcePaths: copied.physical.sourcePaths,
      links: [],
      nameOf: copied.physical.nameOf,
    });
  });

  it.each(['oversize', 'symlink'] as const)(
    'keeps an initially unsupported metadata goal %s unavailable while old raw copy/byte checks remain usable',
    async (kind) => {
      const own = await fixture();
      await unsupportedMetadata(own, kind);

      await expect(inspectOriginalNodeMode(own.scope, 'page')).resolves.toMatchObject({
        kind: 'unknown',
      });
      await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).resolves.toBeUndefined();

      const copied = await own.copied();
      await assertFinalOriginalNodeModes(own.scope, {
        files: copied.files,
        sourcePaths: copied.physical.sourcePaths,
        links: copied.physical.links,
        nameOf: copied.physical.nameOf,
      });

      expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([]);
    },
  );

  it('uses modes only for real preliminary physical sourcePaths and preserves bundle-only hook byte proof', async () => {
    const own = await fixture();
    const file = path.join(own.dist, 'server/chunks/hook-only.js');
    await writeFile(file, 'module.exports=7;');
    const hook = { file, sha256: originalNodeModeHash(await readFile(file)) };
    own.graph.sources.set('hook', hook);
    own.graph.retained.add('hook');
    const scope = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      own.graph,
    );

    await expect(inspectOriginalNodeMode(scope, 'hook')).resolves.toMatchObject({
      kind: 'commonjs-candidate',
    });

    const preliminary = await nodePhysicalFiles(own.input, [], []);

    expect([...preliminary.sourcePaths.values()]).not.toContain(hook.file);

    await usePhysicalOriginalNodeModes(scope, preliminary.sourcePaths);
    const final = await nodePhysicalFiles(own.input, [], nodeOriginalModeMetadata(scope));
    const proof = { files: nodeOriginalModeProofFiles(scope, [own.source, hook]), native: [] };
    assertNodeProofFiles(proof, final, new Map([[hook.file, hook.sha256]]));

    expect(final.files.some((entry) => entry.name === final.nameOf(hook.file))).toBe(false);

    await assertFinalOriginalNodeModes(scope, {
      files: new Map(final.files.map((entry) => [entry.name, entry])),
      sourcePaths: final.sourcePaths,
      links: final.links,
      nameOf: final.nameOf,
    });

    expect(nodeArtifactArchive(final.files).byteLength).toBeGreaterThan(0);
  });

  it('never ignores a semantically USED hook mode merely because its raw file is absent from physical sourcePaths', async () => {
    const own = await fixture();
    const file = path.join(own.dist, 'server/chunks/hook-only.js');
    await writeFile(file, 'module.exports=7;');
    const hook = { file, sha256: originalNodeModeHash(await readFile(file)) };
    own.graph.sources.set('hook', hook);
    own.graph.retained.add('hook');
    const scope = await prepareModes(
      { rootDir: own.project, projectDir: own.project, distDir: own.dist },
      own.graph,
    );
    await useOriginalCommonJsMode(scope, 'hook', hook);
    const physical = await nodePhysicalFiles(own.input, [], nodeOriginalModeMetadata(scope));
    const files = new Map(physical.files.map((entry) => [entry.name, entry]));
    const name = physical.nameOf(hook.file);
    files.set(name, { name, bytes: new Uint8Array(await readFile(hook.file)) });

    await expect(
      assertFinalOriginalNodeModes(scope, {
        files,
        sourcePaths: physical.sourcePaths,
        links: physical.links,
        nameOf: physical.nameOf,
      }),
    ).rejects.toThrow('raw physical-execution source');
  });

  it('closes an empty final inventory before a concurrent new mode can be minted', async () => {
    const own = await fixture();
    const final = assertFinalOriginalNodeModes(own.scope, {
      sourcePaths: new Map(),
      files: new Map(),
      links: [],
      nameOf: () => 'unused',
    });
    const late = useOriginalCommonJsMode(own.scope, 'page', own.source);
    const [finalResult, lateResult] = await Promise.allSettled([final, late]);

    expect(finalResult.status).toBe('fulfilled');
    expect(lateResult.status).toBe('rejected');
    expect(lateResult).toHaveProperty(
      'reason.message',
      expect.stringContaining('ledger finalized'),
    );

    expect(nodeOriginalModeMetadata(own.scope)).toStrictEqual([]);
    await expect(useOriginalCommonJsMode(own.scope, 'page', own.source)).rejects.toThrow(
      'ledger finalized',
    );
  });

  it.each(['before', 'after'] as const)(
    'refuses a new mode started %s finalization while rechecking an existing mode',
    async (timing) => {
      const own = await fixture();
      const file = path.join(own.dist, 'server/chunks/late.js');
      await writeFile(file, 'module.exports=2;');
      const source = { file, sha256: originalNodeModeHash(await readFile(file)) };
      own.graph.sources.set('late', source);
      own.graph.retained.add('late');
      const scope = await prepareModes(
        { rootDir: own.project, projectDir: own.project, distDir: own.dist },
        own.graph,
      );
      const proof = await useOriginalCommonJsMode(scope, 'page', own.source);
      const physical = await nodePhysicalFiles(own.input, [], nodeOriginalModeMetadata(scope));
      const view = {
        files: new Map(physical.files.map((entry) => [entry.name, entry])),
        sourcePaths: physical.sourcePaths,
        links: physical.links,
        nameOf: physical.nameOf,
      };
      const pending =
        timing === 'before' ? useOriginalCommonJsMode(scope, 'late', source) : undefined;
      const final = assertFinalOriginalNodeModes(scope, view);
      const late = pending ?? useOriginalCommonJsMode(scope, 'late', source);
      const [finalResult, lateResult] = await Promise.allSettled([final, late]);

      expect(finalResult.status).toBe('fulfilled');
      expect(lateResult.status).toBe('rejected');
      expect(lateResult).toHaveProperty(
        'reason.message',
        expect.stringContaining('ledger finalized'),
      );

      const rereads = await Promise.all([
        useOriginalCommonJsMode(scope, 'page', own.source),
        useOriginalCommonJsMode(scope, 'page', own.source),
      ]);

      expect(rereads).toStrictEqual([proof, proof]);

      await assertFinalOriginalNodeModes(scope, view);

      await expect(useOriginalCommonJsMode(scope, 'late', source)).rejects.toThrow(
        'ledger finalized',
      );
    },
  );

  it.each(['omit', 'changed', 'closer', 'alias', 'relocation'])(
    'refuses final overlay %s after the earlier raw byte check',
    async (field) => {
      const own = await fixture();
      await useOriginalCommonJsMode(own.scope, 'page', own.source);
      const copied = await own.copied();
      const view = corruptOverlay(own, copied, field);

      await expect(
        assertFinalOriginalNodeModes(own.scope, {
          ...view,
        }),
      ).rejects.toThrow('archived CommonJS goal');
    },
  );

  it('checks copied metadata JSON as raw DATA and rejects digest conflicts with prior proofs', async () => {
    const own = await fixture();
    await usePhysicalOriginalNodeModes(own.scope, new Map([['original', own.source.file]]));
    const copied = await own.copied();
    const metadata = nodeOriginalModeMetadata(own.scope)[0];

    expect(metadata?.file).toBe(own.pkg);
    expect(copied.proof.files).toContainEqual(metadata);
    expect(() =>
      nodeOriginalModeMetadata(own.scope, [{ file: own.pkg, sha256: 'different' }]),
    ).toThrow('conflicts');
    expect(() =>
      nodeOriginalModeProofFiles(own.scope, [{ file: own.file, sha256: 'different' }]),
    ).toThrow('conflicts');
  });

  it('preserves the raw loader exception when a hook also bundled that loader', async () => {
    const own = await fixture();
    const native = [
      {
        kind: 'node-gyp-build' as const,
        importer: own.file,
        binary: path.join(own.dist, 'authored.node'),
        owners: [own.project],
        loaderSources: [{ ...own.source, gitBlob: 'unused-by-byte-check' }],
      },
    ];
    const physical = {
      files: [],
      sourcePaths: new Map<string, string>(),
      nameOf: (file: string) => file,
    };
    const proof = { files: [own.source], native };

    expect(() => {
      assertNodeProofFiles(proof, physical, new Map([[own.file, own.source.sha256]]));
    }).toThrow('absent or changed');
    expect(() => {
      assertNodeProofFiles(
        { ...proof, native: [] },
        physical,
        new Map([[own.file, own.source.sha256]]),
      );
    }).not.toThrow();
  });

  it('checks goal independently of separately authorized code rewrites, without certifying code bytes', async () => {
    const own = await fixture();
    await useOriginalCommonJsMode(own.scope, 'page', own.source);
    const copied = await own.copied();
    const name = copied.physical.nameOf(own.file);
    copied.files.set(name, { name, bytes: new TextEncoder().encode('module.exports=43;') });
    await assertFinalOriginalNodeModes(own.scope, {
      files: copied.files,
      sourcePaths: copied.physical.sourcePaths,
      links: copied.physical.links,
      nameOf: copied.physical.nameOf,
    });

    expect(() => {
      assertNodeProofFiles(
        copied.proof,
        { ...copied.physical, files: [...copied.files.values()] },
        new Map(),
      );
    }).toThrow('absent or changed');
  });
});
