import { describe, expect, it } from 'vitest';

import type { RouteHas } from '../src/bundle/schema.ts';
import {
  type ConfiguredHeaders,
  documentHeaderRulesFor,
  foldedHeadersFor,
  headerRulesFor,
  interpolateHeader,
  isReserved,
  matchDynamicRoute,
} from '../src/manifest/dynamic.ts';
import type {
  DynamicRoute,
  MiddlewareMatcher,
  ProjectManifest,
  ReservedRoute,
  RouteEntry,
} from '../src/manifest/schema.ts';
import { middlewareApplies } from '../src/paas/middleware.ts';
import { anyConditionHolds, type Conditioned, conditionsHold } from '../src/request/conditions.ts';
import { requiresLiteral } from '../src/request/required-literal.ts';
import {
  BUILD_ID,
  DRAFT_COOKIES,
  HTML_LIMITED_BOTS,
  largeManifest,
  MIDDLEWARE_MATCHERS,
  pageTemplates,
  segmentPathOf,
  segmentsOf,
} from './fixtures/next-routing.ts';

/**
 * The patterns a request is matched against are compiled once per list and read from there, and a
 * document skips the routes only a data request can match. Neither may change an answer: every
 * question below is asked of the code as it stands and of the matching as it was — each pattern
 * compiled where it is read, every route asked in order — over a manifest routed as a large
 * application's is, and the two must agree on every pathname.
 */

const DATA_MARKERS = ['.rsc', '/_next/data/'];
const MAX_SUBSTRING_MATCH_LENGTH = 4096;
const MANIFEST = largeManifest();

// The matching as it was, kept here to be compared with: the rules of `next.config` without regard
// to case, as Next.js's router matches them, and the dynamic classes with it.

/**
 * Kept by its source and flags, only so that asking tens of thousands of requests stays quick: a
 * pattern compiled without `g` or `y` keeps nothing from one match to the next, so these answers
 * are the ones a pattern compiled afresh for each request gave. Not keyed by any list or rule, and
 * no route skipped: what is compared is the order, the skipping and the conditions.
 */
const bySource = new Map<string, RegExp>();

function compiled(source: string, flags = ''): RegExp {
  const key = `${flags}/${source}`;
  let regex = bySource.get(key);
  if (regex === undefined) {
    // eslint-disable-next-line security/detect-non-literal-regexp -- as Next.js compiled it
    regex = new RegExp(source, flags);
    bySource.set(key, regex);
  }
  return regex;
}

function cookieValue(header: string | null, key: string | undefined): string | undefined {
  if (header === null || header === '') {
    return undefined;
  }
  let found: string | undefined;
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== '' && name === key) {
      found = value.join('=');
    }
  }
  return found;
}

