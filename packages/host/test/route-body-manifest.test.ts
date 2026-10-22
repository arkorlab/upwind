import type { DeploymentBundle, Prerender } from '@stayingupwind/core/bundle';
import { deriveEntry } from '@stayingupwind/core/cache';
import { buildProjectManifest, staticFileStatus } from '@stayingupwind/core/manifest';
import { classifyRequest } from '@stayingupwind/core/request';
import { describe, expect, it } from 'vitest';

// Exercise the host writer's pure assembly without adding a cyclic production or test package dependency.
import { assembleManifest } from '../../deploy/src/manifest.ts';
// Validate the writer's internal identity helper without exporting it as a production API.
import { routeBodiesOf } from '../../deploy/src/route-bodies.ts';
import { staticFilesOf } from '../../deploy/src/static-files.ts';
import { seedRouteFor } from '../src/bundle/cache-seed.ts';
import { shellBundle } from './shared-shell-fixture.ts';

const SCOPE = 'dpl_icon';
const ICON: Prerender = {
  id: 'icon',
  route: '/icon',
  pathname: '/icon',
  parentOutputId: 'icon',
  groupId: 1,
  routeType: 'route',
  response: 'complete',
  compute: 'static',
  renderingMode: 'STATIC',
  body: { sha256: 'a'.repeat(64), byteLength: 100, contentType: 'image/png' },
  initialStatus: 200,
  initialHeaders: { 'content-type': 'image/png' },
  initialRevalidate: false,
};

function bundleOf(prerender = ICON) {
  const bundle = shellBundle(prerender, 'app-route');
  return {
    ...bundle,
    deploymentId: SCOPE,
    routeBodyPrivacy: 2 as const,
    entrypoints: [{ id: prerender.route, kind: 'app-route' as const, pathname: prerender.route }],
  };
}

describe('a retained static asset beside a new base path', () => {
  it.each([404, 500])(
    "keeps the previous asset at 200 beside this build's %s document",
    (status) => {
      const pathname = `/_next/static/prior/${status}`;
      // The old build emitted an ordinary asset at this name; only the new base path makes it an
      // error document. Retention carries the old _next/static file, not an old public error page.
      const previous = {
        ...bundleOf(),
        deploymentId: 'dpl_previous',
        staticFiles: [
          {
            pathname,
            blob: {
              sha256: 'b'.repeat(64),
              byteLength: 3,
              contentType: 'application/octet-stream',
            },
            immutable: false,
          },
        ],
      };
      const bundle = {
        ...bundleOf(),
        config: { ...previous.config, basePath: '/_next/static/prior' },
        staticFiles: [
          {
            pathname,
            blob: { sha256: 'c'.repeat(64), byteLength: 4, contentType: 'text/html' },
            immutable: false,
          },
        ],
      };
      const manifest = buildProjectManifest({
        projectId: 'site',
        runId: 'run_files',
        generatedAt: bundle.generatedAt,
        originHost: 'site.example',
        deployment: { dplId: SCOPE, assetSetHash: 'assets', observedAt: bundle.generatedAt },
        routes: [],
        app: { deploymentId: bundle.deploymentId, scriptName: 'icon-app' },
        staticFiles: staticFilesOf(bundle, previous),
      });
      const current = classifyRequest({
        method: 'GET',
        url: new URL(`https://site.example${pathname}`),
        headers: new Headers(),
        manifest,
        deployment: manifest.deployment,
      });
      const selected = classifyRequest({
        method: 'GET',
        url: new URL(`https://site.example${pathname}?dpl=${previous.deploymentId}`),
        headers: new Headers(),
        manifest,
        deployment: manifest.deployment,
      });

      expect(current).toHaveProperty('file.status', status);
      expect(selected).toStrictEqual({
        kind: 'static-file',
        pathname,
        file: {
          ...previous.staticFiles[0]!.blob,
          deploymentId: previous.deploymentId,
          immutable: false,
        },
      });
      expect(staticFileStatus(pathname, previous.config.basePath)).toBe(200);
    },
  );
});

