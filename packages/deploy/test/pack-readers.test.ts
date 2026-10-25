import type { DeploymentBundle, FunctionSpec } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import type { ApprovedPackReaderRollout } from '@stayingupwind/host/cache';
import { describe, expect, it } from 'vitest';

import { scopePackReadersOf } from '../src/pack-readers.ts';

function spec(digit: string): FunctionSpec {
  return {
    mainModule: 'index.mjs',
    modules: [
      {
        name: 'index.mjs',
        type: 'esm',
        blob: { sha256: digit.repeat(64), byteLength: 1, contentType: 'text/javascript' },
      },
    ],
    compatibilityDate: '2026-09-15',
    compatibilityFlags: [],
  };
}

function bundle(): DeploymentBundle {
  return {
    v: 1,
    deploymentId: createId('dpl'),
    nextVersion: '16.4.2',
    buildId: 'build',
    projectDir: '.',
    generatedAt: '2026-10-23T00:00:00.000Z',
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
    entrypoints: [],
    prerenders: [],
    staticFiles: [],
    functions: {
      app: spec('a'),
      split: { 'app-2': spec('b') },
      middleware: spec('c'),
      workflow: spec('d'),
      durableObjects: { state: spec('e') },
      cloudflareWorkflows: { jobs: spec('9') },
    },
  };
}

function approval(): ApprovedPackReaderRollout {
  const platformReader = { versionId: 'released-dual-reader', moduleSha256: 'f'.repeat(64) };
  return {
    schemaVersion: 2,
    rolloutId: 'audited-all-traffic-release',
    platform: {
      edge: platformReader,
      authority: platformReader,
      gateway: platformReader,
      readGateway: platformReader,
    },
    functions: ['a', 'b', 'c', 'd', 'e', '9'].map((digit) => {
      return {
        mainModuleSha256: digit.repeat(64),
        hostIdentity: 'reviewed-first-party-host',
        hostModuleSha256: 'f'.repeat(64),
      };
    }),
  };
}

describe('a trusted pack-reader rollout applied to an immutable bundle', () => {
  it('requires approval of every actual main module and records the complete inventory', () => {
    const value = bundle();
    const proof = scopePackReadersOf(value, approval());

    expect(proof).toMatchObject({
      schemaVersion: 2,
      deploymentId: value.deploymentId,
      buildId: value.buildId,
    });
    expect(proof?.consumers.map((consumer) => consumer.name)).toStrictEqual([
      'app',
      'split:app-2',
      'middleware',
      'workflow',
      'durable-object:state',
      'cloudflare-workflow:jobs',
    ]);
    expect(proof?.consumers.map((consumer) => consumer.mainModuleSha256)).toStrictEqual(
      ['a', 'b', 'c', 'd', 'e', '9'].map((digit) => digit.repeat(64)),
    );
  });

  it('binds the inlined reader while allowing separate application bytes to change', () => {
    const value = bundle();
    value.functions.app.modules.push({
      name: 'app.cjs',
      type: 'commonjs',
      blob: { sha256: '9'.repeat(64), byteLength: 1, contentType: 'text/javascript' },
    });
    const proof = scopePackReadersOf(value, approval());

    expect(proof?.consumers[0]).toMatchObject({
      mainModule: 'index.mjs',
      mainModuleSha256: 'a'.repeat(64),
      hostModuleSha256: 'f'.repeat(64),
    });

    value.functions.app.modules[1]!.blob = {
      ...value.functions.app.modules[1]!.blob,
      sha256: '0'.repeat(64),
    };

    expect(scopePackReadersOf(value, approval())).toStrictEqual(proof);
  });

  it('leaves an unknown or self-declaring host on the legacy contract', () => {
    const value = Object.assign(bundle(), { cachePackReaderVersion: 2 });

    expect(scopePackReadersOf(value, undefined)).toBeUndefined();

    const incomplete = approval();
    incomplete.functions = incomplete.functions.slice(0, -1);

    expect(scopePackReadersOf(value, incomplete)).toBeUndefined();
  });

  it('does not carry an old approval over a changed Function module', () => {
    const value = bundle();
    value.functions.app = spec('f');

    expect(scopePackReadersOf(value, approval())).toBeUndefined();
  });

  it('requires independent approval of a native Workflow artifact', () => {
    const value = bundle();
    value.functions.cloudflareWorkflows!['jobs'] = spec('0');

    expect(scopePackReadersOf(value, approval())).toBeUndefined();
  });

  it.each([
    './index.mjs',
    'part/../index.mjs',
    String.raw`part\index.mjs`,
    '/index.mjs',
    'node:fs',
  ])('declines approval for a module override or noncanonical identity %s', (name) => {
    const value = bundle();
    value.functions.app.modules.push({ ...value.functions.app.modules[0]!, name });

    expect(scopePackReadersOf(value, approval())).toBeUndefined();
  });

  it('refuses ambiguous module identity and conflicting approval entries without refusing deployment', () => {
    const value = bundle();
    value.functions.app.modules.push(...value.functions.app.modules);

    expect(scopePackReadersOf(value, approval())).toBeUndefined();

    const duplicate = approval();
    duplicate.functions.push(duplicate.functions[0]!);

    expect(scopePackReadersOf(bundle(), duplicate)).toBeUndefined();
  });
});
