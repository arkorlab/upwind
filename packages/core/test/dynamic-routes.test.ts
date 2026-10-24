import { describe, expect, it } from 'vitest';

import {
  type ConfiguredHeaders,
  documentHeaderRulesFor,
  headerRulesFor,
  isReserved,
  matchDynamicRoute,
  validationPathnameFor,
} from '../src/manifest/dynamic.ts';
import { buildProjectManifest } from '../src/manifest/manifest.ts';
import type { DynamicRoute, RouteEntry } from '../src/manifest/schema.ts';
import { classifyRequest, type RequestClass } from '../src/request/classify.ts';

/**
 * A hosted application's dynamic routes, shaped like the ones `next build` emits for a localised
 * app: an `[orgSlug]` class with a shell for `/en/…`, static-segment routes ahead of it, and the
 * generic `/[locale]/…` templates after it, in Next.js's own order.
 */

const OBSERVED_AT = '2026-09-19T00:00:00.000Z';
const deployment = { dplId: 'dpl_active', assetSetHash: 'h', observedAt: OBSERVED_AT };

function entryAt(pathname: string): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 10,
      contentType: 'text/html',
      encoding: 'identity',
    },
    headers: {},
    prerenderId: pathname,
  };
}

const DYNAMIC_ROUTES: DynamicRoute[] = [
  { sourceRegex: '^[/]?/api/auth/(?<nxtPall>.+?)(?:/)?$' },
  { sourceRegex: '^[/]?/(?<nxtPlocale>[^/]+?)(?:/)?$' },
  { sourceRegex: '^[/]?/(?<nxtPlocale>[^/]+?)/login(?:/)?$' },
  { sourceRegex: '^[/]?/(?<nxtPlocale>[^/]+?)/login/done(?:/)?$' },
  {
    sourceRegex: String.raw`^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?<rscSuffix>\.rsc|\.segments/.+\.segment\.rsc)(?:/)?$`,
  },
  { sourceRegex: '^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?:/)?$', route: '/en/[orgSlug]' },
  { sourceRegex: '^[/]?/(?<nxtPlocale>[^/]+?)/(?<nxtPorgSlug>[^/]+?)(?:/)?$' },
  {
    sourceRegex: '^[/]?/en/(?<nxtPorgSlug>[^/]+?)/(?<nxtPprojectId>[^/]+?)(?:/)?$',
    route: '/en/[orgSlug]/[projectId]',
    has: [{ type: 'header', key: 'x-beta' }],
  },
  {
    sourceRegex:
      '^[/]?/(?<nxtPlocale>[^/]+?)/(?<nxtPorgSlug>[^/]+?)/(?<nxtPprojectId>[^/]+?)(?:/)?$',
  },
];

const manifest = buildProjectManifest({
  projectId: 'p',
  runId: 'r',
  generatedAt: OBSERVED_AT,
  originHost: 'app.example.app',
  deployment,
  routes: [
    entryAt('/en'),
    entryAt('/en/gated'),
    entryAt('/en/[orgSlug]'),
    entryAt('/en/[orgSlug]/[projectId]'),
  ],
  app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
  dynamicRoutes: DYNAMIC_ROUTES,
  reservedRoutes: [
    { sourceRegex: String.raw`^\/ingest(?:\/(.*))?(?:\/)?$` },
    // Claimed before the filesystem, and it happens to name a route with a shell of its own.
    { sourceRegex: String.raw`^\/en\/gated(?:\/)?$`, beforeFiles: true },
  ],
  exactPathnames: ['/en/about', '/en/café'],
  headerRules: [
    {
      sourceRegex: '^[/]?/en(?:/(.*))?(?:/)?$',
      has: [{ type: 'header', key: 'x-beta' }],
      headers: { 'X-Robots-Tag': 'noindex' },
    },
    {
      sourceRegex: '^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?:/)?$',
      missing: [{ type: 'cookie', key: 'session' }],
      headers: { 'X-Robots-Tag': 'none', 'Referrer-Policy': 'no-referrer' },
    },
    // Unconditional: the same for every request that reaches this path.
    {
      sourceRegex: '^[/]?/ja(?:/(.*))?(?:/)?$',
      headers: { 'X-Robots-Tag': 'noindex' },
    },
    // A value that names what the path matched, as `next.config` writes it.
    {
      sourceRegex: '^[/]?/es/(?<nxtPorgSlug>[^/]+?)(?:/)?$',
      headers: { 'X-Org': ':nxtPorgSlug', 'X-Plain': 'no colon here' },
    },
  ],
});

const NAVIGATION = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };

