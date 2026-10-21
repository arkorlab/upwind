import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { type PatchContext, PatchError } from '../src/patches/types.ts';
import { useCacheCrossRequestPatch } from '../src/patches/use-cache-cross-request.ts';

const CONTEXT: PatchContext = {
  projectDir: '/workspace/app',
  distDir: '/workspace/app/.next',
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};
const CHUNK = '/workspace/app/.next/server/chunks/ssr/node_modules_next_dist_0a1b2c._.js';
const CJS = 'dist/server/use-cache/use-cache-wrapper.js';
const ESM = 'dist/esm/server/use-cache/use-cache-wrapper.js';
/** What `cache()` throws without a work store, as a chunk spells it. */
const REFUSAL = `throw Error('"use cache" cannot be used outside of App Router. Expected a WorkStore.');`;
const ANOTHER_REQUESTS = 'another request’s entry';
const FILLED = 'filled by this request';

/** Next.js's own copy of the wrapper, as the repository installs it. */
async function installed(relative: string): Promise<{ file: string; source: string }> {
  const require = createRequire(import.meta.url);
  const file = path.join(path.dirname(require.resolve('next/package.json')), relative);
  return { file, source: await readFile(file, 'utf8') };
}

function apply(source: string, file = CHUNK) {
  return useCacheCrossRequestPatch.apply(source, file, CONTEXT);
}

/**
 * The two reads as a 16.4 chunk has them (`next build` of `fixtures/next-minimal` with 16.4.2): the
 * flag folded to `X&&!0||_.isDraftMode` and declared as `f`, the lookup `f?void 0:J.get(aB)`, and
 * the registration `f||(…)`.
 */
const SHAPE_16_4 =
  'let f=X&&!0||_.isDraftMode;try{for(;void 0===W;){let d,e,g=f?void 0:J.get(aB);if(g){let a=(0,h.getCacheSignal)(aa);null==a||a.beginRead(),null==L||L(Y,"joining pending cross-request invocation",aB);let d=await g;}' +
  'f||(null==L||L(Y,"registering as cross-request invocation leader",aB),c.registerIn(J,aB));let i=(0,h.getCacheSignal)(aa);}}catch(a){throw c.reject(a),a}';
/** The same in a 16.3 chunk (16.3.0), whose flag has no draft-mode term and whose messages no prefix. */
const SHAPE_16_3 =
  'let e=H&&!0;try{for(;void 0===D;){let d,f=e?void 0:F.get(ao);if(f){let a=(0,h.getCacheSignal)(R);null==a||a.beginRead(),null==G||G("joining pending cross-request invocation",ao);let d=await f;}' +
  'e||(null==G||G("registering as cross-request invocation leader",ao),c.registerIn(F,ao));let g=(0,h.getCacheSignal)(R);}}catch(a){throw c.reject(a),a}';

/** A copy of the wrapper in a chunk: the refusal, a fill under a clean snapshot, and the reads. */
function chunkOf(shape: string): string {
  return `${REFUSAL}let d=Q.pendingCacheInvocations??=new Map;Q.runInCleanSnapshot(n,Q,a);${shape}`;
}

/**
 * The 16.4 shape, made to run: `lookup` is one request's invocation of a key, `J` the map the other
 * requests in the isolate register theirs in, and `registered` which map each registration went to.
 */
const RUNNABLE = [
  'const c = { registerIn: (map) => registered.push(map === J ? "across requests" : "within the request") };',
  'const L = undefined;',
  'lookup = async (X, aB) => {',
  '  const _ = { isDraftMode: false, pendingCacheInvocations: new Map() };',
  `  if (_ === undefined) { ${REFUSAL} }`,
  '  c.registerIn(_.pendingCacheInvocations, aB);',
  '  let f=X&&!0||_.isDraftMode;',
  '  let d,e,g=f?void 0:J.get(aB);if(g){null==L||L(Y,"joining pending cross-request invocation",aB);return await g;}',
  '  f||(null==L||L(Y,"registering as cross-request invocation leader",aB),c.registerIn(J,aB));',
  `  return "${FILLED}";`,
  '};',
].join('\n');

interface Isolate {
  readonly J: Map<string, Promise<string>>;
  readonly registered: string[];
  lookup?: (isPrivate: boolean, key: string) => Promise<string>;
}

/** `source` evaluated where another request has an invocation of `key` under way. */
function isolateWith(source: string): Isolate {
  const isolate: Isolate = {
    J: new Map([['key', Promise.resolve(ANOTHER_REQUESTS)]]),
    registered: [],
  };
  // eslint-disable-next-line sonarjs/code-eval -- evaluates the test's own few lines, not application code
  runInNewContext(source, isolate);
  return isolate;
}

