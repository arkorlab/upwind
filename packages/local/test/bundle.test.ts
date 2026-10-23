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

/** A Worker bundled from these modules, by their path from `root`. */
function bundledFrom(root: string, inputs: readonly string[]): BundledWorker {
  return {
    entry: path.join(root, inputs[0] ?? ''),
    script: '',
    root,
    inputs,
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

  it('keeps Worker conditions and runtime imports while bundling dynamic imports into the same module', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    packageAt(root, 'own', '@stayingupwind/own');
    const dependency = path.join(root, 'own/node_modules/conditional');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      path.join(dependency, 'package.json'),
      JSON.stringify({
        type: 'module',
        exports: { workerd: './worker.js', browser: './browser.js', default: './fallback.js' },
      }),
    );
    for (const name of ['worker', 'browser', 'fallback']) {
      writeFileSync(path.join(dependency, `${name}.js`), `export default '${name}-condition';`);
    }
    writeFileSync(path.join(root, 'own/lazy.js'), "export default 'lazy-worker-module';");
    const entry = path.join(root, 'own/index.js');
    writeFileSync(
      entry,
      `import condition from 'conditional';
       import { WorkerEntrypoint } from 'cloudflare:workers';
       import { randomUUID } from 'node:crypto';
       export class Rpc extends WorkerEntrypoint { name() { return condition; } }
       export default { async fetch() { return new Response(condition + randomUUID() + (await import('./lazy.js')).default); } };`,
    );

    const worker = await bundleWorker(entry);

    expect(worker.script).toContain('worker-condition');
    expect(worker.script).not.toContain('browser-condition');
    expect(worker.script).not.toContain('fallback-condition');
    expect(worker.script).toContain('cloudflare:workers');
    expect(worker.script).toContain('node:crypto');
    expect(worker.script).toContain('lazy-worker-module');
    expect(worker.script).not.toContain("import('./lazy.js')");
    expect(() => {
      assertHostOnly(worker);
    }).not.toThrow();
  });

  it('loads a bundled dynamic module only when imported', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    const marker = '__upwindRolldownLazyTest';
    const entry = path.join(root, 'entry.js');
    writeFileSync(entry, "export default () => import('./lazy.js');");
    writeFileSync(
      path.join(root, 'lazy.js'),
      `globalThis.${marker} = true; export default 'loaded';`,
    );
    Reflect.deleteProperty(globalThis, marker);
    try {
      const worker = await bundleWorker(entry);
      const module = (await import(
        `data:text/javascript;base64,${Buffer.from(worker.script).toString('base64')}`
      )) as { default: () => Promise<{ default: string }> };

      expect(Reflect.get(globalThis, marker)).toBeUndefined();
      expect((await module.default()).default).toBe('loaded');
      expect(Reflect.get(globalThis, marker)).toBe(true);
    } finally {
      Reflect.deleteProperty(globalThis, marker);
    }
  });

  it('refuses unresolved dependencies instead of uploading an incomplete Worker', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    const entry = path.join(root, 'entry.js');
    writeFileSync(
      entry,
      "import missing from 'upwind-package-that-does-not-exist'; export default missing;",
    );

    await expect(bundleWorker(entry)).rejects.toThrow('upwind-package-that-does-not-exist');
  });

  it('retains ownership evidence for a foreign source removed by tree shaking', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'upwind-local-'));
    packageAt(root, 'own', '@stayingupwind/own');
    packageAt(root, 'foreign', '@example/foreign');
    const foreign = path.join(root, 'foreign/index.js');
    writeFileSync(foreign, "export const unused = 'foreign-unused-module';");
    const entry = path.join(root, 'own/index.js');
    writeFileSync(
      entry,
      "import { unused } from '../foreign/index.js'; export default { fetch() { return new Response('own'); } };",
    );

    const worker = await bundleWorker(entry);

    expect(worker.inputs).toContain(foreign);
    expect(worker.script).not.toContain('foreign-unused-module');
    expect(() => {
      assertHostOnly(worker);
    }).toThrow('@example/foreign');
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
