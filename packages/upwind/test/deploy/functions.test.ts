import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import { RESOURCES_MANIFEST_BINDING } from '@stayingupwind/core/paas';
import { compareCodeUnits } from '@stayingupwind/core/util';
import {
  CACHE_READ_SERVICE_BINDING,
  CACHE_SERVICE_BINDING,
  CACHE_TOKEN_BINDING,
  DEPLOYMENT_ID_BINDING,
  PREFETCH_SERVICE_BINDING,
} from '@stayingupwind/host/bindings';
import { PREFETCH_DEPLOYMENT_ENTRYPOINT } from '@stayingupwind/host/prefetch-audit';
import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope } from '../../src/deploy/cloudflare/workers.ts';
import { type FunctionsInput, uploadFunctions } from '../../src/deploy/functions.ts';
import { functionScripts, projectNames } from '../../src/deploy/names.ts';
import { BUNDLE_PATH } from '../../src/deploy/preflight.ts';
import { bundleOf, deployableFunction, functionOf, moduleOf, projectDir } from './bundle.ts';
import { type FakeCloudflare, type FakeVersion, fakeCloudflare } from './fake-cloudflare.ts';

const NAMES = projectNames('shop');

interface Binding {
  readonly type: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

function scopeOf(fake: FakeCloudflare): AccountScope {
  return {
    client: createCloudflareClient({
      apiToken: 'token',
      fetch: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    accountId: 'account-1',
  };
}

/** A build of an app Function, a split one and the middleware; the app's main module listed last. */
function build(): { readonly dir: string; readonly input: Omit<FunctionsInput, 'scope'> } {
  const dir = projectDir();
  const chunk = moduleOf(dir, 'chunk.js', 'commonjs', 'module.exports = 1;');
  const [main] = deployableFunction(dir).modules;
  if (main === undefined) {
    throw new Error('a deployable Function has a main module');
  }
  const app = functionOf([chunk, main]);
  const bundle = bundleOf(app, {
    functions: {
      app,
      split: { 'app-2': deployableFunction(dir) },
      middleware: functionOf([moduleOf(dir, 'index.mjs', 'esm', 'export default {}; // mw')]),
    },
  });
  return {
    dir,
    input: {
      names: NAMES,
      bundleDir: path.dirname(path.join(dir, BUNDLE_PATH)),
      bundle,
      stores: {
        edgeState: 'kv-edge',
        cacheState: 'kv-cache',
        bucket: NAMES.artifactsBucket,
        storage: [
          { binding: 'SESSIONS', kind: 'kv', id: 'kv-sessions' },
          { binding: 'DB', kind: 'd1', id: 'd1-db' },
          { binding: 'FILES', kind: 'r2', id: 'shop-r2-files' },
        ],
      },
      token: 'v1.token',
      secrets: new Map([['AUTH_SECRET', 'a secret']]),
      logs: true,
      existing: new Set(),
    },
  };
}

function newest(fake: FakeCloudflare, name: string): FakeVersion {
  const version = fake.scripts.get(name)?.versions[0];
  if (version === undefined) {
    throw new Error(`${name} has no version`);
  }
  return version;
}

function bindingsOf(version: FakeVersion): readonly Binding[] {
  return version.metadata['bindings'] as readonly Binding[];
}

function named(version: FakeVersion, name: string): Binding | undefined {
  return bindingsOf(version).find((binding) => binding.name === name);
}

/** Every digest of a bundle's Functions' modules, once each, in order. */
function digestsOf(bundle: DeploymentBundle): string[] {
  const { app, split, middleware } = bundle.functions;
  const specs = [
    app,
    ...Object.values(split ?? {}),
    ...(middleware === undefined ? [] : [middleware]),
  ];
  const digests = new Set<string>();
  for (const spec of specs) {
    for (const module of spec.modules) {
      digests.add(module.blob.sha256);
    }
  }
  return [...digests].toSorted(compareCodeUnits);
}

/** The deployment's Functions uploaded, and the newest version of its first app Function. */
async function uploadedApp(): Promise<{
  readonly input: Omit<FunctionsInput, 'scope'>;
  readonly version: FakeVersion;
}> {
  const fake = fakeCloudflare();
  const { input } = build();
  await uploadFunctions({ ...input, scope: scopeOf(fake) });
  const [app] = functionScripts(NAMES.project, input.bundle);
  return { input, version: newest(fake, app?.scriptName ?? '') };
}

describe("a deployment's Functions", () => {
  it('are each made unreachable, and uploaded with its modules, the main one first', async () => {
    const fake = fakeCloudflare();
    const { input } = build();
    const scripts = functionScripts(NAMES.project, input.bundle).map((script) => script.scriptName);

    const uploaded = await uploadFunctions({ ...input, scope: scopeOf(fake) });

    expect(uploaded.toSorted(compareCodeUnits)).toStrictEqual(scripts.toSorted(compareCodeUnits));

    for (const name of scripts) {
      const script = fake.scripts.get(name);

      expect(script?.subdomain).toStrictEqual({ enabled: false, previews_enabled: false });

      const version = newest(fake, name);

      expect(version.metadata).toMatchObject({
        main_module: 'index.mjs',
        compatibility_date: '2026-09-15',
        compatibility_flags: ['nodejs_compat'],
        annotations: { 'workers/tag': input.bundle.deploymentId },
        observability: { enabled: true },
      });
      expect(version.modules[0]).toBe('index.mjs');
    }

    expect(newest(fake, scripts[0] ?? '').modules).toStrictEqual(['index.mjs', 'chunk.js']);
  });

  it('are each bound to the cache and its read gateway, with the token to their scope', async () => {
    const { input, version } = await uploadedApp();

    expect(named(version, CACHE_SERVICE_BINDING)).toStrictEqual({
      type: 'service',
      name: CACHE_SERVICE_BINDING,
      service: NAMES.cache,
    });
    expect(named(version, CACHE_READ_SERVICE_BINDING)).toStrictEqual({
      type: 'service',
      name: CACHE_READ_SERVICE_BINDING,
      service: NAMES.cacheRead,
    });
    expect(named(version, CACHE_TOKEN_BINDING)).toStrictEqual({
      type: 'secret_text',
      name: CACHE_TOKEN_BINDING,
      text: 'v1.token',
    });
    expect(named(version, DEPLOYMENT_ID_BINDING)).toStrictEqual({
      type: 'plain_text',
      name: DEPLOYMENT_ID_BINDING,
      text: input.bundle.deploymentId,
    });
  });

  it("reach the prefetch Worker for their own bundle's blobs, and none else", async () => {
    const { input, version } = await uploadedApp();
    const prefetch = named(version, PREFETCH_SERVICE_BINDING);
    const props = prefetch?.['props'] as { readonly allowedSha256: Record<string, true> };

    expect(prefetch).toMatchObject({
      type: 'service',
      service: NAMES.prefetch,
      entrypoint: PREFETCH_DEPLOYMENT_ENTRYPOINT,
    });
    expect(Object.keys(props.allowedSha256).toSorted(compareCodeUnits)).toStrictEqual(
      digestsOf(input.bundle),
    );
  });

  it('are bound to the storage the project asked for, listed, and to its secrets', async () => {
    const { version } = await uploadedApp();

    expect(named(version, 'SESSIONS')).toStrictEqual({
      type: 'kv_namespace',
      name: 'SESSIONS',
      namespace_id: 'kv-sessions',
    });
    expect(named(version, 'DB')).toStrictEqual({ type: 'd1', name: 'DB', id: 'd1-db' });
    expect(named(version, 'FILES')).toStrictEqual({
      type: 'r2_bucket',
      name: 'FILES',
      bucket_name: 'shop-r2-files',
    });

    const listed = String(named(version, RESOURCES_MANIFEST_BINDING)?.['text']);

    expect(JSON.parse(listed)).toStrictEqual([
      { name: 'DB', type: 'd1' },
      { name: 'FILES', type: 'r2_bucket' },
      { name: 'SESSIONS', type: 'kv_namespace' },
    ]);
    expect(named(version, 'AUTH_SECRET')).toStrictEqual({
      type: 'secret_text',
      name: 'AUTH_SECRET',
      text: 'a secret',
    });

    // No name is bound twice.
    const names = bindingsOf(version).map((binding) => binding.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('are given no way to a cache without a token, and keep no logs unless asked', async () => {
    const fake = fakeCloudflare();
    const { input } = build();
    await uploadFunctions({
      ...input,
      scope: scopeOf(fake),
      token: undefined,
      logs: false,
      stores: { ...input.stores, storage: [] },
      secrets: new Map(),
    });
    const [app] = functionScripts(NAMES.project, input.bundle);
    const version = newest(fake, app?.scriptName ?? '');

    expect(named(version, CACHE_SERVICE_BINDING)).toBeUndefined();
    expect(named(version, CACHE_TOKEN_BINDING)).toBeUndefined();
    expect(named(version, RESOURCES_MANIFEST_BINDING)).toBeUndefined();
    expect(named(version, PREFETCH_SERVICE_BINDING)).toBeDefined();
    expect(version.metadata['observability']).toBeUndefined();
  });

  it('stop being taken up once one of them fails to upload, and settle before it is said', async () => {
    const fake = fakeCloudflare();
    const { input } = build();
    const { app } = input.bundle.functions;
    const names = Array.from({ length: 8 }, (_, index) => `app-${String(index + 2)}`);
    const split = Object.fromEntries(names.map((name) => [name, app]));
    const bundle = { ...input.bundle, functions: { app, split } };
    const scripts = functionScripts(NAMES.project, bundle);
    const [first] = scripts;
    fake.fail({ method: 'PUT', path: `/workers/scripts/${first?.scriptName ?? ''}` }, 400);

    await expect(uploadFunctions({ ...input, bundle, scope: scopeOf(fake) })).rejects.toThrow(
      /Cloudflare answered PUT/u,
    );

    const made = (): number =>
      scripts.filter((script) => fake.scripts.has(script.scriptName)).length;
    const when = made();
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    // As many as were being uploaded beside it, at most; none after it failed, nor after it said so.
    expect(when).toBeLessThanOrEqual(4);
    expect(made()).toBe(when);
  });

  it('are not uploaded, nor made, where a module is not the blob its bundle names', async () => {
    const fake = fakeCloudflare();
    const { input } = build();
    const [chunk] = input.bundle.functions.app.modules;
    writeFileSync(
      path.join(input.bundleDir, 'blobs', chunk?.blob.sha256 ?? ''),
      'module.exports = 2;',
    );

    await expect(uploadFunctions({ ...input, scope: scopeOf(fake) })).rejects.toThrow(
      `chunk.js is not the blob its bundle names (${chunk?.blob.sha256 ?? ''})`,
    );

    const [app] = functionScripts(NAMES.project, input.bundle);

    expect(fake.scripts.has(app?.scriptName ?? '')).toBe(false);
  });
});