describe('the "use cache" wrapper Next.js ships', () => {
  it.each([CJS, ESM])('is claimed in %s', async (relative) => {
    const { file, source } = await installed(relative);

    expect(useCacheCrossRequestPatch.target.test(file)).toBe(true);
    expect(useCacheCrossRequestPatch.marker?.(source)).toBe(true);
  });

  it.each([CJS, ESM])('reads true where %s reads skipCrossRequestDedupe', async (relative) => {
    const { file, source } = await installed(relative);
    const result = apply(source, file);

    expect(result.edits).toBe(2);
    expect(result.contents).toContain(
      'const crossRequestPendingCacheInvocation = true ? undefined : crossRequestPendingCacheInvocations.get(cacheHandlerKey);',
    );
    expect(result.contents).toMatch(
      /if \(!true\) \{\s*debug == null \? void 0 : debug\(logPrefix, 'registering as cross-request invocation leader'/u,
    );
    expect(result.contents).not.toMatch(/!skipCrossRequestDedupe|skipCrossRequestDedupe \?/u);
    expect(result.contents).toContain('const skipCrossRequestDedupe = ');
  });

  it('leaves the deduplication within a request as it is', async () => {
    const { file, source } = await installed(CJS);
    const { contents } = apply(source, file);

    expect(contents).toContain(
      'resolvableSharedCacheResult.registerIn(intraRequestPendingCacheInvocations, serializedCacheKey, completedCacheInvocations);',
    );
    expect(contents).toContain(
      '(_workStore_pendingCacheInvocations = workStore.pendingCacheInvocations) == null ? void 0 : _workStore_pendingCacheInvocations.get(serializedCacheKey);',
    );
  });

  it('fails the build where a third read of the flag would be left as it was', async () => {
    const { file, source } = await installed(CJS);

    expect(() => apply(`${source}\nif (skipCrossRequestDedupe) {}\n`, file)).toThrow(
      /a read of skipCrossRequestDedupe is still there/u,
    );
  });

  it('fails the build where the lookup is no longer the shape it reads', async () => {
    const { file, source } = await installed(CJS);
    const moved = source.replace(
      'skipCrossRequestDedupe ? undefined :',
      '(skipCrossRequestDedupe) ? undefined :',
    );

    expect(moved).not.toBe(source);
    expect(() => apply(moved, file)).toThrow(/the lookup of another request's invocation/u);
  });
});

describe('the wrapper a build compiled into a chunk', () => {
  it.each([
    ['16.4', SHAPE_16_4, 'g=true?void 0:J.get(aB)', 'true||(null==L||L(Y,"registering'],
    ['16.3', SHAPE_16_3, 'f=true?void 0:F.get(ao)', 'true||(null==G||G("registering'],
  ])('reads true where a %s chunk reads the flag', (_version, shape, lookup, guard) => {
    const result = apply(chunkOf(shape));

    expect(result.edits).toBe(2);
    expect(result.contents).toContain(lookup);
    expect(result.contents).toContain(guard);
  });

  it('rewrites every copy a chunk holds', () => {
    const result = apply(`${chunkOf(SHAPE_16_4)};${chunkOf(SHAPE_16_3)}`);

    expect(result.edits).toBe(4);
    expect(result.notes).toStrictEqual([
      '2 copy/copies of the wrapper, joined within a request alone',
    ]);
  });

  it('joins another request’s invocation as Next.js wrote it', async () => {
    const isolate = isolateWith(RUNNABLE);

    await expect(isolate.lookup?.(false, 'key')).resolves.toBe(ANOTHER_REQUESTS);
    await expect(isolate.lookup?.(false, 'other')).resolves.toBe(FILLED);
    expect(isolate.registered).toContain('across requests');
  });

  it('neither joins nor registers across requests once rewritten', async () => {
    const isolate = isolateWith(apply(RUNNABLE).contents);

    await expect(isolate.lookup?.(false, 'key')).resolves.toBe(FILLED);
    await expect(isolate.lookup?.(false, 'other')).resolves.toBe(FILLED);
    expect(isolate.registered).toStrictEqual(['within the request', 'within the request']);
    expect([...isolate.J.keys()]).toStrictEqual(['key']);
  });

  it.each([
    ['a registration guarded another way', chunkOf(SHAPE_16_4.replace('f||(', '!f&&('))],
    ['a lookup guarded another way', chunkOf(SHAPE_16_4.replace('f?void 0:', '!f&&'))],
    [
      'the deduplication without the messages beside its reads',
      chunkOf(SHAPE_16_4.replaceAll(/"(?:joining|registering)[^"]*"/gu, '"x"')),
    ],
    ['one read twice to a copy', chunkOf(`${SHAPE_16_4};${SHAPE_16_4}`)],
  ])('fails the build on %s', (_label, source) => {
    expect(() => apply(source)).toThrow(PatchError);
  });
});

describe('a wrapper that deduplicates nothing', () => {
  /** 16.2's: the same refusal and the same fill, and neither map. */
  const SIXTEEN_TWO = `${REFUSAL}let o=await t.runInCleanSnapshot(n,t,a);return o`;

  it('is claimed, and left exactly as it is', () => {
    expect(useCacheCrossRequestPatch.marker?.(SIXTEEN_TWO)).toBe(true);
    expect(apply(SIXTEEN_TWO)).toStrictEqual({
      contents: SIXTEEN_TWO,
      edits: 0,
      notes: ['1 copy/copies of the wrapper, deduplicating nothing'],
    });
  });
});

describe('what the patch is not for', () => {
  it.each([
    '/workspace/app/node_modules/next/dist/compiled/next-server/app-page.runtime.prod.js',
    '/workspace/app/.next/server/edge/chunks/wrapper.js',
    '/workspace/app/node_modules/next/dist/server/use-cache/handlers.js',
  ])('does not target %s', (file) => {
    expect(useCacheCrossRequestPatch.target.test(file)).toBe(false);
  });

  it.each([
    [
      'a chunk that only logs the same words',
      'log("joining pending cross-request invocation");runInCleanSnapshot()',
    ],
    ['a chunk with the refusal and no fill', `${REFUSAL}${SHAPE_16_4}`],
  ])('does not claim %s', (_label, source) => {
    expect(useCacheCrossRequestPatch.marker?.(source)).toBe(false);
  });
});
