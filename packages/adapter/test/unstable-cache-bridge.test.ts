import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

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
