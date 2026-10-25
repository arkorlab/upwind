import { assert, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import type { BuildFunctionInput } from '../src/function.ts';
import type { NodeArchiveFile } from '../src/node-archive.ts';
import { NodeArtifactFiles } from '../src/node-artifact-files.ts';
import type { NodePhysicalFiles } from '../src/node-files.ts';
import { WasmCollector } from '../src/wasm.ts';

/** No disk or application code is touched by the direct copied-file operations in these tests. */
function fixture(files: NodeArchiveFile[]): NodeArtifactFiles {
  const input: BuildFunctionInput = {
    kind: 'app',
    projectDir: '/repo',
    repoRoot: '/repo',
    outDir: '/repo/.upwind',
    patch: {
      projectDir: '/repo',
      distDir: '/repo/.next',
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    },
    entries: [],
    edgeEntries: [],
    wasm: new WasmCollector(),
    manifests: [],
    runtimeManifest: '{}',
    cacheHostModule: undefined,
    blobs: [],
    files: [],
    blobStore: new BlobStore('/repo/.upwind'),
  };
  const physical: NodePhysicalFiles = {
    files,
    links: [],
    cwd: 'project',
    instrumentation: undefined,
    nameOf: (file) => file,
  };
  return new NodeArtifactFiles(input, physical, []);
}

describe('physical Node artifact byte and mode preservation', () => {
  it.each([
    { label: 'UTF-8 BOM', prefix: [0xef, 0xbb, 0xbf] },
    { label: 'non-UTF-8 comment bytes', prefix: [0x2f, 0x2f, 0x20, 0xff] },
  ])('preserves $label when no Next patch changes the source', ({ prefix }) => {
    const suffix = new TextEncoder().encode('\nmodule.exports=42;\n');
    const bytes = new Uint8Array(prefix.length + suffix.byteLength);
    bytes.set(prefix);
    bytes.set(suffix, prefix.length);
    const expected = new Uint8Array(bytes);
    const original = { name: 'project/.next/server/chunks/data.js', bytes, executable: true };
    const files = fixture([original]);
    files.rewriteNextFiles();

    expect(files.files.get(original.name)).toBe(original);
    expect(files.files.get(original.name)?.bytes).toStrictEqual(expected);
  });

  it('retains the BOM when a real cache-write patch changes a copied Next file', () => {
    const source =
      '\u{FEFF}const key=`cache-set-${id}`;cache[key]=previous.then(()=>write).finally(done);const warning="Failed to set fetch cache";';
    const bytes = new TextEncoder().encode(source);
    const original = { name: 'project/.next/server/chunks/cache.js', bytes };
    const files = fixture([original]);
    files.rewriteNextFiles();
    const copied = files.files.get(original.name);
    assert.isDefined(copied);

    expect([...copied.bytes.subarray(0, 3)]).toStrictEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(copied.bytes).toString('utf8')).toContain(
      'globalThis[Symbol.for("arkor.fetch-cache-write")]',
    );
    expect(Buffer.from(original.bytes).toString('utf8')).toBe(source);
  });

  it('keeps the original executable metadata and byte object on an identical upsert', () => {
    const original = {
      name: 'project/bin/helper',
      bytes: new Uint8Array([1, 2]),
      executable: true,
    };
    const files = fixture([original]);
    files.add(original.name, new Uint8Array(original.bytes));

    expect(files.files.get(original.name)).toBe(original);
    expect(files.files.get(original.name)?.executable).toBe(true);
    expect(files.files.get(original.name)?.bytes).toBe(original.bytes);
  });

  it('still refuses conflicting bytes without replacing the original executable file', () => {
    const original = {
      name: 'project/bin/helper',
      bytes: new Uint8Array([1, 2]),
      executable: true,
    };
    const files = fixture([original]);

    expect(() => files.add(original.name, new Uint8Array([9]))).toThrow(
      'conflicts with a physical input',
    );
    expect(files.files.get(original.name)).toBe(original);
  });
});
