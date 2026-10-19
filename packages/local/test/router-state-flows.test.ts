import type { DeploymentBundle, RouteHas } from '@stayingupwind/core/bundle';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { NEXT_ROUTER_STATE_TREE_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { cookieFor, jarOf, NO_COOKIE_CHANGES, storedAfter } from '../src/cookie-jar.ts';
import { type AnsweredAsks, flowFailure } from '../src/part-flows.ts';
import type { Part } from '../src/part-marks.ts';
import { type Answered, askKey, cookieOn, redirectsFrom } from '../src/redirects.ts';
import { stateTreeOf } from '../src/router-state.ts';

const SITE = new URL('https://site.example');
const AT = '2026-10-19T00:00:00.000Z';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TREE: RouteHas = {
  type: 'header',
  key: NEXT_ROUTER_STATE_TREE_HEADER,
  value: '^other-tree$',
};
const SELECTED: RouteHas = { type: 'cookie', key: 'variant', value: '^selected$' };
const COOKIE = 'variant=selected';
const SET_COOKIE = { set: [`${COOKIE}; Path=/`], cleared: false };
const QUIET: Answered = { changes: NO_COOKIE_CHANGES, account: '', page: false };

function at(path: string): URL {
  return new URL(path, SITE);
}

function route(pathname: string): RouteEntry {
  return {
    pathname,
    status: 200,
    shell: { sha256: EMPTY_SHA, byteLength: 0, contentType: 'text/html', encoding: 'identity' },
    headers: {},
  };
}

function bundle(): DeploymentBundle {
  return {
    v: 1,
    deploymentId: 'dpl_site',
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: AT,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'rsc',
        varyHeader: 'rsc',
        prefetchHeader: 'next-router-prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'next-router-segment-prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: AT.slice(0, 10),
        compatibilityFlags: [],
      },
    },
  };
}

function stackFor(sourceRegex: string, condition?: RouteHas): CheckedStack {
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: AT,
    originHost: SITE.hostname,
    deployment: { assetSetHash: EMPTY_SHA, observedAt: AT },
    app: { deploymentId: 'dpl_site', scriptName: 'app' },
    routes: [route('/about'), route('/seed'), route('/login'), route('/finish')],
    headerRules: [
      { sourceRegex, has: condition === undefined ? [TREE] : [TREE, condition], headers: {} },
    ],
  });
  return {
    url: SITE,
    site: SITE,
    functions: [],
    backstage: at('/_backstage/'),
    bundleDir: '.',
    bundle: bundle(),
    deploymentId: 'dpl_site',
    manifest,
    app: manifest.app,
    policy: { ...DEFAULT_DELIVERY_POLICY, id: 'default' },
    cspNonce: undefined,
    dispose: () => Promise.resolve(),
  };
}

function payload(path: string, state = true): Part {
  const built = undefined;
  return {
    kind: 'payload',
    what: `payload ${path}`,
    url: at(`${path}?_rsc=navigation-digest`),
    headers: {
      rsc: '1',
      'accept-encoding': 'identity',
      ...(state && { [NEXT_ROUTER_STATE_TREE_HEADER]: stateTreeOf('/from') }),
    },
    route: route(path),
    built,
    builtOn: () => built,
    exact: true,
  };
}

function answers(): AnsweredAsks {
  return { judged: new Map(), followed: new Map() };
}

/** Previously judged responses exercise real flow/cookie/cache plumbing without a fake transport. */
function keep(
  known: Map<string, Answered>,
  part: Part,
  cookie: string | undefined,
  own = QUIET,
): void {
  known.set(askKey(part.url, cookieOn(part.headers, cookie)), own);
}

function emptyJar() {
  return jarOf(undefined, { document: SITE });
}

function onward(location: string, changes = NO_COOKIE_CHANGES): Answered {
  return { ...QUIET, location, changes };
}

describe('state-sensitive rules with actual flow cookies and redirected URLs', () => {
  it('allows a flow whose actual cookies do not meet the known condition', async () => {
    const stack = stackFor('^/about$', SELECTED);
    const part = payload('/about');
    const known = answers();
    keep(known.judged, part, undefined);
    const result = await flowFailure(
      stack,
      [part],
      { jar: emptyJar(), referred: 'page', as: '' },
      known,
    );

    expect(result).toBeUndefined();
  });

  it('checks navigation cookies before reusing an already-judged answer', async () => {
    const stack = stackFor('^/about$', SELECTED);
    const part = payload('/about');
    const jar = storedAfter(emptyJar(), SET_COOKIE, at('/about'));
    const known = answers();
    keep(known.judged, part, COOKIE);
    const result = await flowFailure(stack, [part], { jar, referred: 'page', as: '' }, known);

    expect(cookieFor(jar, part.url)).toBe(COOKIE);
    expect(result).toContain('a rule of next.config asks of the router state');
  });

  it('rechecks after an earlier part leaves a different cookie jar', async () => {
    const stack = stackFor('^/about$', SELECTED);
    const seed = payload('/seed', false);
    const part = payload('/about');
    const known = answers();
    const setting = { ...QUIET, changes: SET_COOKIE };
    keep(known.judged, seed, undefined, setting);
    keep(known.judged, seed, COOKIE, setting);
    keep(known.judged, part, undefined);
    keep(known.judged, part, COOKIE);
    const result = await flowFailure(
      stack,
      [seed, part],
      { jar: emptyJar(), referred: 'page', as: '' },
      known,
    );

    expect(result).toContain('with the cookies set by payload /seed');
    expect(result).toContain('a rule of next.config asks of the router state');
  });

  it('uses cookies set by the redirect before considering its landing irrelevant', async () => {
    const stack = stackFor('^/login$', SELECTED);
    const part = payload('/about');
    const known = new Map<string, Answered>([
      [askKey(at('/login'), cookieOn(part.headers, COOKIE)), QUIET],
    ]);
    const result = await redirectsFrom(
      stack,
      {
        answered: onward('/login', SET_COOKIE),
        url: part.url,
        headers: part.headers,
        jar: emptyJar(),
      },
      known,
    );

    expect(result.failure).toContain('redirected to /login, a rule of next.config asks');
    expect(result.steps).toHaveLength(0);
  });

  it('checks an intermediate redirect even when the final landing has no state-sensitive rule', async () => {
    const stack = stackFor('^/middle$');
    const part = payload('/about');
    const known = new Map<string, Answered>([
      [askKey(at('/finish'), part.headers), QUIET],
      [askKey(at('/first'), part.headers), onward('/middle')],
      [askKey(at('/middle'), part.headers), onward('/finish')],
    ]);
    const result = await redirectsFrom(
      stack,
      { answered: onward('/first'), url: part.url, headers: part.headers, jar: emptyJar() },
      known,
    );

    expect(result.failure).toContain('redirected to /middle, a rule of next.config asks');
    expect(result.steps).toHaveLength(1);
  });

  it('continues through redirects whose actual paths do not match the state-sensitive rule', async () => {
    const stack = stackFor('^/private$');
    const part = payload('/about');
    const known = new Map<string, Answered>([
      [askKey(at('/finish'), part.headers), QUIET],
      [askKey(at('/first'), part.headers), onward('/finish')],
    ]);
    const result = await redirectsFrom(
      stack,
      { answered: onward('/first'), url: part.url, headers: part.headers, jar: emptyJar() },
      known,
    );

    expect(result.failure).toBeUndefined();
    expect(result.landed?.url.pathname).toBe('/finish');
    expect(result.steps).toHaveLength(2);
  });
});
