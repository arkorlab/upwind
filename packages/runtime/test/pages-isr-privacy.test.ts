import * as bundle from '@stayingupwind/core/bundle';
import { type RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderCaptured } from '../src/cache/capture.ts';
import { withClock } from '../src/cache/clock.ts';
import type { CommitRequest } from '../src/cache/host.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import type { StaticPagesManifest } from '../src/cache/static-pages.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { DESCRIPTOR, NOW, manifestOf, runtimeOf } from './pages-isr-fixtures.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const METADATA = {
  props: { pageProps: { value: 'new' } },
  page: '/something',
  buildId: 'build',
  query: {},
  gsp: true,
  isFallback: false,
};
const POLICY = 's-maxage=2, stale-while-revalidate=58';

function htmlOf(metadata: Record<string, unknown> = METADATA): string {
  return `<main>new</main><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(metadata)}</script>`;
}

function firstPage(manifest: StaticPagesManifest) {
  const page = manifest.prerenders[0];
  if (page === undefined) throw new Error('Missing built page');
  return page;
}

interface Scenario {
  readonly manifest?: StaticPagesManifest | undefined;
  readonly html?: string;
  readonly headers?: Record<string, string>;
  readonly status?: number;
  readonly descriptor?: RouteEntryDescriptor;
  readonly scopeId?: string;
  readonly allowHeader?: readonly string[];
  readonly parameters?: Readonly<Record<string, string>>;
}

