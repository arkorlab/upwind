import { createHash } from 'node:crypto';

import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_DATA,
  FALLBACK_MEMBER,
  FALLBACK_ROUTE,
  fallbackBundle,
} from '../../core/test/fallback-pages-fixtures.ts';
import { withClock } from '../src/cache/clock.ts';
import type { CommitRequest } from '../src/cache/host.ts';
import { regenerate, type RegenerationOutcome } from '../src/cache/regenerate.ts';
import type { StaticPagesManifest } from '../src/cache/static-pages.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { NOW, runtimeOf, SCOPE } from './pages-isr-fixtures.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

function manifestOf(): StaticPagesManifest {
  return fallbackBundle({ deploymentId: SCOPE });
}

function dataOf(outcome: RegenerationOutcome): Uint8Array {
  if (outcome.kind !== 'accepted' || outcome.render.data === undefined)
    throw new Error('Missing paired render');
  return outcome.render.data;
}

interface Scenario {
  readonly slug?: string;
  readonly metadata?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly status?: number;
  readonly manifest?: StaticPagesManifest;
  readonly dataPathname?: string | null;
  readonly parameters?: Readonly<Record<string, string>>;
  readonly allowHeader?: readonly string[];
  readonly scopeId?: string;
}

async function rendered(scenario: Scenario = {}) {
  const slug = scenario.slug ?? 'first';
  const pathname = `/fallback-true/${slug}`;
  const descriptor: RouteEntryDescriptor = { kind: 'pages', route: FALLBACK_ROUTE, pathname };
  const metadata = {
    props: { pageProps: { value: slug } },
    page: FALLBACK_ROUTE,
    buildId: 'build',
    query: { slug },
    gsp: true,
    isFallback: false,
    ...scenario.metadata,
  };
  const html = `<main>${slug}</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(metadata)}</script>`;
  vi.mocked(invokeNodeHandler).mockResolvedValue(
    new Response(html, {
      status: scenario.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 's-maxage=2, stale-while-revalidate=58',
        ...scenario.headers,
      },
    }),
  );
  const commits: CommitRequest[] = [];
  const pending: Promise<unknown>[] = [];
  const runtime = runtimeOf(commits, scenario.scopeId);
  const start = vi.spyOn(runtime.host, 'startAttempt');
  const outcome = await withClock(NOW, () => {
    return regenerate({
      runtime,
      request: new Request(`https://app.test${pathname}?visitor=personal`, {
        headers: { cookie: 'session=personal', authorization: 'secret' },
      }),
      handler: () => Promise.reject(new Error('the bridge is mocked')),
      target: {
        descriptor,
        reason: 'miss',
        replaces: null,
        dataPathname:
          scenario.dataPathname === null
            ? undefined
            : (scenario.dataPathname ?? `/_next/data/build${pathname}.json`),
        parameters: scenario.parameters,
        allowHeader: scenario.allowHeader,
      },
      staticPagesManifest: scenario.manifest ?? manifestOf(),
      previewToken: undefined,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      run: (work) => work(),
    });
  });
  if (outcome.kind === 'accepted') await outcome.published;
  await Promise.allSettled(pending);
  return {
    outcome,
    commit: commits[0],
    attempt: start.mock.calls[0]?.[0],
    invocation: vi.mocked(invokeNodeHandler).mock.calls[0]?.[0],
  };
}

