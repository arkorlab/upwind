import { readFileSync } from 'node:fs';

import {
  type DeploymentBundle,
  type Prerender,
  prerenderResponseHeaders,
  staticPagePrivacyFor,
} from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import {
  isAsExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isStringLiteral,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript-api/ast';
import { API } from 'typescript-api/sync';
import { describe, expect, it } from 'vitest';

const GENERATED_AT = '2026-10-20T00:00:00.000Z';
const PAGE: Prerender = {
  id: 'html',
  pathname: '/something',
  route: '/something',
  parentOutputId: 'page',
  groupId: 1,
  routeType: 'page',
  response: 'complete',
  compute: 'static',
  initialRevalidate: 2,
  body: { sha256: 'a'.repeat(64), byteLength: 8, contentType: 'text/html' },
};
const FUNCTION = {
  mainModule: 'index.mjs',
  modules: [],
  compatibilityDate: '2026-10-01',
  compatibilityFlags: [],
};
function bundleOf(extra: Partial<DeploymentBundle> = {}): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: GENERATED_AT,
    staticPagesPrivacy: 2,
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
    },
    entrypoints: [{ id: 'page', kind: 'pages', pathname: '/something' }],
    prerenders: [PAGE],
    staticFiles: [],
    functions: { app: FUNCTION },
    ...extra,
  };
}

function referenceProperty(object: ObjectLiteralExpression): 'one-pass' | undefined {
  const field = object.properties.find((property) => {
    return (
      isPropertyAssignment(property) &&
      isIdentifier(property.name) &&
      property.name.text === 'routerReferences'
    );
  });
  if (field === undefined || !isPropertyAssignment(field)) return undefined;
  const value = isAsExpression(field.initializer)
    ? field.initializer.expression
    : field.initializer;
  return isStringLiteral(value) && value.text === 'one-pass' ? 'one-pass' : undefined;
}

/** Read the producer's actual field without importing the adapter or building Next.js. */
function runtimeReferences(node: Node): 'one-pass' | undefined {
  if (
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    node.name.text === 'baseRuntimeManifest' &&
    node.initializer !== undefined &&
    isObjectLiteralExpression(node.initializer)
  )
    return referenceProperty(node.initializer);
  return node.forEachChild(runtimeReferences);
}

describe('runtime manifest privacy authority', () => {
  it('keeps captured privacy headers identical in the emitted runtime manifest and bundle', () => {
    const pathname = '/publicprivate';
    const page = { ...PAGE, pathname, route: pathname };
    const bundle = bundleOf({
      routerReferences: 'one-pass',
      prerenders: [page],
      entrypoints: [{ id: 'page', kind: 'pages', pathname }],
    });
    bundle.routing.beforeMiddleware = [
      {
        sourceRegex: '^/(public)()()()()()()()()(private)$',
        headers: { 'cache-control': '$10' },
      },
    ];
    // The repository-owned source URL is fixed; no request or environment input selects a file.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    using api = new API({ cwd: process.cwd() });
    using parsed = api.createSourceFile('index.ts', source);
    const runtime = {
      ...bundle,
      routerReferences: runtimeReferences(parsed.sourceFile),
    };
    const legacy = { ...bundle, routerReferences: undefined };

    expect(prerenderResponseHeaders(legacy, page).get('cache-control')).toBe('public0');
    expect(staticPagePrivacyFor(legacy, page)).toBe(2);
    expect(prerenderResponseHeaders(runtime, page).get('cache-control')).toBe('private');
    expect(prerenderResponseHeaders(runtime, page)).toStrictEqual(
      prerenderResponseHeaders(bundle, page),
    );
    expect(staticPagePrivacyFor(runtime, page)).toBeUndefined();
    expect(staticPagePrivacyFor(bundle, page)).toBeUndefined();
  });
});