async function rendered(scenario: Scenario = {}) {
  const commits: CommitRequest[] = [];
  const pending: Promise<unknown>[] = [];
  vi.mocked(invokeNodeHandler).mockResolvedValue(
    new Response(scenario.html ?? htmlOf(), {
      status: scenario.status ?? 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': POLICY,
        ...scenario.headers,
      },
    }),
  );
  const outcome = await withClock(NOW, () => {
    return regenerate({
      runtime: runtimeOf(commits, scenario.scopeId),
      request: new Request('https://app.test/something?visitor=personal', {
        method: 'POST',
        headers: { cookie: 'session=personal', authorization: 'secret' },
        body: 'personal',
      }),
      handler: () => Promise.reject(new Error('the bridge is mocked')),
      target: {
        descriptor: scenario.descriptor ?? DESCRIPTOR,
        reason: 'stale',
        allowHeader: scenario.allowHeader,
        parameters: scenario.parameters,
      },
      staticPagesManifest: scenario.manifest,
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
    request: vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].request,
  };
}

describe('pages ISR proof earned by the real synthetic regeneration', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
    vi.restoreAllMocks();
  });

  it('marks only primary HTML after an owned static request and keeps data output unmarked', async () => {
    const { commit, outcome, request } = await rendered({ manifest: manifestOf() });

    expect(outcome.kind).toBe('accepted');
    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBe(2);
    expect(commit?.generation.outputs[1]?.representationKey).toBe('pages-data');
    expect(commit?.generation.outputs[1]).not.toHaveProperty('staticPagePrivacy');
    expect(commit?.generation.policy.source).toBe('runtime-output');
    expect({
      method: request?.method,
      url: request?.url,
      body: request?.body,
      cookie: request?.headers.has('cookie'),
      authorization: request?.headers.has('authorization'),
    }).toStrictEqual({
      method: 'GET',
      url: 'https://app.test/something',
      body: null,
      cookie: false,
      authorization: false,
    });
  });

  it('does not grant authority to perfect metadata without immutable build context', async () => {
    const { commit, outcome } = await rendered();

    expect(outcome.kind).toBe('accepted');
    expect(commit?.generation.outputs[0]).not.toHaveProperty('staticPagePrivacy');
  });

  it('computes admission once per immutable manifest and checks every new render', async () => {
    const manifest = manifestOf();
    const select = vi.spyOn(bundle, 'staticPagesPrivacyOf');
    const first = await rendered({ manifest });
    const next = await rendered({ manifest });
    const privateRender = await rendered({ manifest, headers: { 'set-cookie': 'visitor=one' } });

    expect(first.commit?.generation.outputs[0]?.staticPagePrivacy).toBe(2);
    expect(next.commit?.generation.outputs[0]?.staticPagePrivacy).toBe(2);
    expect(privateRender.commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(1);

    const another = await rendered({
      manifest: manifestOf({ config: { ...manifest.config, basePath: '/docs' } }),
    });

    expect(another.commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not cache a grant from another output at the same literal path', async () => {
    const original = manifestOf();
    const page = firstPage(original);
    const manifest = manifestOf({
      prerenders: [
        {
          ...page,
          id: 'private-first',
          groupId: 2,
          initialHeaders: { 'set-cookie': 'visitor=one' },
        },
        page,
      ],
    });
    const first = await rendered({ manifest });
    const next = await rendered({ manifest });

    expect(first.commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
    expect(next.commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it('ordinary capture exposes supplementary metadata without granting a privacy marker', async () => {
    const captured = await renderCaptured('pages', () =>
      Promise.resolve(new Response(htmlOf(), { headers: { 'cache-control': POLICY } })),
    );

    expect(captured?.pagesStatic).toStrictEqual({ page: '/something', buildId: 'build' });
    expect(captured).not.toHaveProperty('staticPagePrivacy');
  });

  it.each([
    { name: 'legacy capability', manifest: manifestOf({ staticPagesPrivacy: undefined }) },
    { name: 'version1 capability', manifest: manifestOf({ staticPagesPrivacy: 1 }) },
    { name: 'another scope', scopeId: 'dpl_other' },
    { name: 'another pathname', descriptor: { ...DESCRIPTOR, pathname: '/other' } },
    { name: 'another route', descriptor: { ...DESCRIPTOR, route: '/other' } },
    { name: 'App route kind', descriptor: { ...DESCRIPTOR, kind: 'app-route' as const } },
    { name: 'visitor query', parameters: { visitor: 'personal' } },
    { name: 'visitor header', allowHeader: ['cookie'] },
  ])('does not issue2 from $name', async (scenario) => {
    const { commit } = await rendered({ manifest: manifestOf(), ...scenario });

    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it.each([
    { name: 'GSSP', patch: { gssp: true } },
    { name: 'malformed GSSP flag', patch: { gssp: 'unknown' } },
    { name: 'no GSP', patch: { gsp: false } },
    { name: 'fallback', patch: { isFallback: true } },
    { name: 'unknown fallback', patch: { isFallback: undefined } },
    { name: 'preview', patch: { isPreview: true } },
    { name: 'page initial props', patch: { gip: true } },
    { name: 'App initial props', patch: { appGip: true } },
    { name: 'error', patch: { err: { message: 'failed' } } },
    { name: 'wrong page', patch: { page: '/other' } },
    { name: 'wrong build', patch: { buildId: 'other' } },
    { name: 'query', patch: { query: { visitor: 'personal' } } },
  ])('supplementary metadata vetoes $name', async ({ patch }) => {
    const { commit } = await rendered({
      manifest: manifestOf(),
      html: htmlOf({ ...METADATA, ...patch }),
    });

    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it.each([
    { name: 'duplicate metadata', html: htmlOf() + htmlOf() },
    { name: 'malformed metadata', html: '<script id="__NEXT_DATA__">{not-json}</script>' },
    { name: 'missing metadata', html: '<main>new</main>' },
  ])('does not grant2 from $name', async ({ html }) => {
    const { commit } = await rendered({ manifest: manifestOf(), html });

    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it.each([
    { name: 'private', headers: { 'cache-control': 'private, s-maxage=2' } },
    { name: 'cookie', headers: { 'set-cookie': 'session=personal' } },
    { name: 'unknown Vary', headers: { vary: 'x-visitor' } },
    { name: 'nonce', headers: { 'content-security-policy': "script-src 'nonce-personal'" } },
    { name: 'nonHTML', headers: { 'content-type': 'application/json' } },
    { name: 'encoding', headers: { 'content-encoding': 'gzip' } },
    { name: 'unknown lifetime', headers: { 'cache-control': 'max-age=60' } },
    { name: 'zero lifetime', headers: { 'cache-control': 's-maxage=0' } },
  ])('retains raw response privacy for $name', async ({ headers }) => {
    const { commit } = await rendered({ manifest: manifestOf(), headers });

    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBeUndefined();
  });

  it('preserves targeted no-transform without copying a public lifetime', async () => {
    const { commit } = await rendered({
      manifest: manifestOf(),
      headers: { 'cdn-cache-control': 's-maxage=600, no-transform' },
    });

    expect(commit?.generation.outputs[0]?.staticPagePrivacy).toBe(2);
    expect(commit?.generation.headers['cache-control']).toBe('no-transform');
    expect(commit?.generation.headers).not.toHaveProperty('cdn-cache-control');
    expect(commit?.generation.policy.revalidateAfter).toStrictEqual({ kind: 'finite', seconds: 2 });
  });
});
