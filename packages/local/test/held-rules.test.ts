import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

/* eslint import-x/no-relative-packages: "off" -- Compare the pure checker with the real manifest writer and fixtures without starting a stack. */
import { assembleManifest } from '../../deploy/src/manifest.ts';
import { SHARED_SHELL, shellBundle } from '../../host/test/shared-shell-fixture.ts';
import { isrPageBundle, staticPageBundle } from '../../host/test/static-page-fixture.ts';
import type { CheckedStack, Verdict } from '../src/answers.ts';
import { misheldRules } from '../src/held-rules.ts';

const BUILD_HEADERS = [
  'host',
  'x-matched-path',
  'x-prerender-revalidate',
  'x-prerender-revalidate-if-generated',
  'x-next-revalidated-tags',
  'x-next-revalidate-tag-token',
];

/** A real writer's document and image tables, with no stack, socket or Worker started. */
function writtenStack(allowHeader = BUILD_HEADERS): Promise<CheckedStack> {
  const page = { ...SHARED_SHELL, id: 'front', route: '/', pathname: '/', parentOutputId: 'front' };
  const icon: Prerender = {
    id: 'icon',
    route: '/icon',
    pathname: '/icon',
    parentOutputId: 'icon',
    groupId: 1,
    routeType: 'route',
    response: 'complete',
    compute: 'static',
    renderingMode: 'STATIC',
    initialRevalidate: false,
    body: { sha256: 'c'.repeat(64), byteLength: 100, contentType: 'image/png' },
    allowHeader,
  };
  const bundle = {
    ...shellBundle(page),
    routeBodyPrivacy: 2 as const,
    entrypoints: [
      { id: 'front', kind: 'app-page' as const, pathname: '/' },
      { id: 'icon', kind: 'app-route' as const, pathname: '/icon' },
    ],
    prerenders: [page, icon],
  };
  return writtenBundle(bundle);
}

async function writtenBundle(bundle: DeploymentBundle): Promise<CheckedStack> {
  const result = await assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'site',
    runId: 'run',
    originHost: 'site.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      assetSetHash: 'd'.repeat(64),
      dplId: bundle.deploymentId,
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'app' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
  });
  if (result.kind !== 'assembled') throw new Error(result.reason);
  // These checks read only the build, its deployment id and its manifest, never a socket.
  return { bundle, manifest: result.manifest, deploymentId: bundle.deploymentId } as CheckedStack;
}

async function failures(stack: CheckedStack) {
  const found: { path: string; reason: string }[] = [];
  await misheldRules(stack, {
    add(path: string, verdict: Verdict) {
      if (verdict.kind === 'failed') found.push({ path, reason: verdict.reason });
    },
  });
  return found;
}

describe('routing tables held beside a newly admitted route body', () => {
  it('accepts the writer union of document routes and body paths', async () => {
    const stack = await writtenStack();

    expect(Object.keys(stack.manifest.routeBodies ?? {})).toStrictEqual(['/icon']);
    expect(stack.manifest.exactPathnames).toHaveProperty('/', true);
    await expect(failures(stack)).resolves.toStrictEqual([]);
  });

  it('keeps the original routing table where a visitor header prevents body admission', async () => {
    const stack = await writtenStack(['x-visitor']);

    expect(stack.manifest.routeBodies).toBeUndefined();
    expect(stack.manifest.exactPathnames).not.toHaveProperty('/');
    await expect(failures(stack)).resolves.toStrictEqual([]);
  });

  it.each(['/', '/icon'])('detects a dropped exact entry %s from the build', async (pathname) => {
    const stack = await writtenStack();
    const exactPathnames = Object.fromEntries(
      Object.entries(stack.manifest.exactPathnames ?? {}).filter(([key]) => key !== pathname),
    );
    const changed = { ...stack, manifest: { ...stack.manifest, exactPathnames } };

    await expect(failures(changed)).resolves.toContainEqual({
      path: 'exactPathnames',
      reason: `held by the manifest the edge serves by without the exactPathnames entry ${JSON.stringify(pathname)} the build has`,
    });
  });

  it('still rejects an invented exact entry', async () => {
    const stack = await writtenStack();
    const exactPathnames = { ...stack.manifest.exactPathnames, '/invented': true as const };
    const changed = { ...stack, manifest: { ...stack.manifest, exactPathnames } };

    await expect(failures(changed)).resolves.toContainEqual({
      path: 'exactPathnames',
      reason:
        'held by the manifest the edge serves by with the exactPathnames entry "/invented", which the build has none of',
    });
  });
});

describe('routing tables held beside static Pages without route bodies', () => {
  const examples = [
    { name: 'static privacy 1', bundle: staticPageBundle() },
    { name: 'ISR privacy 2', bundle: isrPageBundle() },
  ];

  it.each(examples)('accepts the writer table for $name', async ({ bundle }) => {
    const stack = await writtenBundle(bundle);

    expect(stack.manifest.routeBodies).toBeUndefined();
    expect(Object.keys(stack.manifest.staticPages ?? {})).toStrictEqual(['/something']);
    expect(stack.manifest.exactPathnames).toHaveProperty('/something', true);
    await expect(failures(stack)).resolves.toStrictEqual([]);
  });

  it.each(examples)('keeps a visitor-dependent $name outside the table', async ({ bundle }) => {
    const privateBundle = {
      ...bundle,
      prerenders: bundle.prerenders.map((page) => ({ ...page, allowHeader: ['x-visitor'] })),
    };
    const stack = await writtenBundle(privateBundle);

    expect(stack.manifest.routeBodies).toBeUndefined();
    expect(stack.manifest.staticPages).toBeUndefined();
    await expect(failures(stack)).resolves.toStrictEqual([]);
  });

  it.each(examples)('detects a dropped $name exact key using the build', async ({ bundle }) => {
    const stack = await writtenBundle(bundle);
    const changed = { ...stack, manifest: { ...stack.manifest, exactPathnames: {} } };

    await expect(failures(changed)).resolves.toContainEqual({
      path: 'exactPathnames',
      reason:
        'held by the manifest the edge serves by without the exactPathnames entry "/something" the build has',
    });
  });

  it.each(examples)('rejects an invented exact key beside $name', async ({ bundle }) => {
    const stack = await writtenBundle(bundle);
    const exactPathnames = { ...stack.manifest.exactPathnames, '/invented': true as const };
    const changed = { ...stack, manifest: { ...stack.manifest, exactPathnames } };

    await expect(failures(changed)).resolves.toContainEqual({
      path: 'exactPathnames',
      reason:
        'held by the manifest the edge serves by with the exactPathnames entry "/invented", which the build has none of',
    });
  });
});
