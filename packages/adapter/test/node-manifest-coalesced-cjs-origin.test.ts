import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ManifestGraphInput, ManifestModuleGraph } from '../src/node-manifest-graph.ts';
import {
  prepareNodeManifestSdkTerminalScope,
  useNodeManifestOriginalCommonJs,
  assertNodeManifestOriginalCommonJs,
} from '../src/node-manifest-sdk-terminal.ts';
import type { NodeManifestTurbopackConsumerInput } from '../src/node-manifest-turbopack-consumer-input.ts';
import { assertFinalOriginalNodeModes } from '../src/node-original-load-mode-archive.ts';
import {
  originalNodeModeArchiveName,
  originalNodeModeHash,
  originalNodeModeMetadata,
  prepareOriginalNodeModes,
} from '../src/node-original-load-mode.ts';

const directories: string[] = [];
async function fixture(extension = '.cjs', metadata: string | null = null) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-cjs-origin-'));
  const root = await realpath(temporary);
  directories.push(root);
  const distDir = path.join(root, '.next');
  await mkdir(distDir);
  const file = path.join(root, `entry${extension}`);
  const code = 'module.exports=[1,(ctx)=>{ctx.v(1);}];';
  await writeFile(file, code);
  const pkg = path.join(root, 'package.json');
  if (metadata !== null) await writeFile(pkg, metadata);
  const original = { file, sha256: originalNodeModeHash(code) };
  const imports: readonly { readonly specifier: string; readonly target: string }[] = [];
  const graph: ManifestModuleGraph = {
    sources: new Map([['physical', original]]),
    imports: new Map([['physical', imports]]),
    importers: new Map(),
    roots: new Set(['physical']),
    retained: new Set(['physical']),
  };
  const modes = await prepareOriginalNodeModes(
    { rootDir: root, projectDir: root, distDir },
    graph,
    ['physical'],
  );
  const input: ManifestGraphInput = {
    rootDir: root,
    distDir,
    entries: [{ id: '/authored', filePath: file }],
    runtimeManifest: '{"entrypoints":[]}',
    originalModes: modes,
  };
  const { scope } = await prepareNodeManifestSdkTerminalScope(input, graph);
  const physical = { id: 'physical', file, source: { code, sha256: original.sha256 }, imports };
  const owner: NodeManifestTurbopackConsumerInput = {
    rootDir: root,
    distDir,
    sources: [physical],
    entries: [],
    sdkTerminalScope: scope,
    originalModes: modes,
    producer: { id: 'physical', file, sha256: original.sha256 },
  };
  return { root, distDir, file, pkg, modes, input, graph, physical, owner };
}
async function requiredMode(own: Awaited<ReturnType<typeof fixture>>) {
  const proof = await useNodeManifestOriginalCommonJs(own.owner, own.physical);
  if (proof === undefined) throw new Error('missing authored CJS mode');
  return proof;
}
async function archive(own: Awaited<ReturnType<typeof fixture>>) {
  const pins = [{ file: own.file }, ...originalNodeModeMetadata(own.modes)];
  const files = new Map(
    await Promise.all(
      pins.map(async ({ file }) => {
        const name = originalNodeModeArchiveName(own.modes, file);
        return [name, { name, bytes: new Uint8Array(await readFile(file)) }] as const;
      }),
    ),
  );
  return {
    files,
    sourcePaths: new Map([[originalNodeModeArchiveName(own.modes, own.file), own.file]]),
    links: [],
    nameOf: (file: string) => originalNodeModeArchiveName(own.modes, file),
  };
}

describe('actual original CJS mode through the private SDK source bridge', () => {
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it.each([
    ['.cjs', null],
    ['.js', '{"type":"commonjs"}'],
  ] as const)(
    'seals and rechecks %s mode without framework or compiler permission',
    async (extension, metadata) => {
      const own = await fixture(extension, metadata);
      const proof = await requiredMode(own);
      await assertNodeManifestOriginalCommonJs(proof, own.owner, own.physical);
      await assertFinalOriginalNodeModes(own.modes, await archive(own));

      expect(own.physical.source.code).toBe('module.exports=[1,(ctx)=>{ctx.v(1);}];');
    },
  );

  it.each([
    ['.mjs', null],
    ['.js', null],
    ['.js', '{"type":"module"}'],
  ] as const)('keeps unsupported %s %s mode unavailable', async (extension, metadata) => {
    const own = await fixture(extension, metadata);

    await expect(useNodeManifestOriginalCommonJs(own.owner, own.physical)).resolves.toBeUndefined();
    expect(originalNodeModeMetadata(own.modes)).toStrictEqual([]);
  });

  it('refuses a copied row, changed source and dropped mode scope', async () => {
    const own = await fixture();

    await expect(useNodeManifestOriginalCommonJs(own.owner, { ...own.physical })).rejects.toThrow(
      'pending',
    );
    await expect(
      useNodeManifestOriginalCommonJs({ ...own.owner, originalModes: undefined }, own.physical),
    ).rejects.toThrow('pending');

    const before = own.physical.source.code;
    own.physical.source.code = `${before}\n`;

    await expect(useNodeManifestOriginalCommonJs(own.owner, own.physical)).rejects.toThrow(
      'source',
    );
  });

  it('refuses an identical-source foreign graph mode scope', async () => {
    const own = await fixture();
    const foreign = await prepareOriginalNodeModes(
      { rootDir: own.root, projectDir: own.root, distDir: own.distDir },
      { ...own.graph },
      ['physical'],
    );

    await expect(
      useNodeManifestOriginalCommonJs({ ...own.owner, originalModes: foreign }, own.physical),
    ).rejects.toThrow('pending');
  });

  it('keeps separate-call raw source freshness mandatory', async () => {
    const own = await fixture();
    const proof = await requiredMode(own);
    await writeFile(own.file, 'module.exports=2;');

    await expect(
      assertNodeManifestOriginalCommonJs(proof, own.owner, own.physical),
    ).rejects.toThrow('source bytes changed');
  });

  it('keeps USED scope metadata freshness mandatory', async () => {
    const own = await fixture('.js', '{"type":"commonjs"}');
    const proof = await requiredMode(own);
    await writeFile(own.pkg, '{"type":"module"}');

    await expect(
      assertNodeManifestOriginalCommonJs(proof, own.owner, own.physical),
    ).rejects.toThrow('no longer CommonJS');
  });

  it('never downgrades a USED mode when the final raw file is omitted', async () => {
    const own = await fixture();
    await requiredMode(own);
    const view = await archive(own);
    view.sourcePaths.clear();

    await expect(assertFinalOriginalNodeModes(own.modes, view)).rejects.toThrow(
      'raw physical-execution source',
    );
  });
});