describe('the host manifest points non-HTML bodies at their seeded generations', () => {
  it('uses the same app-route identity as seeding and carries no frozen body or TTL', async () => {
    const bundle = bundleOf();
    const seed = await seedRouteFor(bundle, ICON, {
      scopeId: SCOPE,
      generatedAt: 1_800_000_000_000,
    });

    expect(seed).toBeDefined();

    const expected = await deriveEntry(SCOPE, seed!.input.descriptor);

    expect(seed!.input.generation.outputs[0]?.representationKey).toBe('route-body');
    await expect(routeBodiesOf(bundle, SCOPE)).resolves.toStrictEqual([
      { pathname: '/icon', route: '/icon', entryId: expected.entryId },
    ]);
  });

  it('keeps the Function placement of a split route', async () => {
    const bundle = bundleOf();
    const [entry] = await routeBodiesOf(
      { ...bundle, entrypoints: [{ ...bundle.entrypoints[0]!, function: 'app-2' }] },
      SCOPE,
    );

    expect(entry?.function).toBe('app-2');
  });

  it('does not publish a mapping while reassembling a bundle from an older adapter', async () => {
    const bundle = bundleOf();
    const legacy: DeploymentBundle = { ...bundle };
    delete legacy.routeBodyPrivacy;

    await expect(routeBodiesOf(legacy, SCOPE)).resolves.toStrictEqual([]);
  });

  it.each<Partial<Prerender>>([
    { initialHeaders: { 'cache-control': 'private' } },
    { initialHeaders: { 'cache-control': 'no-store' } },
    { initialHeaders: { vary: '*' } },
    { initialHeaders: { 'set-cookie': 'visitor=1' } },
    { body: { ...ICON.body!, contentType: 'text/html' } },
    { initialHeaders: { 'content-type': 'application/xhtml+xml' } },
    { allowQuery: ['query'] },
    { allowHeader: ['x-visitor'] },
    { initialStatus: 500 },
  ])('does not publish a new mapping for unshareable build output %j', async (changes) => {
    await expect(routeBodiesOf(bundleOf({ ...ICON, ...changes }), SCOPE)).resolves.toStrictEqual(
      [],
    );
  });

  it.each([
    { cached: true, privacy: 2 as const, keys: ['/icon'] },
    { cached: false, privacy: 2 as const, keys: [] },
    { cached: true, privacy: 1 as const, keys: [] },
  ])(
    'assembles privacy contract $privacy with runtime cache $cached',
    async ({ cached, privacy, keys }) => {
      const bundle = { ...bundleOf(), routeBodyPrivacy: privacy };
      const result = await assembleManifest({
        bundle,
        previous: undefined,
        projectId: 'site',
        runId: 'run_icon',
        originHost: 'site.example',
        deploymentId: SCOPE,
        fingerprint: {
          assetSetHash: 'b'.repeat(64),
          dplId: SCOPE,
          buildId: bundle.buildId,
          observedAt: '2026-10-18T00:00:00.000Z',
        },
        app: { deploymentId: SCOPE, scriptName: 'icon-app' },
        generatedAt: '2026-10-18T00:00:00.000Z',
        encodings: new Map(),
        preloads: {},
        recoverySource: "'sha256-recovery'",
        runtimeCache: cached,
      });

      expect(result.kind).toBe('assembled');

      const assembled = requireAssembled(result);

      expect(assembled.manifest.routes).toStrictEqual({});
      expect(assembled.manifest.app).toStrictEqual({ deploymentId: SCOPE, scriptName: 'icon-app' });
      expect(Object.keys(assembled.manifest.routeBodies ?? {})).toStrictEqual(keys);

      expect(assembled.serialized.includes('routeBodies')).toBe(keys.length > 0);
    },
  );
});

function requireAssembled(result: Awaited<ReturnType<typeof assembleManifest>>) {
  if (result.kind !== 'assembled') throw new Error(result.reason);
  return result;
}
