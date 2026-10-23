import { describe, expect, it } from 'vitest';

import { workerForm, type WorkerMetadata } from '../../src/deploy/cloudflare/form.ts';

const METADATA: WorkerMetadata = {
  main_module: 'index.mjs',
  compatibility_date: '2026-09-15',
  compatibility_flags: ['nodejs_compat'],
  bindings: [
    { type: 'secret_text', name: 'TOKEN', text: 'secret' },
    { type: 'd1', name: 'DB', id: 'database-uuid' },
    {
      type: 'service',
      name: 'ARKOR_PREFETCH',
      service: 'shop-prefetch',
      entrypoint: 'PrefetchForDeployment',
      props: { allowedSha256: { ['a'.repeat(64)]: true } },
    },
  ],
};

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("a Worker's upload", () => {
  it('carries the configuration, and each module with the content type of its kind', async () => {
    const form = workerForm(METADATA, [
      { name: 'index.mjs', type: 'esm', bytes: bytes('export default {}') },
      { name: 'app.cjs', type: 'commonjs', bytes: bytes('module.exports = {}') },
      { name: 'runtime.json', type: 'text', bytes: bytes('{}') },
      { name: 'add.wasm', type: 'wasm', bytes: new Uint8Array([0, 97, 115, 109]) },
      { name: 'blobs/abc', type: 'data', bytes: new Uint8Array([1, 2]) },
    ]);
    const metadata = form.get('metadata') as File;

    expect(metadata.type).toBe('application/json');
    expect(JSON.parse(await metadata.text())).toStrictEqual(METADATA);

    const types = Object.fromEntries(
      [...form]
        .filter(([name]) => name !== 'metadata')
        .map(([name, value]) => [name, (value as File).type]),
    );

    expect(types).toStrictEqual({
      'index.mjs': 'application/javascript+module',
      'app.cjs': 'application/javascript',
      'runtime.json': 'text/plain',
      'add.wasm': 'application/wasm',
      'blobs/abc': 'application/octet-stream',
    });
  });

  it('refuses a module the configuration would be read from', () => {
    expect(() => {
      return workerForm(METADATA, [
        { name: 'index.mjs', type: 'esm', bytes: bytes('') },
        { name: 'metadata', type: 'text', bytes: bytes('') },
      ]);
    }).toThrow(/read as the Worker's configuration/u);
  });

  it('refuses a main module it does not carry, and a name given twice', () => {
    expect(() =>
      workerForm(METADATA, [{ name: 'other.mjs', type: 'esm', bytes: bytes('') }]),
    ).toThrow(/main module index\.mjs/u);
    expect(() => {
      return workerForm(METADATA, [
        { name: 'index.mjs', type: 'esm', bytes: bytes('') },
        { name: 'index.mjs', type: 'esm', bytes: bytes('') },
      ]);
    }).toThrow(/two modules/u);
  });
});
