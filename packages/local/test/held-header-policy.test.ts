import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import type { HeaderRule } from '@stayingupwind/core/manifest';
import { assembleManifest } from '@stayingupwind/deploy/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { scanPreloadLinks } from '@stayingupwind/host/preloads';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { afterEach, describe, expect, it } from 'vitest';

import type { CheckedStack, Verdict } from '../src/answers.ts';
import { unheldRoutes } from '../src/held-routes.ts';
import { misheldRules } from '../src/held-rules.ts';

const AT = '2026-10-19T00:00:00.000Z';
const HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/app.css"></head><body>page</body></html>';
const DIGEST = createHash('sha256').update(HTML).digest('hex');
const SHELL = { sha256: DIGEST, byteLength: Buffer.byteLength(HTML), contentType: 'text/html' };
const directories: string[] = [];

const CAPTURED_CASES: readonly {
  readonly label: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly deferred: string;
  readonly folded: boolean;
}[] = [
  { label: 'captured name', headers: { $1: "script-src 'none'" }, deferred: '$1', folded: false },
  {
    label: 'captured CSP value',
    headers: { 'Content-Security-Policy': 'script-src $1' },
    deferred: 'Content-Security-Policy',
    folded: false,
  },
  {
    label: 'legacy named CSP capture',
    headers: { 'content-security-policy': 'script-src :policy' },
    deferred: 'content-security-policy',
    folded: false,
  },
  {
    label: 'folded captured policy',
    headers: { 'content-security-policy': 'script-src $1' },
    deferred: 'content-security-policy',
    folded: true,
  },
];

const POLICY_CASES: readonly {
  readonly label: string;
  readonly pathname: string;
  readonly rules: readonly HeaderRule[];
  readonly hints: number;
}[] = [
  {
    label: 'pathname-only member policy',
    pathname: '/items/[id]',
    rules: [{ sourceRegex: '^/items/private$', headers: { 'referrer-policy': 'no-referrer' } }],
    hints: 0,
  },
  {
    label: 'class captured header name',
    pathname: '/items/[id]',
    rules: [{ sourceRegex: '^/items/(.*)$', headers: { $1: 'no-referrer' } }],
    hints: 0,
  },
  {
    label: 'class captured policy value',
    pathname: '/items/[id]',
    rules: [{ sourceRegex: '^/items/(.*)$', headers: { 'referrer-policy': '$1' } }],
    hints: 0,
  },
  {
    label: 'concrete interpolated policy',
    pathname: '/items/no-referrer',
    rules: [
      {
        sourceRegex: '^/items/(.*)$',
        has: [{ type: 'header', key: 'x-private' }],
        headers: { 'referrer-policy': '$1' },
      },
    ],
    hints: 0,
  },
  {
    label: 'later ordinary concrete override',
    pathname: '/about',
    rules: [
      { sourceRegex: '^/about$', headers: { 'referrer-policy': 'no-referrer' } },
      {
        sourceRegex: '^/about$',
        headers: { 'referrer-policy': 'strict-origin-when-cross-origin' },
      },
    ],
    hints: 1,
  },
  {
    label: 'class ordinary nonpolicy capture value',
    pathname: '/items/[id]',
    rules: [{ sourceRegex: '^/items/(.*)$', headers: { 'x-trace': '$1' } }],
    hints: 1,
  },
];

function sourceRule(rule: HeaderRule): DeploymentBundle['routing']['beforeMiddleware'][number] {
  return {
    sourceRegex: rule.sourceRegex,
    headers: { ...rule.headers },
    ...(rule.has !== undefined && { has: [...rule.has] }),
    ...(rule.missing !== undefined && { missing: [...rule.missing] }),
  };
}