function nonempty(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function valueOf(condition: RouteHas, url: URL, headers: Headers): string | undefined {
  switch (condition.type) {
    case 'header': {
      return nonempty(headers.get(condition.key ?? ''));
    }
    case 'cookie': {
      return cookieValue(headers.get('cookie'), condition.key);
    }
    case 'query': {
      return nonempty(url.searchParams.get(condition.key ?? ''));
    }
    case 'host': {
      return url.hostname;
    }
  }
}

function wasMatched(condition: RouteHas, url: URL, headers: Headers): boolean {
  const value = valueOf(condition, url, headers);
  if (value === undefined) {
    return false;
  }
  if (condition.value === undefined) {
    return true;
  }
  try {
    return (
      compiled(`^(?:${condition.value})$`).test(value) ||
      (value.length <= MAX_SUBSTRING_MATCH_LENGTH && compiled(condition.value).test(value)) ||
      value === condition.value
    );
  } catch {
    return value === condition.value;
  }
}

function heldBefore(rule: Conditioned, url: URL, headers: Headers): boolean {
  return (
    (rule.has ?? []).every((condition) => wasMatched(condition, url, headers)) &&
    (rule.missing ?? []).every((condition) => !wasMatched(condition, url, headers))
  );
}

function reservedBefore(
  reserved: readonly ReservedRoute[],
  url: URL,
  headers: Headers,
  beforeFilesOnly: boolean,
): boolean {
  return reserved.some((rule) => {
    return (
      (!beforeFilesOnly || rule.beforeFiles === true) &&
      compiled(rule.sourceRegex, 'i').test(url.pathname) &&
      heldBefore(rule, url, headers)
    );
  });
}

/** For a pathname the class matching takes at all (`isCanonicalPathname`): the corpus is only those. */
function firstMatchBefore(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): { readonly entry: RouteEntry | undefined; readonly index: number } {
  const routes = manifest.dynamicRoutes ?? [];
  if (reservedBefore(manifest.reservedRoutes ?? [], url, headers, false)) {
    return { entry: undefined, index: -1 };
  }
  const index = routes.findIndex(
    (route) => compiled(route.sourceRegex).test(url.pathname) && heldBefore(route, url, headers),
  );
  const route = routes[index]?.route;
  return {
    entry:
      route !== undefined && Object.hasOwn(manifest.routes, route)
        ? manifest.routes[route]
        : undefined,
    index,
  };
}

function headersBefore(url: URL, headers: Headers, forDocument: boolean): ConfiguredHeaders {
  const out: Record<string, string> = {};
  let conditioned = false;
  const rules = MANIFEST.headerRules ?? [];
  for (const rule of rules) {
    const match = compiled(rule.sourceRegex, 'i').exec(url.pathname);
    if (match === null || !heldBefore(rule, url, headers)) {
      continue;
    }
    conditioned ||= rule.has !== undefined || rule.missing !== undefined;
    const set = forDocument ? (rule.documentHeaders ?? rule.headers) : rule.headers;
    for (const [name, value] of Object.entries(set)) {
      out[interpolateHeader(name, match, MANIFEST.routerReferences).toLowerCase()] =
        interpolateHeader(value, match, MANIFEST.routerReferences);
    }
  }
  return { headers: out, conditioned };
}

function foldedBefore(manifest: ProjectManifest, pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rules = manifest.foldedHeaderRules ?? [];
  for (const rule of rules) {
    const match = compiled(rule.sourceRegex, 'i').exec(pathname);
    if (match === null) {
      continue;
    }
    const set = rule.documentHeaders ?? rule.headers;
    for (const [name, value] of Object.entries(set)) {
      out[interpolateHeader(name, match, manifest.routerReferences).toLowerCase()] =
        interpolateHeader(value, match, manifest.routerReferences);
    }
  }
  return out;
}

function middlewareBefore(
  matchers: readonly MiddlewareMatcher[],
  url: URL,
  headers: Headers,
): boolean {
  const matchesAny = (pathname: string): boolean => {
    return matchers.some(
      (matcher) =>
        compiled(matcher.sourceRegex, 'i').test(pathname) && heldBefore(matcher, url, headers),
    );
  };
  if (matchesAny(url.pathname)) {
    return true;
  }
  if (!url.pathname.includes('%')) {
    return false;
  }
  try {
    return matchesAny(decodeURIComponent(url.pathname));
  } catch {
    return false;
  }
}

// The requests asked about.

/** A small deterministic generator, so a failure names a pathname the next run asks again. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

const VALUES = [
  'acme',
  'p1',
  'hello-world',
  'a.b',
  'x.rsc',
  'caf%C3%A9',
  'Acme',
  'v1.json',
  'data',
];

/** Members of a page, with a value put in for each dynamic segment. */
function membersOf(page: string, next: () => number): string[] {
  const pick = (): string => VALUES[Math.floor(next() * VALUES.length)] ?? 'acme';
  return [0, 1].map(() => {
    return segmentsOf(page)
      .flatMap((segment) => {
        if (segment.startsWith('[[...')) {
          return Array.from({ length: Math.floor(next() * 3) }, pick);
        }
        if (segment.startsWith('[...')) {
          return Array.from({ length: 1 + Math.floor(next() * 2) }, pick);
        }
        return [segment.startsWith('[') ? pick() : segment];
      })
      .map((segment) => `/${segment}`)
      .join('');
  });
}

const FUZZ = [
  'en',
  'ja',
  'acme',
  'blog',
  'docs',
  'legacy',
  '.rsc',
  'x.rsc',
  '_next',
  'data',
  BUILD_ID,
  'v.json',
  'a.segments',
  '__PAGE__.segment.rsc',
  '%41',
  'API',
  'account',
  'team',
];

/** Pathnames a visitor and a client router ask for: members, their data, and noise. */
function corpus(): string[] {
  const next = random(20_260_929);
  const pathnames = new Set<string>();
  for (const { page } of pageTemplates()) {
    for (const member of membersOf(page, next)) {
      const segmentPath = segmentPathOf(page);
      pathnames
        .add(member === '' ? '/' : member)
        .add(member.toUpperCase())
        .add(`${member}.rsc`)
        .add(`${member}.segments/${segmentPath}/__PAGE__.segment.rsc`)
        .add(`${member}.segments/${segmentPath}.segment.rsc`)
        .add(`/_next/data/${BUILD_ID}${member}.json`)
        .add(`${member}/extra`);
    }
  }
  for (let count = 0; count < 1000; count += 1) {
    const length = 1 + Math.floor(next() * 5);
    const parts = Array.from({ length }, () => FUZZ[Math.floor(next() * FUZZ.length)] ?? 'x');
    pathnames.add(`/${parts.join('/')}`);
  }
  return [...pathnames];
}

const PATHNAMES = corpus();
const REQUESTS: readonly {
  readonly search: string;
  readonly host: string;
  readonly headers: Record<string, string>;
}[] = [
  { search: '', host: 'app.example.com', headers: {} },
  { search: '', host: 'app.example.com', headers: { cookie: DRAFT_COOKIES } },
  { search: '', host: 'app.example.com', headers: { cookie: '__prerender_bypass=wrong' } },
  { search: '?variant=red&utm_source=x', host: 'app.example.com', headers: { 'x-legacy': '1' } },
  { search: '', host: 'docs.example.com', headers: { cookie: 'session=abc' } },
];

interface Asked {
  readonly url: URL;
  readonly headers: Headers;
}

function everyRequest(): Asked[] {
  return REQUESTS.flatMap((request) => {
    return PATHNAMES.map((pathname) => {
      return {
        url: new URL(`https://${request.host}${pathname}${request.search}`),
        headers: new Headers(request.headers),
      };
    });
  });
}

const ASKED = everyRequest();

function disagreements<T>(
  ask: (asked: Asked) => { readonly now: T; readonly before: T },
): string[] {
  return ASKED.flatMap((asked) => {
    const { now, before } = ask(asked);
    return JSON.stringify(now) === JSON.stringify(before)
      ? []
      : [`${asked.url.href}: ${JSON.stringify(now)} ≠ ${JSON.stringify(before)}`];
  });
}

/** The manifest's data routes, by index: read once, rather than for every request asked. */
const DATA_ROUTES: ReadonlySet<number> = new Set(
  (MANIFEST.dynamicRoutes ?? []).flatMap((route, index) =>
    DATA_MARKERS.some((marker) => requiresLiteral(route.sourceRegex, marker)) ? [index] : [],
  ),
);

/** What answered first: a data route, a page with a shell or one without, or nothing. */
function firstMatchKind(index: number): string {
  const route = MANIFEST.dynamicRoutes?.[index];
  if (route === undefined) {
    return 'none';
  }
  if (DATA_ROUTES.has(index)) {
    return 'data';
  }
  return route.route === undefined ? 'no-shell' : 'shell';
}

describe('patterns compiled once per list', () => {
  it('routes a manifest shaped like a large application’s, two thirds of it data routes', () => {
    const routes = MANIFEST.dynamicRoutes ?? [];
    const data = routes.filter((route) =>
      DATA_MARKERS.some((marker) => requiresLiteral(route.sourceRegex, marker)),
    );

    expect(routes.length).toBeGreaterThan(500);
    expect(data.length / routes.length).toBeGreaterThan(0.6);
    // Spelled as Next.js spells them, without the unicode flag: `\-` is no escape with it.
    expect(() => compiled(routes[0]?.sourceRegex ?? '', 'u')).toThrow(SyntaxError);
    expect(PATHNAMES.length).toBeGreaterThan(2500);
  });

  // Tens of thousands of requests, each asked of every route in turn by the matching it replaces.
  it(
    'picks the class Next.js picks for every pathname, as each pattern compiled per request did',
    { timeout: 60_000 },
    () => {
      const reached = new Set<string>();
      const differ = disagreements(({ url, headers }) => {
        const before = firstMatchBefore(MANIFEST, url, headers);
        reached.add(firstMatchKind(before.index));
        return {
          now: matchDynamicRoute(MANIFEST, url, headers)?.pathname,
          before: before.entry?.pathname,
        };
      });

      expect(differ).toStrictEqual([]);
      // Every kind of first match was met: a data route, a page with a shell and one without, none.
      expect([...reached].toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
        'data',
        'no-shell',
        'none',
        'shell',
      ]);
    },
  );

  /**
   * The skip, checked against the engine rather than against the reading of it: no route taken to
   * need a marker matches a pathname without one.
   */
  it('skips for a document only routes no pathname without a data marker matches', () => {
    const plain = PATHNAMES.filter((pathname) =>
      DATA_MARKERS.every((marker) => !pathname.includes(marker)),
    );
    const skipped = (MANIFEST.dynamicRoutes ?? []).filter((route) =>
      DATA_MARKERS.some((marker) => requiresLiteral(route.sourceRegex, marker)),
    );
    const escapes = skipped.flatMap((route) => {
      const regex = compiled(route.sourceRegex);
      return plain
        .filter((pathname) => regex.test(pathname))
        .map((pathname) => `${route.sourceRegex} ${pathname}`);
    });

    expect(plain.length).toBeGreaterThan(1000);
    expect(escapes).toStrictEqual([]);
  });

  it('reserves what the redirects and rewrites claimed, before the filesystem and after it', () => {
    const reserved = MANIFEST.reservedRoutes ?? [];

    expect(
      disagreements(({ url, headers }) => {
        return {
          now: [
            isReserved(MANIFEST, url, headers, false),
            isReserved(MANIFEST, url, headers, true),
          ],
          before: [
            reservedBefore(reserved, url, headers, false),
            reservedBefore(reserved, url, headers, true),
          ],
        };
      }),
    ).toStrictEqual([]);
  });

  it('sets the headers the rules of next.config set, for a file and for a document', () => {
    expect(
      disagreements(({ url, headers }) => {
        return {
          now: [
            headerRulesFor(MANIFEST, url, headers),
            documentHeaderRulesFor(MANIFEST, url, headers),
            foldedHeadersFor(MANIFEST, url.pathname),
          ],
          before: [
            headersBefore(url, headers, false),
            headersBefore(url, headers, true),
            foldedBefore(MANIFEST, url.pathname),
          ],
        };
      }),
    ).toStrictEqual([]);
  });

  it('runs the middleware where its matchers match, in any case and decoded', () => {
    const matchers = MANIFEST.middleware?.matchers ?? [];
    const extra = [
      '/API/x',
      '/vercel%20copy.svg',
      '/Vercel%20Copy.SVG',
      '/_next/static/a.js',
      '/favicon.ico',
      '/Account/a/b',
      '/bad%zz',
    ];
    const differ = extra.flatMap((pathname) => {
      return REQUESTS.map((request) => {
        const url = new URL(`https://${request.host}${pathname}`);
        const headers = new Headers(request.headers);
        return middlewareApplies(matchers, url, headers) ===
          middlewareBefore(matchers, url, headers)
          ? ''
          : url.href;
      });
    });

    expect(matchers).toStrictEqual(MIDDLEWARE_MATCHERS);
    expect(differ.filter((href) => href !== '')).toStrictEqual([]);
    expect(
      disagreements(({ url, headers }) => {
        return {
          now: middlewareApplies(matchers, url, headers),
          before: middlewareBefore(matchers, url, headers),
        };
      }),
    ).toStrictEqual([]);
  });
});

