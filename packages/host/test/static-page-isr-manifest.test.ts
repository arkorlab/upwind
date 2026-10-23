import type { Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Exercise the actual deploy table writer beside the host producer. */
import { staticPagesOf } from '../../deploy/src/static-pages.ts';
import { seedRouteFor } from '../src/bundle/cache-seed.ts';
import { commitOutputSchema } from '../src/cache/gateway-contract.ts';
import { seedOutputSchema } from '../src/cache/scope-contract.ts';
import { ISR_PAGE, isrPageBundle, STATIC_PAGE, staticPageBundle } from './static-page-fixture.ts';

const SCOPE = 'scope_isr';
const GENERATED_AT = 1_800_000_000_000;

async function seeded(bundle: ReturnType<typeof isrPageBundle>, page: Prerender) {
  const result = await seedRouteFor(bundle, page, { scopeId: SCOPE, generatedAt: GENERATED_AT });
  const output = result?.input.generation.outputs[0];
  if (result === undefined || output === undefined) throw new Error('Missing seed fixture');
  return { input: result.input, output };
}

describe('the Host carries separately versioned ISR representation authority', () => {
  it.each(['/', '/news'])('binds build proof and table expectation to %s', async (pathname) => {
    const page = { ...ISR_PAGE, id: pathname, route: pathname, pathname };
    const bundle = isrPageBundle(page);
    const { input, output } = await seeded(bundle, page);
    const { entryId } = await deriveEntry(SCOPE, input.descriptor);

    expect(seedOutputSchema.parse(output).staticPagePrivacy).toBe(2);
    expect(input.generation.policy.revalidateAfter).toStrictEqual({ kind: 'finite', seconds: 2 });
    await expect(staticPagesOf(bundle, SCOPE)).resolves.toStrictEqual([
      { pathname, route: pathname, entryId, staticPagePrivacy: 2 },
    ]);
  });

  it('keeps build-only version one unchanged in a version-two bundle', async () => {
    const bundle = isrPageBundle(STATIC_PAGE);
    const { output } = await seeded(bundle, STATIC_PAGE);
    const [mapping] = await staticPagesOf(bundle, SCOPE);

    expect(output.staticPagePrivacy).toBe(1);
    expect(mapping).not.toHaveProperty('staticPagePrivacy');
  });

  it('never upgrades an old bundle or a substituted non-member output', async () => {
    const old = await seeded(staticPageBundle(ISR_PAGE), ISR_PAGE);
    const substituted = await seeded(isrPageBundle(), { ...ISR_PAGE });

    expect([old.output.staticPagePrivacy, substituted.output.staticPagePrivacy]).toStrictEqual([
      undefined,
      undefined,
    ]);
    await expect(staticPagesOf(staticPageBundle(ISR_PAGE), SCOPE)).resolves.toStrictEqual([]);
  });

  it('does not carry HTML authority onto the Pages data twin', async () => {
    const data: Prerender = {
      ...ISR_PAGE,
      id: 'data',
      pathname: '/_next/data/build/something.json',
      body: { sha256: 'b'.repeat(64), byteLength: 20, contentType: 'application/json' },
    };
    const bundle = { ...isrPageBundle(), prerenders: [ISR_PAGE, data] };
    const { input } = await seeded(bundle, ISR_PAGE);

    expect(input.generation.outputs.map((output) => output.staticPagePrivacy)).toStrictEqual([
      2,
      undefined,
    ]);
  });

  it('retains no-transform without copying application freshness into the pack', async () => {
    const page = {
      ...ISR_PAGE,
      initialHeaders: { 'content-type': 'text/html', 'cache-control': 'public, s-maxage=2' },
    };
    const bundle = isrPageBundle(page);
    bundle.routing.beforeMiddleware = [
      {
        sourceRegex: '^/something$',
        headers: { 'CDN-Cache-Control': 's-maxage=60, no-transform' },
      },
    ];
    const { input, output } = await seeded(bundle, page);

    expect(output.staticPagePrivacy).toBe(2);
    expect(input.generation.headers['cache-control']).toBe('no-transform');
  });

  it.each<Partial<Prerender>>([
    { initialRevalidate: 0 },
    { initialRevalidate: undefined },
    { initialHeaders: { 'set-cookie': 'visitor=one' } },
    { initialHeaders: { 'cache-control': 'private' } },
    { initialHeaders: { vary: '*' } },
    { initialHeaders: { 'content-security-policy': "script-src 'nonce-personal'" } },
    { allowQuery: ['visitor'] },
    { allowHeader: ['x-visitor'] },
    { response: 'initial' },
    { compute: 'blocking' },
    { route: '/[slug]' },
  ])('keeps an incompatible build private %j', async (changes) => {
    const page = { ...ISR_PAGE, ...changes };
    const bundle = isrPageBundle(page);
    const { output } = await seeded(bundle, page);

    expect(output.staticPagePrivacy).toBeUndefined();
    await expect(staticPagesOf(bundle, SCOPE)).resolves.toStrictEqual([]);
  });

  it('accepts independently proved runtime versions two and three at the gateway', async () => {
    const { output } = await seeded(isrPageBundle(), ISR_PAGE);
    const runtime = { ...output, headers: {}, staticPagePrivacy: 2 };

    expect(commitOutputSchema.parse(runtime).staticPagePrivacy).toBe(2);
    expect(commitOutputSchema.safeParse({ ...runtime, staticPagePrivacy: 1 }).success).toBe(false);
    expect(commitOutputSchema.parse({ ...runtime, staticPagePrivacy: 3 }).staticPagePrivacy).toBe(
      3,
    );
    expect(commitOutputSchema.safeParse({ ...runtime, staticPagePrivacy: 4 }).success).toBe(false);
    expect(
      commitOutputSchema.parse({ ...runtime, staticPagePrivacy: undefined }).staticPagePrivacy,
    ).toBeUndefined();
  });
});
