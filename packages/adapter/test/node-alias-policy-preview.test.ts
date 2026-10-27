import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import { nodePhysicalFiles, type NodePhysicalFiles } from '../src/node-files.ts';
import * as NodeAliases from '../src/node-module-aliases.ts';
import * as NextRewrites from '../src/node-next-rewrite-proof.ts';
import { nodePhysicalLayout } from '../src/node-physical-layout.ts';
import { WasmCollector } from '../src/wasm.ts';

const directories: string[] = [];

async function fixture(code = 'exports.value=42;') {
  const temporary = await mkdtemp(path.join(tmpdir(), 'authored-node-alias-policy-'));
  const root = await realpath(temporary);
  directories.push(root);
  const entry = path.join(root, 'entry.js');
  await writeFile(entry, code);
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: root,
    repoRoot: root,
    outDir: path.join(root, 'output'),
    patch: {
      projectDir: root,
      distDir: path.join(root, '.next'),
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    },
    entries: [{ id: '/authored', filePath: entry }],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore(path.join(root, 'blobs')),
  };
  return { root, entry, code, input };
}

function physicalCode(physical: NodePhysicalFiles, name: string): string {
  const file = physical.files.find((candidate) => candidate.name === name);
  if (file === undefined) throw new Error('missing authored physical file');
  return new TextDecoder().decode(file.bytes);
}

describe('physical alias inventory uses only a private cache policy preview', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it('keeps raw owned bytes and source coordinates when no certificate is supplied', async () => {
    const own = await fixture();
    const preview = vi.spyOn(NextRewrites, 'previewCertifiedNodeCachePolicy');
    const physical = await nodePhysicalFiles(own.input, []);
    const name = physical.nameOf(own.entry);

    expect(physicalCode(physical, name)).toBe(own.code);
    expect(physical.sourcePaths.get(name)).toBe(own.entry);
    expect(physical.links).toStrictEqual([]);
    expect(preview).not.toHaveBeenCalled();
  });

  it('keeps an unowned existing dependency refused without a certificate', async () => {
    const own = await fixture('require("authored-dependency");');
    const dependency = path.join(own.root, 'node_modules', 'authored-dependency');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(dependency, 'index.js'), 'exports.value=42;');

    await expect(nodePhysicalFiles(own.input, [])).rejects.toThrow(
      'The first existing Node package target is outside its closed trace',
    );
  });

  it('rejects a forged proof before inventory catches or required alias work', async () => {
    const own = await fixture('require("authored-dependency");');
    const layout = await nodePhysicalLayout(own.input);
    const name = layout.nameOf(own.entry);
    const bytes = new TextEncoder().encode(own.code);
    const files = new Map([[name, bytes]]);
    const originals = new Map([[own.entry, name]]);
    const links = new Map<string, string>();
    const required = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const forged = {} as NextRewrites.NodeNextRewriteProof;

    await expect(
      NodeAliases.nodeModuleAliases({ files, originals }, layout, links, {
        collectRequiredAliases: required,
        policy: { proof: forged, input: own.input },
      }),
    ).rejects.toThrow('certificate');
    expect(required).not.toHaveBeenCalled();
    expect(files.get(name)).toBe(bytes);
    expect(originals.get(own.entry)).toBe(name);
    expect(links.size).toBe(0);
  });

  it('rejects a copied unrecognized proof before the physical metadata selector', async () => {
    const own = await fixture();
    const forged = {} as NextRewrites.NodeNextRewriteProof;
    const selector = vi
      .fn<() => Promise<readonly { readonly file: string; readonly sha256: string }[]>>()
      .mockResolvedValue([]);

    await expect(
      nodePhysicalFiles(own.input, [], [], {
        selectModeMetadata: selector,
        nextRewrites: { ...forged },
      }),
    ).rejects.toThrow('certificate');
    expect(selector).not.toHaveBeenCalled();
  });

  it('forwards the same policy context to both alias passes without replacing captured bytes', async () => {
    const own = await fixture();
    const metadata = path.join(own.root, 'metadata', 'package.json');
    const contents = '{"type":"commonjs"}';
    await mkdir(path.dirname(metadata));
    await writeFile(metadata, contents);
    const sha256 = createHash('sha256').update(contents).digest('hex');
    const aliases = vi.spyOn(NodeAliases, 'nodeModuleAliases');
    const preview = vi.spyOn(NextRewrites, 'previewCertifiedNodeCachePolicy');
    const physical = await nodePhysicalFiles(own.input, [], [], {
      selectModeMetadata: async () => {
        await writeFile(own.entry, 'require("unowned-after-copy");');
        return [{ file: metadata, sha256 }];
      },
    });
    const policies = aliases.mock.calls.map((call) => {
      const options = call[3];
      return typeof options === 'function' ? undefined : options?.policy;
    });

    expect(policies).toHaveLength(2);
    expect(policies.every((policy) => policy?.input === own.input)).toBe(true);
    expect(policies.every((policy) => policy?.proof === undefined)).toBe(true);
    expect(physicalCode(physical, physical.nameOf(own.entry))).toBe(own.code);
    expect(physical.sourcePaths.get(physical.nameOf(metadata))).toBe(metadata);
    expect(preview).not.toHaveBeenCalled();
  });
});
