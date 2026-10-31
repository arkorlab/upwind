import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { loadBindings, minify } from 'next/dist/build/swc/index.js';
import { describe, expect, it } from 'vitest';

import { resourceCacheBridgePatch } from '../src/patches/resource-cache-bridge.ts';
import type { PatchContext } from '../src/patches/types.ts';

const require = createRequire(import.meta.url);
const context: PatchContext = {
  projectDir: '/workspace/app',
  distDir: '/workspace/app/.next',
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};
const root = path.dirname(require.resolve('next/package.json'));

describe('native unstable_cache storage registration', () => {
  it.each(['dist/server', 'dist/esm/server'])(
    'covers cold and background callback runs in %s',
    async (directory) => {
      const file = path.join(root, directory, 'web/spec-extension/unstable-cache.js');
      const source = await readFile(file, 'utf8');

      expect(resourceCacheBridgePatch.target.test(file)).toBe(true);
      expect(resourceCacheBridgePatch.marker?.(source)).toBe(true);

      const result = resourceCacheBridgePatch.apply(source, file, context);

      expect(result.edits).toBe(6);
      expect(result.contents.match(/Symbol\.for\("upwind.next-cache-storage@1"\)/gu)).toHaveLength(
        3,
      );

      await expect(readFile(file, 'utf8')).resolves.toBe(source);
    },
  );

  it('covers the actual native provider after Next minifies its declarations', async () => {
    const file = path.join(root, 'dist/server/web/spec-extension/unstable-cache.js');
    const source = await readFile(file, 'utf8');
    await loadBindings();
    const compressed = await minify(source, { compress: true, mangle: true, module: false });

    expect(compressed.code).toMatch(/,\s*[\w$]+=\{type:["'`]unstable-cache/u);

    const result = resourceCacheBridgePatch.apply(compressed.code, file, context);

    expect(result.edits).toBe(6);
    expect(result.contents.match(/Symbol\.for\("upwind.next-cache-storage@1"\)/gu)).toHaveLength(3);
  });

  it.each(['"unstable-cache"', "'unstable-cache'", '`unstable-cache`'])(
    'links a combined initializer with the exact static literal %s to its native storage',
    (literal) => {
      const source =
        `let previous=0,store={type:${literal}};` +
        'storage.workUnitAsyncStorage.run(store,callback);' +
        'throw Error("incrementalCache missing in unstable_cache")';

      const result = resourceCacheBridgePatch.apply(
        source,
        '/workspace/app/.next/server/chunks/cache.js',
        context,
      );

      expect(result.edits).toBe(2);
      expect(result.contents).toContain(
        '(globalThis[Symbol.for("upwind.next-cache-storage@1")]?.(storage.workUnitAsyncStorage)??storage.workUnitAsyncStorage).run(store,callback)',
      );
    },
  );

  it.each([
    `let previous=0,store={type:\`unstable-cache\${value}\`};storage.workUnitAsyncStorage.run(store,callback);`,
    'let previous=0,store={type:"unstable-cache\'};storage.workUnitAsyncStorage.run(store,callback);',
    'let previous=0,store={type:"cache"};storage.workUnitAsyncStorage.run(store,callback);',
    'let previous=0,store={type:"unstable-cache"};storage.workUnitAsyncStorage.run(other,callback);',
    'let previous=0,store={type:"unstable-cache"};unrelated.run(store,callback);',
    'object.store={type:"unstable-cache"};storage.workUnitAsyncStorage.run(store,callback);',
    'previous,object.store={type:"unstable-cache"};storage.workUnitAsyncStorage.run(store,callback);',
  ])('refuses an unproven initializer or storage link (%s)', (provider) => {
    expect(() => {
      return resourceCacheBridgePatch.apply(
        `${provider}throw Error("incrementalCache missing in unstable_cache")`,
        '/workspace/app/.next/server/chunks/cache.js',
        context,
      );
    }).toThrow('Next unstable cache context was not found');
  });

  it('fails closed if a native provider no longer exposes its callback storage', () => {
    expect(() => {
      return resourceCacheBridgePatch.apply(
        'throw Error("incrementalCache missing in unstable_cache")',
        '/workspace/app/.next/server/chunks/cache.js',
        context,
      );
    }).toThrow('Next unstable cache context was not found');
  });
});