describe('version3 Pages members earn paired authority from synthetic capture', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it.each(['first', 'second'])(
    'captures a complete %s member with its own canonical JSON',
    async (slug) => {
      const { outcome, commit, invocation, attempt } = await rendered({ slug });

      expect(outcome.kind).toBe('accepted');
      expect(attempt?.entry).toStrictEqual({
        kind: 'pages',
        route: FALLBACK_ROUTE,
        pathname: `/fallback-true/${slug}`,
      });
      expect(
        commit?.generation.outputs.map((output) => {
          const { representationKey, pathname, staticPagePrivacy } = output;
          return [representationKey, pathname, staticPagePrivacy];
        }),
      ).toStrictEqual([
        ['html', `/fallback-true/${slug}`, 3],
        ['pages-data', `/_next/data/build/fallback-true/${slug}.json`, 3],
      ]);

      const data = dataOf(outcome);

      expect(JSON.parse(new TextDecoder().decode(data))).toStrictEqual({
        pageProps: { value: slug },
      });
      expect(commit?.generation.outputs[1]?.artifacts[0]?.sha256).toBe(
        createHash('sha256').update(data).digest('hex'),
      );
      expect({
        url: invocation?.url,
        minimal: invocation?.requestMeta['minimalMode'],
        request: invocation?.request.url,
        cookie: invocation?.request.headers.has('cookie'),
        authorization: invocation?.request.headers.has('authorization'),
      }).toStrictEqual({
        url: `/fallback-true/${slug}`,
        minimal: true,
        request: `https://app.test/fallback-true/${slug}`,
        cookie: false,
        authorization: false,
      });
    },
  );

  it('cannot borrow loading authority for an unproved existing build member', async () => {
    const original = manifestOf();
    const { commit } = await rendered({
      manifest: {
        ...original,
        prerenders: original.prerenders.filter((page) => page !== FALLBACK_DATA),
      },
    });

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it('does not carry a built pair proof into another member or another captured value', async () => {
    const first = await rendered();
    const second = await rendered({ slug: 'second' });

    expect(first.commit?.generation.outputs[0]?.staticPagePrivacy).toBe(3);
    expect(second.commit?.generation.outputs[0]?.staticPagePrivacy).toBe(3);
    expect(first.attempt?.entry).not.toStrictEqual(second.attempt?.entry);
    expect(first.commit?.generation.outputs[1]?.artifacts[0]?.sha256).not.toBe(
      second.commit?.generation.outputs[1]?.artifacts[0]?.sha256,
    );
  });

  it.each([
    { name: 'legacy capability', manifest: { ...manifestOf(), staticPagesPrivacy: 2 as const } },
    { name: 'another scope', scopeId: 'dpl_other' },
    { name: 'missing data pathname', dataPathname: null },
    { name: 'another data build', dataPathname: '/_next/data/other/fallback-true/first.json' },
    { name: 'another data member', dataPathname: '/_next/data/build/fallback-true/second.json' },
    { name: 'supplied query override', parameters: { nxtPslug: 'first' } },
    { name: 'visitor header', allowHeader: ['cookie'] },
    { name: 'class pathname', slug: '[slug]' },
    { name: 'unsupported escaped member', slug: 'a%2Fb' },
  ])('does not grant paired authority from $name', async (scenario) => {
    const { commit } = await rendered(scenario);

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it.each([
    { name: 'missing params', query: {} },
    { name: 'wrong params', query: { slug: 'second' } },
    { name: 'visitor query', query: { slug: 'first', visitor: 'personal' } },
    { name: 'array instead of segment', query: { slug: ['first'] } },
    { name: 'invalid query value', query: { slug: 1 } },
  ])('metadata cannot grant authority with $name', async ({ query }) => {
    const { commit } = await rendered({ metadata: { query } });

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it.each([
    { name: 'wrong page', metadata: { page: '/other/[slug]' } },
    { name: 'wrong build', metadata: { buildId: 'other' } },
    { name: 'loading shell', metadata: { isFallback: true } },
    { name: 'server-side props', metadata: { gssp: true } },
  ])('does not share supplementary metadata for $name', async ({ metadata }) => {
    const { commit } = await rendered({ metadata });

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it.each([
    { 'set-cookie': 'session=personal' },
    { 'cache-control': 'private, s-maxage=2' },
    { vary: '*' },
    { 'content-security-policy': "script-src 'nonce-personal'" },
    { 'content-encoding': 'gzip' },
  ])('keeps raw response privacy vetoes: %o', async (headers) => {
    const { commit } = await rendered({ headers });

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });

  it('retains a raw private build member veto even when the new HTML is public', async () => {
    const original = manifestOf();
    const { commit } = await rendered({
      manifest: {
        ...original,
        prerenders: original.prerenders.map((page) => {
          return page === FALLBACK_MEMBER
            ? { ...page, initialHeaders: { 'set-cookie': 'session=personal' } }
            : page;
        }),
      },
    });

    expect(
      (commit?.generation.outputs ?? []).every((output) => output.staticPagePrivacy === undefined),
    ).toBe(true);
  });
});
