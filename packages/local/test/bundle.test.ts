import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertHostOnly, type BundledWorker, bundleWorker } from '../src/bundle.ts';

/** A package of the given name at `dir` under `root`, or a directory with no name of its own. */
function packageAt(root: string, dir: string, name?: string): void {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(
    path.join(root, dir, 'package.json'),
    JSON.stringify(name === undefined ? { private: true } : { name }),
  );
}

/** A Worker as esbuild would describe one bundled from these modules, by their path from `root`. */
function bundledFrom(root: string, inputs: readonly string[]): BundledWorker {
  return {
    entry: path.join(root, inputs[0] ?? ''),
    script: '',
    root,
    metafile: {
      inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 0, imports: [] }])),
      outputs: {},
    },
  };
}

describe('a Worker of a local stack', () => {
  it('bundles the standalone cache from upwind’s own packages and their dependencies alone', async () => {
    const entry = fileURLToPath(import.meta.resolve('@stayingupwind/cache/standalone/worker'));

    const worker = await bundleWorker(entry);

    expect(() => {
      assertHostOnly(worker);
    }).not.toThrow();
    expect(worker.script).toContain('upwind-cache-token');
  });

  it('is refused for a module of another package, or of none, and not for a dependency’s', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    packageAt(root, 'own', '@stayingupwind/own');
    packageAt(root, 'host', '@example/host');
    packageAt(root, 'own/dist');
    const worker = bundledFrom(root, [
      'own/index.ts',
      'own/dist/nested.js',
      'host/index.ts',
      'node_modules/dependency/index.js',
      'loose.ts',
    ]);

    expect(() => {
      assertHostOnly(worker);
    }).toThrow(
      `bundles modules of no package of upwind's own: ${path.join(root, 'host/index.ts')} (@example/host), ${path.join(root, 'loose.ts')} (no package)`,
    );
  });
});