function classify(path: string, headers: Record<string, string> = {}): RequestClass {
  return classifyRequest({
    method: 'GET',
    url: new URL(`https://app.example.app${path}`),
    headers: new Headers({ ...NAVIGATION, ...headers }),
    manifest,
    deployment,
  });
}

function routeOf(result: RequestClass): string | undefined {
  return result.kind === 'document' ? result.entry.pathname : undefined;
}

function reasonOf(result: RequestClass): string | undefined {
  return result.kind === 'passthrough' ? result.reason : undefined;
}

describe('matchDynamicRoute', () => {
  it('serves a class shell to any member of the class', () => {
    const entry = matchDynamicRoute(
      manifest,
      new URL('https://app.example.app/en/acme'),
      new Headers(),
    );

    expect(entry?.pathname).toBe('/en/[orgSlug]');
    expect(entry?.prerenderId).toBe('/en/[orgSlug]');
  });

  it.each([
    ['an exact route', '/en', '/en'],
    ['a member of the class', '/en/acme', '/en/[orgSlug]'],
    ['a member whose name is a static segment elsewhere', '/en/sites', '/en/[orgSlug]'],
    ['a member whose name carries an escape that decodes', '/en/a%20b', '/en/[orgSlug]'],
  ])('resolves %s', (_label, path, route) => {
    expect(routeOf(classify(path))).toBe(route);
  });

  /** Next.js picks the first matching route; when that route has no shell, so does the edge. */
  it.each([
    ['a static-segment route ahead of the class', '/en/login/done'],
    ['a class with no shell', '/ja/acme'],
    ['a route handler', '/api/auth/session'],
    ['a pathname Next.js resolves exactly, with no shell', '/en/about'],
    ['the same, asked for escaped', '/en/caf%C3%A9'],
    ['the RSC variant, which precedes the document route', '/en/acme.rsc'],
    ['a rewrite Next.js evaluates first', '/ingest/e'],
    ['an exact route a beforeFiles rule claims first', '/en/gated'],
    ['a case variant the runtime would not match', '/EN/acme'],
    ['a trailing slash the server would redirect', '/en/acme/'],
    ['a member whose name does not decode, which the server refuses', '/en/%2'],
  ])('passes through %s', (_label, path) => {
    expect(reasonOf(classify(path))).toBe('route-not-proved');
  });

  /**
   * A repeated slash, which the server redirects before any routing, is no class's member either;
   * the request is left to the Worker before a class is looked for (`repeated-slash`).
   */
  it('matches no class for a repeated slash the server would redirect', () => {
    const at = new URL('https://app.example.app/en//acme');

    expect(matchDynamicRoute(manifest, at, new Headers())).toBeUndefined();
    expect(reasonOf(classify('/en//acme'))).toBe('repeated-slash');
  });

  /**
   * An application that keeps its pages behind a trailing slash asks for a member with one, and the
   * class's matcher takes it. One slash, and no more; and none where the manifest says nothing.
   */
  it('matches a member asked for with the slash where the pages are kept behind one', () => {
    const slashed = { ...manifest, trailingSlash: true as const };
    const at = (path: string): string | undefined => {
      const url = new URL(`https://app.example.app${path}`);
      return matchDynamicRoute(slashed, url, new Headers())?.pathname;
    };

    expect(at('/en/acme/')).toBe('/en/[orgSlug]');
    // Admitted, not required: a member whose last segment names a file keeps no slash. The slash a
    // request gives one is the build's redirect's to take off, a reserved route that claims the
    // path ahead of every class (`edge-routing.test.ts`); a dotted name it does not read as a
    // file's, such as a version, keeps its slash and its class.
    expect(at('/en/report.pdf')).toBe('/en/[orgSlug]');
    expect(at('/en/v1.2-beta/')).toBe('/en/[orgSlug]');
    expect(at('//')).toBeUndefined();
    expect(at('/en/acme//')).toBeUndefined();
    expect(at('/en//acme/')).toBeUndefined();
    expect(at('/en/%2/')).toBeUndefined();
    expect(
      matchDynamicRoute(manifest, new URL('https://app.example.app/en/acme/'), new Headers()),
    ).toBeUndefined();
  });

  /** A matcher whose conditions fail is passed over, and the next class gets its turn. */
  it('honours has conditions, moving on when they fail', () => {
    expect(routeOf(classify('/en/acme/proj', { 'x-beta': '1' }))).toBe('/en/[orgSlug]/[projectId]');
    expect(reasonOf(classify('/en/acme/proj'))).toBe('route-not-proved');
  });

  it('refuses a parameter smuggled in the query', () => {
    expect(reasonOf(classify('/en/acme?nxtPorgSlug=evil'))).toBe('bypass-query');
    expect(reasonOf(classify('/en/acme?nxtIslot=x'))).toBe('bypass-query');
  });

  /** The hosted policy admits every cookie and key: the shell does not depend on them. */
  it('serves a shell alongside a session cookie and an unlisted query key', () => {
    expect(routeOf(classify('/en/acme?tab=members', { cookie: 'session=abc' }))).toBe(
      '/en/[orgSlug]',
    );
    expect(reasonOf(classify('/en/acme', { cookie: '__prerender_bypass=1' }))).toBe(
      'bypass-cookie',
    );
  });
});