async function deployed(pathname: string, rules: readonly HeaderRule[], folded = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'held-policy-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'blobs'));
  await writeFile(path.join(directory, 'blobs', DIGEST), HTML);
  const prerender: Prerender = {
    id: 'page',
    pathname,
    route: pathname,
    parentOutputId: 'app/page',
    groupId: 1,
    routeType: 'page',
    body: SHELL,
    initialHeaders: { 'content-type': 'text/html' },
    postponed: { sha256: 'b'.repeat(64), byteLength: 1, contentType: 'text/plain' },
  };
  const bundle: DeploymentBundle = {
    v: 1,
    deploymentId: 'dpl_site',
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: AT,
    routerReferences: 'one-pass',
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: true,
      poweredByHeader: false,
      ...(folded && { i18n: { defaultLocale: 'en', locales: ['en'] } }),
    },
    routing: {
      beforeMiddleware: rules.map((rule) => sourceRule(rule)),
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: pathname.includes('[')
        ? [{ sourceRegex: '^/items/([^/]+?)$', destination: pathname }]
        : [],
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
    entrypoints: [{ id: 'app/page', kind: 'app-page', pathname }],
    prerenders: [prerender],
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
  const recovery = await recoveryScriptCspSource();
  const app = { deploymentId: 'dpl_site', scriptName: 'app' };
  const assembled = await assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'site',
    runId: 'run',
    originHost: 'site.example',
    deploymentId: 'dpl_site',
    fingerprint: {
      assetSetHash: 'a'.repeat(64),
      observedAt: AT,
      dplId: 'dpl_site',
      buildId: 'build',
    },
    app,
    generatedAt: AT,
    encodings: new Map(),
    preloads: { [DIGEST]: scanPreloadLinks(Buffer.from(HTML)) },
    recoverySource: recovery,
    nextVersionJudged: true,
  });
  if (assembled.kind !== 'assembled') throw new Error(assembled.reason);
  const stack: CheckedStack = {
    url: new URL('http://localhost:3000'),
    site: new URL('https://site.example'),
    functions: [],
    backstage: new URL('http://localhost:3001'),
    bundleDir: directory,
    bundle,
    deploymentId: 'dpl_site',
    manifest: assembled.manifest,
    app,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: undefined,
    dispose: () => Promise.resolve(),
  };
  return { stack, recovery };
}

async function rulesFailures(stack: CheckedStack) {
  const failures: { path: string; verdict: Verdict }[] = [];
  await misheldRules(stack, {
    add(asked, verdict) {
      failures.push({ path: asked, verdict });
    },
  });
  return failures;
}

async function routeFailures(stack: CheckedStack) {
  const failures: { path: string; verdict: Verdict }[] = [];
  await unheldRoutes(stack, {
    add(asked, verdict) {
      failures.push({ path: asked, verdict });
    },
  });
  return failures;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('held header rules retain document capture preparation', () => {
  it.each(CAPTURED_CASES)('accepts actual deploy preparation for $label', async (example) => {
    const { stack, recovery } = await deployed(
      '/about',
      [{ sourceRegex: '^/(.*)$', headers: example.headers }],
      example.folded,
    );
    const prepared = (
      example.folded ? stack.manifest.foldedHeaderRules : stack.manifest.headerRules
    )?.[0];

    expect(prepared?.documentRecoverySources).toStrictEqual({ [example.deferred]: recovery });
    expect(prepared?.documentHeaders).toBeUndefined();
    await expect(rulesFailures(stack)).resolves.toStrictEqual([]);
  });

  it('keeps ordinary widening beside deferred captured fields and detects tampering', async () => {
    const { stack, recovery } = await deployed('/about', [
      {
        sourceRegex: '^/(.*)$',
        headers: { 'content-security-policy': "script-src 'none'", $1: '$2' },
      },
    ]);
    const prepared = stack.manifest.headerRules?.[0];
    if (prepared === undefined) throw new Error('the fixture must retain its header rule');

    expect(prepared.documentRecoverySources).toStrictEqual({ $1: recovery });
    expect(prepared.documentHeaders?.['content-security-policy']).toContain(recovery);
    expect(prepared.documentHeaders?.['$1']).toBe('$2');
    await expect(rulesFailures(stack)).resolves.toStrictEqual([]);

    const broken = {
      ...stack,
      manifest: {
        ...stack.manifest,
        headerRules: [{ ...prepared, documentRecoverySources: { wrong: recovery } }],
      },
    };

    await expect(rulesFailures(broken)).resolves.toHaveLength(1);
  });
});

describe('held preload policies follow the build for class members and path captures', () => {
  it.each(POLICY_CASES)('accepts actual deploy hints for $label', async (example) => {
    const { stack } = await deployed(example.pathname, example.rules);
    const route = Object.values(stack.manifest.routes)[0];

    expect(route?.preloads ?? []).toHaveLength(example.hints);
    await expect(routeFailures(stack)).resolves.toStrictEqual([]);
  });
});
