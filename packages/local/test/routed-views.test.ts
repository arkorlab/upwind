import {
  buildProjectManifest,
  type ProjectManifest,
  type ReservedRoute,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { sanitizePassthroughHeaders } from '@stayingupwind/core/request';
import { assert, describe, expect, it } from 'vitest';

import { type CheckedStack, EDGE_HEADER } from '../src/answers.ts';
import { navigationFor } from '../src/browsers.ts';
import { claimedBy } from '../src/escaping.ts';
import {
  bypassedVerdict,
  claimedAsLeft,
  documentRouteAt,
  shellBypassFailure,
} from '../src/landings.ts';
import { pagesHeadersOnly } from '../src/pages-handoffs.ts';
import { bypassedFor, handedOnVerdict } from '../src/part-handoffs.ts';
import { routeAskedAt } from '../src/part-landings.ts';
import type { Part } from '../src/part-marks.ts';
import { classifiedReads } from '../src/routing-reads.ts';

/**
 * The edge judges a route, a rule ahead of the filesystem and a route's `bypassFor` on the headers
 * it routes a request by, not as the visitor sent them (Codex): where no middleware ran, as it
 * classifies the request — a forwarding field a condition reads taking the value forwarding hands on
 * (`headersToClassify`) — and where one did, on what it left as forwarding hands that on
 * (`handedHeaders`). Each of the check's selectors reads them the same way.
 */

const SITE = 'https://site.example';
const AT = '2026-10-23T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const SHELL = {
  sha256: SHA,
  byteLength: 1,
  contentType: 'text/html',
  encoding: 'identity',
} as const;
const CLASS = '/items/[id]';
const MEMBER_URL = new URL('/items/1', SITE);

/** The edge's own `Via`, as the forwarder hands every request on with it. */
const EDGE_VIA =
  sanitizePassthroughHeaders(new Headers(), {
    previewDomain: 'invalid',
    previewHost: 'site.example',
    clientIp: undefined,
  }).get('via') ?? '';
type Condition = NonNullable<ReservedRoute['has']>[number];
/** That `Via` as a pattern matches it. */
const EDGE_VIA_PATTERN = EDGE_VIA.replaceAll('.', String.raw`\.`);
/** A condition on that `Via`, as a rule of `next.config` spells one. */
const ON_EDGE_VIA: Condition = {
  type: 'header',
  key: 'via',
  value: `^${EDGE_VIA_PATTERN}$`,
};
/** A header neither the check sends nor forwarding adds. */
const NEVER: Condition = { type: 'header', key: 'x-never-forwarded' };

const CLASS_ROUTE: RouteEntry = { pathname: CLASS, status: 200, shell: SHELL, headers: {} };

function manifestWith(options: {
  readonly reserved?: readonly ReservedRoute[];
  readonly dynamicHas?: readonly Condition[];
  readonly bypassFor?: readonly Condition[];
}): ProjectManifest {
  const route =
    options.bypassFor === undefined
      ? CLASS_ROUTE
      : { ...CLASS_ROUTE, bypassFor: [...options.bypassFor] };
  return buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: AT,
    originHost: 'site.example',
    deployment: { assetSetHash: SHA, observedAt: AT, dplId: 'dpl_site' },
    app: { deploymentId: 'dpl_site', scriptName: 'app' },
    routes: [route],
    dynamicRoutes: [
      {
        sourceRegex: '^/items/([^/]+?)(?:/)?$',
        route: CLASS,
        ...(options.dynamicHas !== undefined && { has: [...options.dynamicHas] }),
      },
    ],
    ...(options.reserved !== undefined && { reservedRoutes: [...options.reserved] }),
  });
}

function stackOf(manifest: ProjectManifest): CheckedStack {
  // No middleware the build ships, as far as these selectors read the stack.
  return { manifest, site: new URL(SITE), bundle: {}, app: {} } as unknown as CheckedStack;
}

/** A member of the class the middleware let on — rewritten onto `url`, or as it came. */
function continued(url: URL, rewritten: boolean): MiddlewareResult {
  return {
    kind: 'continue',
    url,
    rewritten,
    requestHeaders: new Headers({ 'x-changed': '1' }),
    responseHeaders: new Headers(),
    setCookie: undefined,
  };
}