describe('validationPathnameFor', () => {
  it.each([
    ['/en', '/en'],
    ['/en/[orgSlug]', '/en/arkor-validation'],
    ['/en/[orgSlug]/[projectId]', '/en/arkor-validation/arkor-validation'],
    ['/docs/[...slug]', '/docs/arkor-validation'],
    ['/docs/[[...slug]]', '/docs/arkor-validation'],
  ])('turns %s into %s', (route, expected) => {
    expect(validationPathnameFor(route)).toBe(expected);
  });

  /**
   * The application may name this path itself. Asking for it would validate that other route, and
   * the answer's `route=` marker would not be the template being checked — so a class the edge
   * serves perfectly well would be dropped from its own manifest.
   */
  it('avoids a member the application has claimed', () => {
    // `/en/about` is one of the fixture's own exact pathnames.
    expect(validationPathnameFor('/en/[orgSlug]', manifest)).toBe('/en/arkor-validation');
    expect(validationPathnameFor('/ingest/[id]', manifest)).toBeUndefined();
  });

  it('checks a different prefix when a reservation also claims the run-id fallback', () => {
    const reserved = {
      ...manifest,
      reservedRoutes: [{ sourceRegex: '^/docs/arkor-validation[^/]*$' }],
    };
    const pathname = validationPathnameFor('/docs/[slug]', reserved);

    expect(pathname).toBeDefined();
    expect(pathname).toMatch(/^\/docs\/[^/]+$/u);
    expect(
      isReserved(reserved, new URL(pathname!, 'https://app.example'), new Headers(), false),
    ).toBe(false);
  });

  it('checks every fallback against exact pathnames as well as reservations', () => {
    const reserved = {
      ...manifest,
      reservedRoutes: [{ sourceRegex: '^/docs/arkor-validation[^/]*$' }],
      exactPathnames: { '/docs/0-r': true as const },
    };
    const pathname = validationPathnameFor('/docs/[slug]', reserved);

    expect(pathname).toBeDefined();
    expect(pathname).not.toBe('/docs/0-r');
    expect(
      isReserved(reserved, new URL(pathname!, 'https://app.example'), new Headers(), false),
    ).toBe(false);
  });

  it.each(['/docs/[...slug]', '/docs/[[...slug]]'])(
    'selects a deeper member of %s after a more specific class claims one segment',
    (route) => {
      const classes = {
        ...manifest,
        routes: { '/docs/[id]': entryAt('/docs/[id]'), [route]: entryAt(route) },
        dynamicRoutes: [
          { sourceRegex: '^/docs/([^/]+)$', route: '/docs/[id]' },
          { sourceRegex: '^/docs/(.+)$', route },
        ],
      };
      const pathname = validationPathnameFor(route, classes);

      expect(pathname).toBe('/docs/arkor-validation/arkor-validation');
      expect(
        matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
          ?.pathname,
      ).toBe(route);
    },
  );

  it.each([
    ['/docs/[...slug]', 3],
    ['/docs/[[...slug]]', 3],
    ['/docs/[...slug]', 7],
    ['/docs/[[...slug]]', 7],
  ] as const)(
    'finds a member of %s beyond %i more specific route classes',
    (route, precedingDepths) => {
      const classes = {
        ...manifest,
        routes: { [route]: entryAt(route) },
        // Fixed-depth routes without shells still take precedence over the catch-all.
        dynamicRoutes: [
          ...Array.from({ length: precedingDepths }, (_, index) => {
            const parameters = '/([^/]+?)'.repeat(index + 1);
            return { sourceRegex: `^/docs${parameters}(?:/)?$` };
          }),
          { sourceRegex: '^/docs/(.+?)(?:/)?$', route },
        ],
      };
      const pathname = validationPathnameFor(route, classes);

      expect(pathname).toBe(`/docs${'/arkor-validation'.repeat(precedingDepths + 1)}`);
      expect(
        matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
          ?.pathname,
      ).toBe(route);
    },
  );

  it('only expands the catch-all after the base path and fixed dynamic parameters', () => {
    const route = '/site/[team]/docs/[...slug]';
    const precedingDepths = 4;
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route) },
      dynamicRoutes: [
        ...Array.from({ length: precedingDepths }, (_, index) => {
          const parameters = '/([^/]+?)'.repeat(index + 1);
          return { sourceRegex: `^/site/([^/]+?)/docs${parameters}(?:/)?$` };
        }),
        { sourceRegex: '^/site/([^/]+?)/docs/(.+?)(?:/)?$', route },
      ],
    };
    const pathname = validationPathnameFor(route, classes);

    expect(pathname).toBe(
      `/site/arkor-validation/docs${'/arkor-validation'.repeat(precedingDepths + 1)}`,
    );
    expect(
      matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
        ?.pathname,
    ).toBe(route);
  });

  it('checks deeper catch-all candidates against prior classes and exact pathnames', () => {
    const route = '/docs/[...slug]';
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route) },
      dynamicRoutes: [
        { sourceRegex: '^/docs/[^/]+$' },
        { sourceRegex: '^/docs/[^/]+/[^/]+$' },
        { sourceRegex: '^/docs/(.+)$', route },
      ],
      exactPathnames: { '/docs/arkor-validation/arkor-validation/arkor-validation': true as const },
    };
    const pathname = validationPathnameFor(route, classes);

    expect(pathname).toBe(
      '/docs/arkor-validation/arkor-validation/arkor-validation/arkor-validation',
    );
    expect(
      matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
        ?.pathname,
    ).toBe(route);
  });

  it('checks reservations and exact claims beyond the last more specific class', () => {
    const route = '/docs/[...slug]';
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route) },
      dynamicRoutes: [
        { sourceRegex: '^/docs/[^/]+$' },
        { sourceRegex: '^/docs/[^/]+/[^/]+$' },
        { sourceRegex: '^/docs/[^/]+/[^/]+/[^/]+$' },
        { sourceRegex: '^/docs/(.+)$', route },
      ],
      reservedRoutes: [{ sourceRegex: '^/docs/arkor-validation(?:/|$)' }],
      exactPathnames: { [`/docs${'/arkor-validation-r'.repeat(4)}`]: true as const },
    };
    const pathname = validationPathnameFor(route, classes);

    expect(pathname).toBe(`/docs${'/arkor-validation-r'.repeat(5)}`);
    expect(
      matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
        ?.pathname,
    ).toBe(route);
  });

  it('gets past an exact preferred member when an earlier catch-all condition does not hold', () => {
    const route = '/docs/[...slug]';
    const claimed = '/docs/arkor-validation';
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route), [claimed]: entryAt(claimed) },
      reservedRoutes: [],
      dynamicRoutes: [
        {
          sourceRegex: '^/docs/(.+)$',
          has: [{ type: 'header' as const, key: 'x-preview' }],
        },
        { sourceRegex: '^/docs/(.+)$', route },
      ],
    };
    const pathname = validationPathnameFor(route, classes);

    expect(pathname).toBe('/docs/arkor-validation/arkor-validation');
    expect(
      matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
        ?.pathname,
    ).toBe(route);
  });

  it('varies a sample prefix claimed by an earlier dynamic class', () => {
    const route = '/docs/[slug]';
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route) },
      dynamicRoutes: [
        { sourceRegex: '^/docs/arkor-validation[^/]*$' },
        { sourceRegex: '^/docs/([^/]+)$', route },
      ],
    };
    const pathname = validationPathnameFor(route, classes);

    expect(pathname).toBe('/docs/0-r');
    expect(
      matchDynamicRoute(classes, new URL(pathname!, 'https://app.example'), new Headers())
        ?.pathname,
    ).toBe(route);
  });

  it('returns no sample for a shadowed catch-all even with many unrelated exact paths', () => {
    const route = '/docs/[...slug]';
    const classes = {
      ...manifest,
      routes: { [route]: entryAt(route) },
      dynamicRoutes: [{ sourceRegex: '^/docs/(.+)$' }, { sourceRegex: '^/docs/(.+)$', route }],
      exactPathnames: Object.fromEntries(
        Array.from({ length: 10_000 }, (_, index) => [`/unrelated/${index}`, true as const]),
      ),
    };

    expect(validationPathnameFor(route, classes)).toBeUndefined();
  });

  it('preserves sampling when the manifest has no dynamic class metadata', () => {
    const withoutClasses = { ...manifest, dynamicRoutes: undefined };

    expect(validationPathnameFor('/docs/[slug]', withoutClasses)).toBe('/docs/arkor-validation');
    expect(validationPathnameFor('/docs/[slug]', manifest)).toBe('/docs/arkor-validation');
  });
});