describe('conditions compiled once each', () => {
  /** As a partially prerendered page's `bypassFor` is written, and conditions that do not compile. */
  const BYPASS_FOR: RouteHas[] = [
    { type: 'header', key: 'next-action' },
    { type: 'header', key: 'content-type', value: 'multipart/form-data;.*' },
    { type: 'header', key: 'user-agent', value: HTML_LIMITED_BOTS },
  ];
  const ODD: RouteHas[] = [
    // Neither form compiles: compared as it is spelled.
    { type: 'header', key: 'x-odd', value: '(unclosed' },
    // The whole-value form compiles and the bare one does not.
    { type: 'header', key: 'x-odd', value: 'a)(?:b' },
    { type: 'query', key: 'q', value: '(?<v>yes|true)' },
    { type: 'cookie', key: 'session', value: 'ab+c' },
  ];
  const AGENTS = [
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Slackbot-LinkExpanding 1.0',
    'Mediapartners-Google',
    '',
    // Past the substring bound: only the whole-value form is tried.
    `${'x'.repeat(5000)} Slurp`,
  ];
  const VALUES_ASKED = [
    '(unclosed',
    'a)(?:b',
    'ab',
    'abbbc',
    'yes',
    'nope',
    'multipart/form-data; boundary=x',
  ];

  function requests(): Asked[] {
    return AGENTS.flatMap((agent) => {
      return VALUES_ASKED.map((value) => {
        return {
          url: new URL(`https://app.example.com/en?q=${encodeURIComponent(value)}`),
          headers: new Headers({
            'user-agent': agent,
            'content-type': value,
            'x-odd': value,
            cookie: `session=${value}`,
          }),
        };
      });
    });
  }

  it('holds where each condition compiled per request held, the bypass list and odd patterns alike', () => {
    const differ = requests().flatMap(({ url, headers }) => {
      return [...BYPASS_FOR, ...ODD].flatMap((condition) => {
        const now = [
          anyConditionHolds([condition], url, headers),
          conditionsHold({ has: [condition] }, url, headers),
          conditionsHold({ missing: [condition] }, url, headers),
        ];
        const before = [
          wasMatched(condition, url, headers),
          heldBefore({ has: [condition] }, url, headers),
          heldBefore({ missing: [condition] }, url, headers),
        ];
        return JSON.stringify(now) === JSON.stringify(before)
          ? []
          : [`${JSON.stringify(condition)} ${headers.get('user-agent')?.slice(0, 40)}`];
      });
    });

    expect(differ).toStrictEqual([]);
    expect(requests().some(({ url, headers }) => anyConditionHolds(BYPASS_FOR, url, headers))).toBe(
      true,
    );
  });
});

/** The large application's manifest, with `routes` for its dynamic routes. */
function withDynamicRoutes(routes: DynamicRoute[]): ProjectManifest {
  return { ...MANIFEST, dynamicRoutes: routes };
}

describe('a pattern that does not compile', () => {
  /** As it always has: compiled where it is reached, and only there — whatever it claims to need. */
  it('throws where it is reached, and only there', () => {
    const page = {
      sourceRegex: '^[/]?/en/(?<nxtPorgSlug>[^/]+?)(?:/)?$',
      route: '/en/[orgSlug]',
    };
    const unclosed = { sourceRegex: String.raw`^[/]?/(?<nxtPslug>[^/]+?)\.rsc(?:/)?$(` };
    const reached = withDynamicRoutes([unclosed, page]);
    const behind = withDynamicRoutes([page, unclosed]);
    const url = new URL('https://app.example.com/en/acme');
    const headers = new Headers();

    expect(() => matchDynamicRoute(reached, url, headers)).toThrow(SyntaxError);
    expect(() => matchDynamicRoute(reached, url, headers)).toThrow(SyntaxError);
    expect(matchDynamicRoute(behind, url, headers)?.pathname).toBe('/en/[orgSlug]');
  });
});