describe('the headers the edge classifies a request on', () => {
  it('takes the forwarded value of a forwarding field a condition reads, and only of that', () => {
    const sent = { via: 'the visitor', 'x-other': 'kept' };
    const read = classifiedReads(
      manifestWith({ reserved: [{ sourceRegex: '^/x$', has: [ON_EDGE_VIA] }] }),
      MEMBER_URL,
      sent,
    );
    const unread = classifiedReads(manifestWith({}), MEMBER_URL, sent);

    expect(read.get('via')).toBe(EDGE_VIA);
    expect(read.get('x-other')).toBe('kept');
    expect(unread.get('via')).toBe('the visitor');
  });

  it('keeps a field the classification reads by name as the visitor sent it', () => {
    const internal: Condition = { type: 'header', key: 'x-middleware-test' };
    const read = classifiedReads(
      manifestWith({ reserved: [{ sourceRegex: '^/x$', has: [internal] }] }),
      MEMBER_URL,
      { 'x-middleware-test': 'sent' },
    );

    expect(read.get('x-middleware-test')).toBe('sent');
  });
});

describe('whether a rule ahead of the filesystem claims a document', () => {
  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, claimed: true },
    { label: 'on a header nothing forwards', has: NEVER, claimed: false },
  ])('judges a rule $label as the edge classifies the request', ({ has, claimed }) => {
    const manifest = manifestWith({ reserved: [{ sourceRegex: '^/items/1$', has: [has] }] });
    const target = {
      manifest,
      url: MEMBER_URL,
      prover: 'agent',
      exact: false,
      requestClass: 'document',
    } as const;

    expect(claimedBy(target, {}, () => true)).toBe(claimed);

    const sent = { route: CLASS_ROUTE, url: MEMBER_URL, headers: {}, exact: false };

    expect(claimedAsLeft(stackOf(manifest), sent, undefined)).toBe(claimed);
  });

  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, claimed: true },
    { label: 'on a header nothing forwards', has: NEVER, claimed: false },
  ])(
    'judges a rule $label on what the middleware left, as forwarding hands it on',
    ({ has, claimed }) => {
      // Moved, the edge routes it again behind the rules ahead of the filesystem alone.
      const manifest = manifestWith({
        reserved: [{ sourceRegex: '^/items/2$', beforeFiles: true, has: [has] }],
      });
      const sent = { route: CLASS_ROUTE, url: MEMBER_URL, headers: {}, exact: false };
      const decided = continued(new URL('/items/2', SITE), true);

      expect(claimedAsLeft(stackOf(manifest), sent, decided)).toBe(claimed);
    },
  );
});

describe('the class a member of a dynamic route is matched to', () => {
  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, matched: true },
    { label: 'on a header nothing forwards', has: NEVER, matched: false },
  ])('matches a class conditioned $label as the edge classifies it', ({ has, matched }) => {
    const manifest = manifestWith({ dynamicHas: [has] });

    expect(documentRouteAt(manifest, MEMBER_URL, {})).toBe(matched ? CLASS : undefined);
    expect(
      routeAskedAt(stackOf(manifest), 'payload', { url: MEMBER_URL, headers: {} }),
    ).toStrictEqual(matched ? { route: manifest.routes[CLASS], exact: false } : undefined);
  });
});

describe("whether a route's bypassFor holds for a request", () => {
  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, holds: true },
    { label: 'on a header nothing forwards', has: NEVER, holds: false },
  ])('judges one $label as the edge does, with the middleware and without', ({ has, holds }) => {
    const manifest = manifestWith({ bypassFor: [has] });
    const stack = stackOf(manifest);
    const route = manifest.routes[CLASS] ?? CLASS_ROUTE;
    const sent = { route, url: MEMBER_URL, headers: {}, exact: false };
    const decided = continued(MEMBER_URL, false);
    const part: Part = {
      kind: 'payload',
      what: 'the payload',
      url: MEMBER_URL,
      headers: {},
      built: undefined,
      route,
      builtOn: (other) => other.payload?.artifact,
      exact: false,
    };

    expect(shellBypassFailure(stack, sent, undefined) !== undefined).toBe(holds);
    expect(shellBypassFailure(stack, sent, decided) !== undefined).toBe(holds);
    expect(bypassedVerdict(stack, undefined, sent)?.kind === 'skipped').toBe(holds);
    expect(bypassedVerdict(stack, decided, sent)?.kind === 'skipped').toBe(holds);
    expect(bypassedFor(stack, part, { decided: undefined, asked: {} })).toBe(holds);
    expect(bypassedFor(stack, part, { decided, asked: {} })).toBe(holds);

    const page = { manifest, route, url: MEMBER_URL, prover: 'agent', exact: false } as const;

    expect(navigationFor(page).kind === 'bypassed').toBe(holds);
  });
});

