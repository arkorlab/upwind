import { packPrerenders } from '@stayingupwind/core/bundle';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getStore } from '../src/store.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

/**
 * What an isolate keeps of the blobs its bundle carries. Each one it reads is copied out of the
 * bundle, and the copies it keeps have to stay within a budget however many a deployment has:
 * the build's documents, their states and the files the Worker carries can come to far more than
 * the isolate has room for.
 */

const MIB = 1024 * 1024;
const BUDGET_MIB = 8;

const bundle = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), reads: [] as string[] }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    // The Worker's own bundle, as its virtual file system serves it.
    readFileSync: ((path: string) => {
      bundle.reads.push(path);
      const bytes = bundle.files.get(path);
      if (bytes === undefined) {
        throw new Error(`no such file ${path}`);
      }
      return Buffer.from(bytes);
    }) as typeof original.readFileSync,
  };
});

function ship(name: string, byteLength: number): void {
  bundle.files.set(`/bundle/blobs/${name}`, new Uint8Array(byteLength));
}

/** The blobs read out of the bundle since the test began, in order. */
function blobReads(): string[] {
  return bundle.reads.filter((path) => path.startsWith('/bundle/blobs/'));
}

describe("the bundle's blobs", () => {
  beforeEach(() => {
    const manifest = {
      buildId: 'build',
      config: {},
      routing: { dynamicRoutes: [] },
      entrypoints: [],
      prerenders: packPrerenders([]),
      staticFiles: [],
    };
    bundle.files.set('/bundle/runtime.json', new TextEncoder().encode(JSON.stringify(manifest)));
    bundle.reads.length = 0;
  });

  it('keeps no more copies than its budget holds, and reads again what it let go', () => {
    const store = getStore();
    for (let index = 0; index <= BUDGET_MIB; index += 1) {
      ship(`mib-${index}`, MIB);
      store.readBlob(`mib-${index}`);
    }
    bundle.reads.length = 0;

    // The most recent eight are what the budget holds, and reading them reads nothing again.
    for (let index = BUDGET_MIB; index >= 1; index -= 1) {
      store.readBlob(`mib-${index}`);
    }

    expect(blobReads()).toStrictEqual([]);

    // The first went when the ninth came in.
    store.readBlob('mib-0');

    expect(blobReads()).toStrictEqual(['/bundle/blobs/mib-0']);
  });

  it('never keeps a blob larger than the whole budget, and still reads it whole', () => {
    const store = getStore();
    ship('large', (BUDGET_MIB + 1) * MIB);

    expect(store.readBlob('large').byteLength).toBe((BUDGET_MIB + 1) * MIB);
    expect(store.readBlob('large').byteLength).toBe((BUDGET_MIB + 1) * MIB);
    expect(blobReads()).toStrictEqual(['/bundle/blobs/large', '/bundle/blobs/large']);
  });
});
