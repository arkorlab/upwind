import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { rewritePinnedNodeNextFile } from '../src/node-next-pinned-rewrite.ts';

const NEXT = path.dirname(createRequire(import.meta.url).resolve('next/package.json'));
const LOADER = 'dist/server/lib/router-utils/instrumentation-globals.external.js';
const RUNTIME = 'dist/compiled/next-server/app-page-turbo.runtime.prod.js';
const SELECTOR = 'dist/server/route-modules/app-page/module.compiled.js';
const INPUT = {
  projectDir: '/project',
  entries: [],
  patch: {
    projectDir: '/project',
    distDir: '/project/.next',
    chunks: [],
    instrumentation: undefined,
    wasm: [],
  },
};

async function original(relative: string) {
  const file = await realpath(path.join(NEXT, relative));
  return { file, code: await readFile(file, 'utf8') };
}

describe('pinned Next.js rewrites for an artifact no proof certifies', () => {
  it.each([
    [false, 'await ({})'],
    [true, 'await require("/bundle/upwind/instrumentation.cjs")'],
  ])('points the reviewed hook loader at the artifact (hook: %s)', async (hook, call) => {
    const rewritten = rewritePinnedNodeNextFile(INPUT, await original(LOADER), hook);

    expect(rewritten?.contents).toContain(call);
    expect(rewritten?.applied.map((applied) => applied.patch)).toStrictEqual(['instrumentation']);
  });

  it('guards the reviewed page runtime against custom cache handlers', async () => {
    const rewritten = rewritePinnedNodeNextFile(INPUT, await original(RUNTIME), false);

    expect(rewritten?.applied.map((applied) => applied.patch)).toContain(
      'node-custom-cache-policy',
    );
    expect(rewritten?.contents).toContain('cacheHandlers is unsupported in native Node Functions');
  });

  it.each([LOADER, RUNTIME])('refuses changed bytes at the policy target %s', async (relative) => {
    const source = await original(relative);

    expect(() =>
      rewritePinnedNodeNextFile(INPUT, { ...source, code: `${source.code}\n` }, false),
    ).toThrow('refusing native publication');
  });

  it('leaves the Turbopack selector to the bootstrap', async () => {
    expect(rewritePinnedNodeNextFile(INPUT, await original(SELECTOR), false)).toBeUndefined();
  });

  it('leaves an ordinary chunk as it is', () => {
    expect(
      rewritePinnedNodeNextFile(
        INPUT,
        { file: '/project/.next/server/chunks/ssr/chunk.js', code: 'exports.chunk=1;' },
        false,
      ),
    ).toBeUndefined();
  });
});
