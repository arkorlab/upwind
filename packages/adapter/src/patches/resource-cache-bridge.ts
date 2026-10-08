import {
  isResourceCacheBridgeSource,
  resourceCacheBridge,
  resourceCacheBridgeRevalidations,
} from '@stayingupwind/core/next';

import { occurrencesOf, type Patch, Rewrite } from './types.ts';

export const resourceCacheBridgePatch: Patch = {
  name: 'resource-cache-bridge',
  target:
    // eslint-disable-next-line require-unicode-regexp -- a Go bundler filter, not an ECMAScript regular expression
    /(?:\/next\/dist\/(?:esm\/)?server\/(?:use-cache\/use-cache-wrapper|web\/spec-extension\/revalidate)|\/server\/(?:chunks|app|pages)\/.+)\.js$/,
  marker: isResourceCacheBridgeSource,
  reaches: ['module', 'esm-module', 'build-output'],
  apply(source, file) {
    const check = new Rewrite('resource-cache-bridge', file, source);
    let result: ReturnType<typeof resourceCacheBridge>;
    try {
      result = resourceCacheBridge(source);
    } catch (error) {
      throw check.fail(error instanceof Error ? error.message : String(error));
    }
    const expected =
      occurrencesOf(
        source,
        /(?<![\w$.])(?:[\w$]+\.)?workUnitAsyncStorage\.run\(\s*[\w$]+\s*,\s*\(\)\s*=>\s*(?:[\w$]+\.)?dynamicAccessAsyncStorage\.run\(/gu,
      ) +
      occurrencesOf(source, /(?<![\w$.])[\w$]+\.runInCleanSnapshot\([\w$]+,\s*[\w$]+,/gu) +
      resourceCacheBridgeRevalidations(source);
    if (result.edits !== expected)
      throw check.fail(`expected ${expected} Next context registration(s), found ${result.edits}`);
    return { ...result, notes: [] };
  },
};
