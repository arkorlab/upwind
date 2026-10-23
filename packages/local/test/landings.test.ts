import {
  buildProjectManifest,
  type ProjectManifest,
  type RouteEntry,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import {
  claimedAsLeft,
  landingOf,
  movedAway,
  movedFailure,
  servedOtherThan,
} from '../src/landings.ts';

const REPORT_PATH = '/report.pdf';
const REPORT: StaticFileEntry = {
  sha256: 'a'.repeat(64),
  byteLength: 1,
  contentType: 'application/pdf',
  immutable: false,
};

function routedFile(
  file: StaticFileEntry | undefined,
  options: {
    readonly exact?: boolean;
    readonly reserved?: boolean;
    readonly sentinel?: boolean;
  } = {},
) {
  const route: RouteEntry = {
    pathname: '/[...slug]',
    status: 200,
    shell: {
      sha256: REPORT.sha256,
      byteLength: REPORT.byteLength,
      contentType: 'text/html',
      encoding: 'identity',
    },
    headers: {},
    prerenderId: 'class',
  };
  const exact = { ...route, pathname: REPORT_PATH };
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: '2026-10-19T00:00:00.000Z',
    originHost: 'site.example',
    deployment: {
      assetSetHash: 'b'.repeat(64),
      observedAt: '2026-10-19T00:00:00.000Z',
      dplId: 'dpl_current',
    },
    app: { deploymentId: 'dpl_current', scriptName: 'app' },
    routes: options.exact === true ? [route, exact] : [route],
    staticFiles: file === undefined ? {} : { [REPORT_PATH]: file },
    dynamicRoutes: [{ sourceRegex: '^/(.+)$', route: route.pathname }],
    ...(options.reserved === true && {
      reservedRoutes: [{ sourceRegex: '^/report[.]pdf$', beforeFiles: true }],
    }),
    ...(options.sentinel === true && { exactPathnames: [REPORT_PATH] }),
  });
  return { stack: { manifest }, route, exact };
}

function ontoReport(rewritten: boolean): Extract<MiddlewareResult, { kind: 'continue' }> {
  return {
    kind: 'continue',
    url: new URL(REPORT_PATH, 'https://site.example'),
    rewritten,
    requestHeaders: new Headers(),
    responseHeaders: new Headers(),
    setCookie: undefined,
  };
}

/** A manifest that holds `routes` alone, which is all a route's account is read against. */
function holding(...routes: string[]): ProjectManifest {
  const held: Pick<ProjectManifest, 'routes'> = {
    routes: Object.fromEntries(routes.map((route) => [route, {} as never])),
  };
  return held as ProjectManifest;
}

describe('the route the edge says it served a document as', () => {
  it('is the route asked for where the account names it among others it may mean', () => {
    // A route named like another's generation of it: `/foo`, and `/foo;cache=fresh;seq=2`.
    const manifest = holding('/foo', '/foo;cache=fresh;seq=2');
    const account = 'shell;strategy=edge;cont=none;mw=miss;route=/foo;cache=fresh;seq=2';

    expect(servedOtherThan(manifest, account, '/foo')).toBeUndefined();
    expect(servedOtherThan(manifest, account, '/bar')).toBe('/foo;cache=fresh;seq=2');
  });
});

describe('whether a rule claims a request as the middleware left it', () => {
  // A rule behind the filesystem, which claims a member of a class carrying a header.
  const manifest: Pick<ProjectManifest, 'reservedRoutes' | 'routes'> = {
    reservedRoutes: [{ sourceRegex: '^/items/(.+)$', has: [{ type: 'header', key: 'x-tag' }] }],
    routes: {},
  };
  const stack = { manifest } as unknown as CheckedStack;
  const url = new URL('https://site.example/items/1');
  const sent = { route: {} as RouteEntry, url, headers: {}, exact: false };

  it('judges it behind the rules ahead of the filesystem alone, where the middleware moved it', () => {
    // The middleware added the header, which has the edge route the request again.
    const decided: MiddlewareResult = {
      kind: 'continue',
      url,
      rewritten: false,
      requestHeaders: new Headers({ 'x-tag': '1' }),
      responseHeaders: new Headers(),
      setCookie: undefined,
    };

    expect(claimedAsLeft(stack, sent, decided)).toBe(false);
    // Sent with the header itself, a member of a class is claimed by every rule.
    expect(claimedAsLeft(stack, { ...sent, headers: { 'x-tag': '1' } }, undefined)).toBe(true);
  });
});

describe('where a rewritten document lands beside a shipped file and a class', () => {
  it.each([
    { label: 'current', file: REPORT },
    { label: 'retained', file: { ...REPORT, deploymentId: 'dpl_previous' } },
  ])('reports the $label file as outside the class before judging its answer', (example) => {
    const { stack, route } = routedFile(example.file);
    const decided = ontoReport(true);

    expect(landingOf(stack, decided.url, decided)).toBeUndefined();
    expect(movedAway(stack, route, decided)).toBe(true);
    expect(movedFailure(stack, route, decided)).toBe(
      'served as the route asked for, though rewritten to /report.pdf, no route of the build',
    );
  });

  it('leaves a file kept for an old deployment alone to the current class', () => {
    const { stack, route } = routedFile({ ...REPORT, deploymentId: 'dpl_previous', dplOnly: true });
    const decided = ontoReport(true);

    expect(landingOf(stack, decided.url, decided)).toStrictEqual(route);
    expect(movedAway(stack, route, decided)).toBe(false);
    expect(movedFailure(stack, route, decided)).toBeUndefined();
  });

  it('keeps header-only rerouting on its existing document lookup', () => {
    const { stack, route } = routedFile(REPORT);
    const decided = ontoReport(false);

    expect(landingOf(stack, decided.url, decided)).toStrictEqual(route);
    expect(movedAway(stack, route, decided)).toBe(false);
  });

  it('retains the exact document route ahead of a file with the same name', () => {
    const { stack, exact } = routedFile(REPORT, { exact: true });
    const decided = ontoReport(true);

    expect(landingOf(stack, decided.url, decided)).toStrictEqual(exact);
  });

  it.each([{ reserved: true }, { sentinel: true }] as const)(
    'keeps an existing non-dynamic gate: %j',
    (options) => {
      const { stack } = routedFile(undefined, options);
      const decided = ontoReport(true);

      expect(landingOf(stack, decided.url, decided)).toBeUndefined();
    },
  );
});