function headersFor(path: string, headers: Record<string, string> = {}): ConfiguredHeaders {
  return headerRulesFor(manifest, new URL(`https://app.example.app${path}`), new Headers(headers));
}

describe('headerRulesFor', () => {
  it('sets what the rules whose conditions hold name, the later rule winning', () => {
    expect(headersFor('/en/acme', { 'x-beta': '1' }).headers).toStrictEqual({
      'x-robots-tag': 'none',
      'referrer-policy': 'no-referrer',
    });
    expect(headersFor('/en/acme', { 'x-beta': '1', cookie: 'session=abc' }).headers).toStrictEqual({
      'x-robots-tag': 'noindex',
    });
  });

  /**
   * What a document the edge composes takes from a rule is its `documentHeaders`, the policy with
   * the recovery script permitted; anything else the rule matches, and a rule that has none, takes
   * the rule's own headers.
   */
  it("gives a document a rule's document headers, and anything else its own", () => {
    const policy = "default-src 'self'";
    const permitted = `${policy}; script-src 'self' 'sha256-recovery'`;
    const widened = {
      ...manifest,
      headerRules: [
        {
          sourceRegex: '^/(.*)$',
          headers: { 'Content-Security-Policy': policy },
          documentHeaders: { 'Content-Security-Policy': permitted },
        },
        { sourceRegex: '^/(.*)$', headers: { 'X-Frame-Options': 'DENY' } },
      ],
    };
    const url = new URL('https://app.example.app/en');

    expect(documentHeaderRulesFor(widened, url, new Headers()).headers).toStrictEqual({
      'content-security-policy': permitted,
      'x-frame-options': 'DENY',
    });
    expect(headerRulesFor(widened, url, new Headers()).headers).toStrictEqual({
      'content-security-policy': policy,
      'x-frame-options': 'DENY',
    });
  });

  it('sets nothing when no rule matches or holds', () => {
    expect(headersFor('/en', { cookie: 'session=abc' }).headers).toStrictEqual({});
    expect(headersFor('/fr/acme', { 'x-beta': '1' }).headers).toStrictEqual({});
  });

  /**
   * Older manifests can carry named groups. Keep their `:name` interpolation alongside the
   * positional references the current Next.js adapter compiles.
   */
  it('fills in the captures a value names', () => {
    expect(headersFor('/es/acme').headers).toStrictEqual({
      'x-org': 'acme',
      'x-plain': 'no colon here',
    });
  });

  /**
   * A rule with `has` or `missing` answers this request the way it does because of the request,
   * so what it set belongs to this visitor and no other. The caller turns that into a private
   * response; it is recorded here because the matching loop is the only place that knows.
   */
  it('says whether the request itself chose any of the headers', () => {
    expect(headersFor('/en/acme', { 'x-beta': '1' }).conditioned).toBe(true);
    // A rule that matched on the pathname alone says the same thing to everyone.
    expect(headersFor('/ja/acme', { 'x-beta': '1' })).toStrictEqual({
      headers: { 'x-robots-tag': 'noindex' },
      conditioned: false,
    });
  });
});

/**
 * Next.js matches the rules of `next.config` without regard to case (its router's `sensitive:
 * false`): a rule written for `/Ingest` claims `/ingest`, and one setting a header on `/EN/…` sets
 * it on `/en/…`. The dynamic classes keep their case, as the runtime does.
 */
describe('a rule of next.config in another case', () => {
  it('reserves the path it names in any case', () => {
    const upper = {
      ...manifest,
      reservedRoutes: [{ sourceRegex: String.raw`^\/Ingest(?:\/(.*))?(?:\/)?$` }],
    };
    const url = new URL('https://app.example.app/ingest/e');

    expect(isReserved(upper, url, new Headers(), false)).toBe(true);
  });

  it('sets its headers on the path it names in any case', () => {
    const upper = {
      ...manifest,
      headerRules: [
        { sourceRegex: '^[/]?/EN(?:/(.*))?(?:/)?$', headers: { 'X-Robots-Tag': 'noindex' } },
      ],
    };
    const url = new URL('https://app.example.app/en/acme');

    expect(headerRulesFor(upper, url, new Headers()).headers).toStrictEqual({
      'x-robots-tag': 'noindex',
    });
  });
});
