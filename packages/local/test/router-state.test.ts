import type { RouteHas } from '@stayingupwind/core/bundle';
import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
import { middlewareApplies, readMiddlewareResponse } from '@stayingupwind/core/paas';
import { NEXT_ROUTER_STATE_TREE_HEADER } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

import { stateTreeOf, stateTreeUnproved } from '../src/router-state.ts';

type StateStack = Parameters<typeof stateTreeUnproved>[0];
type Kind = 'reserved' | 'headers' | 'folded' | 'dynamic' | 'middleware';

const KINDS: readonly Kind[] = ['reserved', 'headers', 'folded', 'dynamic', 'middleware'];
const TREE: RouteHas = {
  type: 'header',
  key: NEXT_ROUTER_STATE_TREE_HEADER,
  value: '^other-tree$',
};
const DIGEST: RouteHas = { type: 'query', key: '_rsc', value: '^other-digest$' };
const HEADERS = {
  [NEXT_ROUTER_STATE_TREE_HEADER]: stateTreeOf('/from'),
  'x-variant': 'selected',
  cookie: 'locale=wrong; locale=en',
};
const PAGE = new URL('https://site.example/about?variant=selected&_rsc=navigation-digest');
const DEFAULT_MATCHER: MiddlewareMatcher = { sourceRegex: '^/about$' };
const VISITOR_STATE = stateTreeOf('/visitor');
const VISITOR_TREE: RouteHas = {
  type: 'header',
  key: NEXT_ROUTER_STATE_TREE_HEADER,
  value: `^${VISITOR_STATE}$`,
};

function withRule(kind: Kind, rule: MiddlewareMatcher): StateStack {
  const base = { bundle: { config: {} }, app: {} };
  switch (kind) {
    case 'reserved': {
      return { ...base, manifest: { reservedRoutes: [rule] } };
    }
    case 'headers': {
      return { ...base, manifest: { headerRules: [{ ...rule, headers: {} }] } };
    }
    case 'folded': {
      return { ...base, manifest: { foldedHeaderRules: [{ ...rule, headers: {} }] } };
    }
    case 'dynamic': {
      return { ...base, manifest: { dynamicRoutes: [{ ...rule, route: '/[...slug]' }] } };
    }
    case 'middleware': {
      return { ...base, manifest: { middleware: { matchers: [rule] } } };
    }
  }
}

function reasonFor(rule: MiddlewareMatcher, url = PAGE): string | undefined {
  return stateTreeUnproved(withRule('headers', rule), url, HEADERS);
}

function withMiddleware(options: {
  readonly normalize: boolean;
  readonly path: string;
  readonly running: boolean;
}): StateStack {
  return {
    manifest: {},
    bundle: {
      config: { skipProxyUrlNormalize: options.normalize },
      middleware: { matchers: [{ sourceRegex: options.path }] },
    },
    app: options.running ? { middlewareScriptName: 'middleware' } : {},
  };
}

function behindMiddleware(
  kind: Kind,
  rule: MiddlewareMatcher,
  matcher: MiddlewareMatcher = DEFAULT_MATCHER,
): StateStack {
  const base = withRule(kind, rule);
  const matchers = base.manifest.middleware?.matchers ?? [matcher];
  return {
    ...base,
    manifest: { ...base.manifest, middleware: { matchers } },
    bundle: { config: {}, middleware: { matchers } },
    app: { middlewareScriptName: 'middleware' },
  };
}

function continued(headers: Record<string, string>) {
  const decided = readMiddlewareResponse(
    new Response(null, { headers }),
    PAGE,
    new Headers(HEADERS),
  );
  if (decided.kind !== 'continue') throw new Error('the fixture middleware must continue');
  return decided;
}

function visitorHeaders(headers: Headers): Headers {
  const actual = new Headers(headers);
  actual.set(NEXT_ROUTER_STATE_TREE_HEADER, VISITOR_STATE);
  return actual;
}

function withoutRunningMiddleware(control: 'absent' | 'unmatched' | 'known-false'): StateStack {
  const matcher = {
    sourceRegex: control === 'unmatched' ? '^/elsewhere$' : '^/about$',
    has:
      control === 'known-false'
        ? [{ type: 'header' as const, key: 'x-variant', value: '^private$' }]
        : [],
  };
  const base = behindMiddleware(
    'dynamic',
    {
      sourceRegex: '^/about$',
      has: [TREE, { type: 'header', key: 'x-variant', value: '^private$' }],
    },
    matcher,
  );
  return { ...base, app: control === 'absent' ? {} : base.app };
}

