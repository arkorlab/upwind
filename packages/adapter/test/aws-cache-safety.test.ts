import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { strictAwsCacheSource } from '../src/native/aws-cache-safety.ts';

describe('AWS native cache safety compilation', () => {
  it.each([100, -1_000_000])(
    'rejects an unconfirmed tag view with invalidation time %i',
    async (invalidatedAt) => {
      const source = await readFile(
        new URL('../../runtime/src/cache/pulls.ts', import.meta.url),
        'utf8',
      );
      const compiled = strictAwsCacheSource(source, 'pulls');
      const body = compiled
        .slice(compiled.indexOf('export async function catchUpWithScope('))
        .replace('export ', '');
      const runtime = { tags: { revision: 1 }, holdMs: 5000 };
      // Execute the generated function from the real runtime source with a stalled delta boundary.
      const catchUp = runInNewContext(`${stripTypeScriptTypes(body)}; catchUpWithScope`, {
        scopeOf: async () => ({ revision: 2, invalidatedAt }),
        nowMs: () => 100,
        RECENT_INVALIDATION_MS: 600_000,
        SCOPE_CATCH_UP_MS: 1000,
        catchUp: async () => undefined,
        settledWithin: async (work: Promise<void>) => work,
        performance: { now: () => 100 },
      }) as (
        cache: typeof runtime,
        request: Request,
        waitUntil: (work: Promise<unknown>) => void,
      ) => Promise<void>;
      const waitUntil = (work: Promise<unknown>): void => {
        void work.catch(() => undefined);
      };
      await expect(
        catchUp(runtime, new Request('https://example.com'), waitUntil),
      ).rejects.toMatchObject({ status: 503 });
      runtime.tags.revision = 2;
      await expect(
        catchUp(runtime, new Request('https://example.com'), waitUntil),
      ).resolves.toBeUndefined();
    },
  );

  it('returns cache failures as private 503 responses on the AWS entry', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../runtime/src/function.ts', import.meta.url)),
      'utf8',
    );
    const compiled = strictAwsCacheSource(source, 'function');
    expect(compiled).toContain("Reflect.get(error, 'status') === 503 ? 503");
    expect(compiled).toContain("'cache-control': 'private, no-store'");
  });

  it('stops a build when its private runtime changes', () => {
    expect(() => strictAwsCacheSource('changed', 'pulls')).toThrow('no longer matches');
  });
});
