import { describe, expect, it } from 'vitest';

import type { DeploymentBundle, Route } from '../src/bundle/schema.ts';
import { headerRulesOf } from '../src/bundle/serving.ts';
import { headerRulesFor, requestHeaderRulesFor } from '../src/manifest/dynamic.ts';
import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import type { HeaderRule, ProjectManifest } from '../src/manifest/schema.ts';
import { createId } from '../src/util/index.ts';

/**
 * The phase each header rule of a manifest came from (`HeaderRule.phase`): recorded as the build's
 * routing puts it, carried through the manifest, and read where a request's rules are judged, so
 * that what the rules ahead of the middleware set (`aheadOfMiddleware`) can be told from what a
 * rule that runs on a match does — Next.js judges the latter on the request as finally matched.
 */

const GENERATED_AT = '2026-10-23T00:00:00.000Z';
const CHUNK = 'https://app.example/_next/static/chunks/app.js';
const IMMUTABLE = 'public,max-age=31536000,immutable';

/** The rule `next build` puts among `onMatch` for a build's own assets. */
const ASSETS_ON_MATCH: Route = {
  sourceRegex:
    '^/_next/static/(?:[^/]+/pages|pages|chunks|immutable|runtime|css|image|media|build)/.+',
  headers: { 'cache-control': IMMUTABLE },
};
/** A rule of `next.config`'s `headers()`, which Next.js puts ahead of the middleware. */
const CORS: Route = {
  source: '/:path*',
  sourceRegex: '^(?:/(.*))?$',
  headers: { 'access-control-allow-origin': '*' },
};
/** A redirect, ahead of the middleware as well, whose headers say where it goes. */
const REDIRECT: Route = {
  source: '/old',
  sourceRegex: '^/old$',
  destination: '/new',
  status: 308,
  headers: { Location: '/new' },
};

function bundleWith(routing: Partial<DeploymentBundle['routing']>): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
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
      ...routing,
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  };
}

function manifestFor(headerRules: readonly HeaderRule[]): ProjectManifest {
  return buildProjectManifest({
    projectId: 'p',
    runId: 'r',
    generatedAt: GENERATED_AT,
    originHost: 'app.example',
    deployment: { dplId: 'dpl_active', assetSetHash: 'h', observedAt: GENERATED_AT },
    routes: [],
    app: { deploymentId: 'dpl_active', scriptName: 'app-1' },
    headerRules,
    routerReferences: 'one-pass',
  });
}

describe('the phase of a header rule', () => {
  it("is recorded from the build's routing, ahead of the middleware or on a match", () => {
    const rules = headerRulesOf(
      bundleWith({ beforeMiddleware: [CORS, REDIRECT], onMatch: [ASSETS_ON_MATCH] }),
    );

    expect(rules.map((rule) => [rule.sourceRegex, rule.phase])).toStrictEqual([
      [CORS.sourceRegex, 'beforeMiddleware'],
      [REDIRECT.sourceRegex, 'beforeMiddleware'],
      [ASSETS_ON_MATCH.sourceRegex, 'onMatch'],
    ]);
  });

  it('travels through a stored manifest, and a manifest from before it reads without one', () => {
    const phased = manifestFor(
      headerRulesOf(bundleWith({ beforeMiddleware: [CORS], onMatch: [ASSETS_ON_MATCH] })),
    );
    const unphased = manifestFor([{ sourceRegex: CORS.sourceRegex, headers: { 'x-a': '1' } }]);

    expect(
      parseProjectManifest(serializeManifest(phased)).headerRules?.map((rule) => rule.phase),
    ).toStrictEqual(['beforeMiddleware', 'onMatch']);
    expect(
      parseProjectManifest(serializeManifest(unphased)).headerRules?.map((rule) => rule.phase),
    ).toStrictEqual([undefined]);
  });

  it('keeps a rule that runs on a match out of what is judged ahead of the middleware', () => {
    const manifest = manifestFor(
      headerRulesOf(bundleWith({ beforeMiddleware: [CORS], onMatch: [ASSETS_ON_MATCH] })),
    );
    const url = new URL(CHUNK);
    const configured = headerRulesFor(manifest, url, new Headers());
    const judged = requestHeaderRulesFor(manifest, url, new Headers());
    const ahead = { headers: { 'access-control-allow-origin': '*' }, conditioned: false };

    // Every rule for what the edge answers itself; the ones ahead of the middleware for a Function.
    expect(configured).toStrictEqual({
      headers: { 'access-control-allow-origin': '*', 'cache-control': IMMUTABLE },
      conditioned: false,
      aheadOfMiddleware: ahead,
    });
    expect(judged.response.aheadOfMiddleware).toStrictEqual(ahead);
    expect(judged.document.aheadOfMiddleware).toStrictEqual(ahead);
  });

  it('says whether a rule ahead of the middleware was conditioned, apart from the rest', () => {
    const conditionedOnMatch: HeaderRule = {
      sourceRegex: ASSETS_ON_MATCH.sourceRegex,
      has: [{ type: 'header', key: 'rsc', value: '1' }],
      headers: { 'x-deployment-id': 'dpl' },
      phase: 'onMatch',
    };
    const manifest = manifestFor([
      { sourceRegex: CORS.sourceRegex, headers: { 'x-a': '1' }, phase: 'beforeMiddleware' },
      conditionedOnMatch,
    ]);

    const configured = headerRulesFor(manifest, new URL(CHUNK), new Headers({ rsc: '1' }));

    expect(configured.conditioned).toBe(true);
    expect(configured.aheadOfMiddleware).toStrictEqual({
      headers: { 'x-a': '1' },
      conditioned: false,
    });
  });

  it('tells nothing ahead of the middleware where a rule says no phase', () => {
    const manifest = manifestFor([
      { sourceRegex: CORS.sourceRegex, headers: { 'x-a': '1' }, phase: 'beforeMiddleware' },
      { sourceRegex: ASSETS_ON_MATCH.sourceRegex, headers: { 'cache-control': IMMUTABLE } },
    ]);
    const url = new URL(CHUNK);

    expect(headerRulesFor(manifest, url, new Headers()).aheadOfMiddleware).toBeUndefined();
    expect(
      requestHeaderRulesFor(manifest, url, new Headers()).response.aheadOfMiddleware,
    ).toBeUndefined();
  });
});