describe('router-state rules that can affect the requested payload', () => {
  it.each(KINDS)('ignores an unrelated %s source', (kind) => {
    const stack = withRule(kind, { sourceRegex: '^/api/private$', has: [TREE] });

    expect(stateTreeUnproved(stack, PAGE, HEADERS)).toBeUndefined();
  });

  it.each(KINDS)('keeps an applicable %s tree predicate unproved', (kind) => {
    const stack = withRule(kind, { sourceRegex: '^/about$', has: [TREE] });

    expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain('a rule of next.config asks');
  });

  it.each(KINDS)('requires the known conditions of a %s rule', (kind) => {
    const stack = withRule(kind, {
      sourceRegex: '^/about$',
      has: [TREE, { type: 'header', key: 'x-variant', value: '^private$' }],
    });

    expect(stateTreeUnproved(stack, PAGE, HEADERS)).toBeUndefined();
  });

  it.each([
    { condition: { type: 'header', key: 'X-VARIANT', value: '^selected$' }, holds: true },
    { condition: { type: 'header', key: 'x-variant', value: '^private$' }, holds: false },
    { condition: { type: 'cookie', key: 'locale', value: '^en$' }, holds: true },
    { condition: { type: 'cookie', key: 'locale', value: '^wrong$' }, holds: false },
    { condition: { type: 'query', key: 'variant', value: '^selected$' }, holds: true },
    { condition: { type: 'query', key: 'absent' }, holds: false },
    { condition: { type: 'host', value: '^site[.]example$' }, holds: true },
    { condition: { type: 'host', value: '^other[.]example$' }, holds: false },
  ] satisfies readonly { readonly condition: RouteHas; readonly holds: boolean }[])(
    'uses known has/missing semantics for $condition',
    ({ condition, holds }) => {
      const has = reasonFor({ sourceRegex: '^/about$', has: [TREE, condition] });
      const missing = reasonFor({ sourceRegex: '^/about$', has: [TREE], missing: [condition] });

      expect(has !== undefined).toBe(holds);
      expect(missing === undefined).toBe(holds);
    },
  );

  it.each([TREE, DIGEST])('leaves an unknown missing predicate open: %s', (condition) => {
    const reason = reasonFor({ sourceRegex: '^/about$', missing: [condition] });

    expect(reason).toContain('a rule of next.config asks');
  });

  it.each([
    { condition: { type: 'header', key: NEXT_ROUTER_STATE_TREE_HEADER } },
    { condition: { type: 'query', key: '_rsc' } },
  ] satisfies readonly { readonly condition: RouteHas }[])(
    'knows the router fields present on the actual navigation: $condition',
    ({ condition }) => {
      const has = reasonFor({ sourceRegex: '^/about$', has: [TREE, condition] });
      const missing = reasonFor({ sourceRegex: '^/about$', has: [TREE], missing: [condition] });

      expect(has).toContain('a rule of next.config asks');
      expect(missing).toBeUndefined();
    },
  );

  it('uses the actual digest presence when a redirect has not replayed it yet', () => {
    const url = new URL('/about', PAGE);
    const present: RouteHas = { type: 'query', key: '_rsc' };
    const has = reasonFor({ sourceRegex: '^/about$', has: [TREE, present] }, url);
    const missing = reasonFor({ sourceRegex: '^/about$', has: [TREE], missing: [present] }, url);

    expect(has).toBeUndefined();
    expect(missing).toContain('a rule of next.config asks');
  });

  it('does not treat a request without the state header as a synthetic navigation', () => {
    const stack = withRule('headers', { sourceRegex: '^/about$', has: [TREE] });

    expect(stateTreeUnproved(stack, PAGE, {})).toBeUndefined();
  });

  it('allows presence-only router conditions whose values no rule reads', () => {
    const reason = reasonFor({
      sourceRegex: '^/about$',
      has: [
        { type: 'header', key: NEXT_ROUTER_STATE_TREE_HEADER },
        { type: 'query', key: '_rsc' },
      ],
    });

    expect(reason).toBeUndefined();
  });

  it.each([
    { sourceRegex: '^/ABOUT$', path: '/about' },
    { sourceRegex: '^/docs/a b$', path: '/docs/a%20b' },
  ])('keeps Next matcher spellings conservative: $path', ({ sourceRegex, path }) => {
    const reason = reasonFor({ sourceRegex, has: [TREE] }, new URL(path, PAGE));

    expect(reason).toContain('a rule of next.config asks');
  });

  it('does not prove an invalid state-sensitive pattern irrelevant', () => {
    expect(reasonFor({ sourceRegex: '[', has: [TREE] })).toContain('a rule of next.config asks');
  });

  it.each([TREE, DIGEST])('keeps middleware-only unknown state matchers open: %s', (condition) => {
    const base = withMiddleware({ normalize: true, path: '^/about$', running: true });
    const stack: StateStack = {
      ...base,
      bundle: {
        ...base.bundle,
        middleware: { matchers: [{ sourceRegex: '^/about$', has: [condition] }] },
      },
    };

    expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain(
      "the application's middleware sees the router state",
    );
  });

  it.each([
    { normalize: true, path: '^/about$', running: true, unproved: true },
    { normalize: false, path: '^/about$', running: true, unproved: false },
    { normalize: true, path: '^/api/private$', running: true, unproved: false },
    { normalize: true, path: '^/about$', running: false, unproved: false },
  ])('preserves middleware normalization handling: %s', ({ unproved, ...options }) => {
    const reason = stateTreeUnproved(withMiddleware(options), PAGE, HEADERS);

    expect(reason !== undefined).toBe(unproved);
  });

  it.each(['reserved', 'dynamic'] as const)(
    'does not exclude a post-middleware %s rule by a changed header',
    (kind) => {
      const rule = {
        sourceRegex: '^/about$',
        has: [VISITOR_TREE, { type: 'header' as const, key: 'x-variant', value: '^private$' }],
      };
      // Response headers also reach the request, as Next's resolver and this protocol specify.
      const decided = continued({ 'x-middleware-next': '1', 'x-variant': 'private' });
      const stack = behindMiddleware(kind, rule);
      const browser = visitorHeaders(new Headers(HEADERS));

      expect(middlewareApplies([rule], PAGE, browser)).toBe(false);
      expect(middlewareApplies([rule], decided.url, visitorHeaders(decided.requestHeaders))).toBe(
        true,
      );
      expect(middlewareApplies([rule], decided.url, decided.requestHeaders)).toBe(false);
      expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain('a rule of next.config asks');
    },
  );

  it.each(['reserved', 'dynamic'] as const)(
    'does not exclude a post-middleware %s rule by the original path or query',
    (kind) => {
      const rule = {
        sourceRegex: '^/private$',
        has: [VISITOR_TREE, { type: 'query' as const, key: 'variant', value: '^private$' }],
      };
      const decided = continued({
        'x-middleware-rewrite': 'https://site.example/private?variant=private',
      });
      const stack = behindMiddleware(kind, rule);
      const browser = visitorHeaders(new Headers(HEADERS));

      expect(middlewareApplies([rule], PAGE, browser)).toBe(false);
      expect(middlewareApplies([rule], decided.url, visitorHeaders(decided.requestHeaders))).toBe(
        true,
      );
      expect(middlewareApplies([rule], decided.url, decided.requestHeaders)).toBe(false);
      expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain('a rule of next.config asks');
    },
  );

  it.each(['headers', 'folded', 'middleware'] as const)(
    'keeps the known conditions of a pre-middleware %s rule',
    (kind) => {
      const stack = behindMiddleware(kind, {
        sourceRegex: '^/about$',
        has: [TREE, { type: 'header', key: 'x-variant', value: '^private$' }],
      });

      expect(stateTreeUnproved(stack, PAGE, HEADERS)).toBeUndefined();
    },
  );

  it.each(['absent', 'unmatched', 'known-false'] as const)(
    'retains the known post-rule filter when middleware is %s',
    (control) => {
      const stack = withoutRunningMiddleware(control);

      expect(stateTreeUnproved(stack, PAGE, HEADERS)).toBeUndefined();
    },
  );

  it.each([TREE, DIGEST])(
    'keeps a bundle-only unknown matcher open after middleware: %s',
    (has) => {
      const base = behindMiddleware('reserved', {
        sourceRegex: '^/elsewhere$',
        has: [TREE],
      });
      const stack: StateStack = {
        ...base,
        manifest: { ...base.manifest, middleware: undefined },
        bundle: {
          config: {},
          middleware: { matchers: [{ sourceRegex: '^/about$', has: [has] }] },
        },
      };

      expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain('a rule of next.config asks');
    },
  );

  it('keeps a manifest-only middleware route open when the build matcher is absent', () => {
    const base = behindMiddleware('dynamic', { sourceRegex: '^/elsewhere$', has: [TREE] });
    const stack = { ...base, bundle: { config: {} } };

    expect(stateTreeUnproved(stack, PAGE, HEADERS)).toContain('a rule of next.config asks');
  });
});
