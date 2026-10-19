import type { RouteHas } from '@stayingupwind/core/bundle';
import type { MiddlewareMatcher } from '@stayingupwind/core/manifest';
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
const PAGE = new URL('https://site.example/about?variant=selected');

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
    'knows router fields are present before the navigation digest is built: $condition',
    ({ condition }) => {
      const has = reasonFor({ sourceRegex: '^/about$', has: [TREE, condition] });
      const missing = reasonFor({ sourceRegex: '^/about$', has: [TREE], missing: [condition] });
      expect(has).toContain('a rule of next.config asks');
      expect(missing).toBeUndefined();
    },
  );

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
});
