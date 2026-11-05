import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type * as Swc from 'next/dist/build/swc/index.js';
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
const RELEASES = [
  { version: '16.4.3', root: path.dirname(require.resolve('next-16-4-3/package.json')) },
  { version: '16.4.4', root: path.dirname(require.resolve('next-16-4-4/package.json')) },
  { version: '16.4.5', root: path.dirname(require.resolve('next/package.json')) },
] as const;
const MODULES = RELEASES.flatMap((release) =>
  ['dist/server', 'dist/esm/server'].map((directory) => ({ ...release, directory })),
);

function compilerOf(root: string): typeof Swc {
  // eslint-disable-next-line security/detect-non-literal-require -- Only the three installed release roots above reach this test helper.
  return require(path.join(root, 'dist/build/swc/index.js')) as typeof Swc;
}

describe('native unstable_cache storage registration', () => {
  it('leaves application chunks quoting native error text untouched', () => {
    const source = 'export const message = "incrementalCache missing in unstable_cache";';

    expect(resourceCacheBridgePatch.marker?.(source)).toBe(false);
    expect(
      resourceCacheBridgePatch.apply(source, '/app/.next/server/chunks/help.js', context),
    ).toMatchObject({ contents: source, edits: 0 });
  });

  it.each(MODULES)(
    'covers cold and background callback runs in $version $directory',
    async ({ root, version, directory }) => {
      const manifest: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      const file = path.join(root, directory, 'web/spec-extension/unstable-cache.js');
      const source = await readFile(file, 'utf8');

      expect(manifest).toMatchObject({ version });
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

  it.each(RELEASES)(
    'covers the native $version provider after its own minifier',
    async ({ root }) => {
      const { loadBindings, minify } = compilerOf(root);
      const file = path.join(root, 'dist/server/web/spec-extension/unstable-cache.js');
      const source = await readFile(file, 'utf8');
      await loadBindings();
      const compressed = await minify(source, { compress: true, mangle: true, module: false });

      expect(compressed.code).toMatch(/,\s*[\w$]+=\{type:["'`]unstable-cache/u);

      const result = resourceCacheBridgePatch.apply(compressed.code, file, context);

      expect(result.edits).toBe(6);
      expect(result.contents.match(/Symbol\.for\("upwind.next-cache-storage@1"\)/gu)).toHaveLength(
        3,
      );
    },
  );

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
        'function unstable_cache(){throw Error("incrementalCache missing in unstable_cache")}',
        '/workspace/app/.next/server/chunks/cache.js',
        context,
      );
    }).toThrow('Next unstable cache context was not found');
  });
});