describe("a request for a page's payload the edge handed on as no part of it", () => {
  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, skipped: true },
    { label: 'on a header nothing forwards', has: NEVER, skipped: false },
  ])(
    "is the application's where a rule $label claims it as the edge classifies it",
    ({ has, skipped }) => {
      const exact: RouteEntry = {
        ...CLASS_ROUTE,
        pathname: '/items/one',
        payload: { artifact: { ...SHELL, contentType: 'text/x-component' } },
      };
      const manifest = buildProjectManifest({
        projectId: 'site',
        runId: 'run',
        generatedAt: AT,
        originHost: 'site.example',
        deployment: { assetSetHash: SHA, observedAt: AT, dplId: 'dpl_site' },
        app: { deploymentId: 'dpl_site', scriptName: 'app' },
        routes: [exact],
        reservedRoutes: [{ sourceRegex: '^/items/one$', beforeFiles: true, has: [has] }],
      });
      const url = new URL('/items/one', SITE);
      const part: Part = {
        kind: 'payload',
        what: 'the payload',
        url,
        headers: {},
        built: exact.payload?.artifact,
        route: manifest.routes['/items/one'] ?? exact,
        builtOn: (route) => route.payload?.artifact,
        exact: true,
      };
      const verdict = handedOnVerdict(stackOf(manifest), part, {
        answered: 'passthrough;reason=rsc',
        decided: undefined,
        covered: false,
        asked: {},
      });

      expect(verdict.kind === 'skipped').toBe(skipped);
    },
  );
});

describe('the Pages handoff a request is expected to get', () => {
  it.each([
    { label: "on the edge's Via", has: ON_EDGE_VIA, expected: false },
    { label: 'on a header nothing forwards', has: NEVER, expected: true },
  ])(
    'is none where a rule $label claims the page as the edge classifies it',
    ({ has, expected }) => {
      const member: RouteEntry = {
        pathname: '/posts/first',
        status: 200,
        shell: SHELL,
        headers: {},
        cache: { entryId: 'first-entry', kind: 'pages', delivery: 'complete' },
      };
      const manifest = buildProjectManifest({
        projectId: 'site',
        runId: 'run',
        generatedAt: AT,
        originHost: 'site.example',
        deployment: { assetSetHash: SHA, observedAt: AT, dplId: 'dpl_site' },
        app: { deploymentId: 'dpl_site', scriptName: 'app' },
        routes: [member, { ...CLASS_ROUTE, pathname: '/posts/[slug]' }],
        cache: { keySchemaVersion: 1, scopeId: 'dpl_site' },
        pagesDataUnder: { basePath: '', buildId: 'build' },
        staticPages: [
          {
            staticPagePrivacy: 3,
            pathname: '/posts/first',
            route: '/posts/[slug]',
            entryId: 'first-entry',
            dataPathname: '/_next/data/build/posts/first.json',
            parameters: { slug: 'first' },
          },
        ],
        dynamicRoutes: [{ sourceRegex: '^/posts/([^/]+?)(?:/)?$', route: '/posts/[slug]' }],
        reservedRoutes: [{ sourceRegex: '^/posts/first$', beforeFiles: true, has: [has] }],
      });
      const headersOnly = pagesHeadersOnly(
        stackOf(manifest),
        new URL('/posts/first', SITE),
        {},
        false,
      );

      assert(typeof headersOnly === 'function');

      expect(headersOnly(200, { [EDGE_HEADER]: 'passthrough;reason=static-page' })).toBe(expected);
    },
  );
});
