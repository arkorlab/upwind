/* eslint-disable unicorn/no-keyword-prefix -- Native registration metadata uses className. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FunctionSpec } from '@stayingupwind/core/bundle';
import { afterEach, describe, expect, it } from 'vitest';

import { deploymentFunctions } from '../src/functions.ts';
import { runWorkers } from '../src/miniflare.ts';

const dirs: string[] = [];
const definition = { name: 'JOBS', module: 'jobs.ts', className: 'Jobs' };

function fixture(source = 'export class UpwindCloudflareWorkflow {}'): {
  dir: string;
  spec: FunctionSpec;
  sha256: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'upwind-preview-workflow-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'blobs'));
  const bytes = Buffer.from(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(path.join(dir, 'blobs', sha256), bytes);
  return {
    dir,
    sha256,
    spec: {
      mainModule: 'index.mjs',
      modules: [
        {
          name: 'index.mjs',
          type: 'esm',
          blob: { sha256, byteLength: bytes.length, contentType: 'text/javascript' },
        },
      ],
      compatibilityDate: '2026-09-15',
      compatibilityFlags: ['nodejs_compat'],
    },
  };
}

describe('built native Workflow capabilities in a preview', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps platform authority out of classes and merges customer resources into app bindings', () => {
    const { dir, spec } = fixture();
    const result = deploymentFunctions(
      dir,
      {
        deploymentId: 'dpl_preview',
        cloudflareWorkflows: [definition],
        functions: { app: spec, cloudflareWorkflows: { JOBS: spec } },
      },
      {
        text: [
          { name: 'ARKOR_CACHE_TOKEN', value: 'private', secret: true },
          {
            name: 'ARKOR_RESOURCES',
            value: '[{"name":"DATA","type":"kv_namespace"}]',
            secret: false,
          },
        ],
        workflowText: [{ name: 'CUSTOMER_SECRET', value: 'customer', secret: true }],
        services: [{ name: 'ARKOR_CACHE', service: 'cache' }],
        stores: { kvNamespaces: { DATA: 'local-data' } },
      },
    );

    expect(result.workers).toHaveLength(1);
    expect(result.workers[0]?.services).toMatchObject({
      JOBS: { name: 'upwind-workflow-bridge-JOBS', entrypoint: 'WorkflowBridge' },
      ARKOR_CACHE: 'cache',
    });
    expect(JSON.parse(result.workers[0]?.bindings?.['ARKOR_RESOURCES'] ?? 'null')).toStrictEqual([
      { name: 'DATA', type: 'kv_namespace' },
      { name: 'JOBS', type: 'workflow' },
    ]);
    expect(result.backgroundWorkers).toHaveLength(2);
    expect(result.backgroundWorkers?.[0]).toMatchObject({
      bindings: { CUSTOMER_SECRET: 'customer' },
      services: {},
      kvNamespaces: { DATA: 'local-data' },
      workflows: { JOBS: { scriptName: 'upwind-workflow-JOBS' } },
    });
    expect(result.backgroundWorkers?.[0]?.bindings).not.toHaveProperty('ARKOR_CACHE_TOKEN');
    expect(result.backgroundWorkers?.[1]).toMatchObject({
      workflows: { WORKFLOW: { scriptName: 'upwind-workflow-JOBS' } },
    });
    expect(result.backgroundWorkers?.[1]?.bindings).toBeUndefined();
  });

  it('rejects a Workflow name that shadows an existing resource or customer variable', () => {
    const { dir, spec } = fixture();
    const bundle = {
      deploymentId: 'dpl_preview',
      cloudflareWorkflows: [definition],
      functions: { app: spec, cloudflareWorkflows: { JOBS: spec } },
    };

    expect(() => {
      return deploymentFunctions(dir, bundle, {
        text: [{ name: 'JOBS', value: 'shadow', secret: false }],
        services: [],
      });
    }).toThrow('name is already taken');
    expect(() => {
      return deploymentFunctions(dir, bundle, {
        text: [],
        services: [],
        stores: { kvNamespaces: { JOBS: 'other' } },
      });
    }).toThrow('name is already taken');
  });

  it('verifies the built artifact bytes and main module before starting a Worker', () => {
    const { dir, spec, sha256 } = fixture();
    const bundle = {
      deploymentId: 'dpl_preview',
      cloudflareWorkflows: [definition],
      functions: {
        app: spec,
        cloudflareWorkflows: { JOBS: { ...spec, mainModule: 'missing.mjs' } },
      },
    };

    expect(() => deploymentFunctions(dir, bundle, { text: [], services: [] })).toThrow(
      'main module missing.mjs is none',
    );

    writeFileSync(path.join(dir, 'blobs', sha256), 'tampered');

    expect(() => {
      return deploymentFunctions(
        dir,
        { ...bundle, functions: { app: spec, cloudflareWorkflows: { JOBS: spec } } },
        { text: [], services: [] },
      );
    }).toThrow('is not the blob its bundle names');
  });

  it('refuses a class artifact without the normalized Workflow export', async () => {
    const { dir, spec } = fixture(
      "import {WorkflowEntrypoint} from 'cloudflare:workers';export class Wrong extends WorkflowEntrypoint {async run(){return null;}}",
    );
    const result = deploymentFunctions(
      dir,
      {
        deploymentId: 'dpl_preview',
        cloudflareWorkflows: [definition],
        functions: { app: spec, cloudflareWorkflows: { JOBS: spec } },
      },
      { text: [], services: [] },
    );

    await expect(
      runWorkers(result.backgroundWorkers ?? [], () => {
        /* No fixture logs are needed. */
      }),
    ).rejects.toThrow(/Workers runtime/iu);
  }, 30_000);

  it('rejects customer artifacts that shadow the preview resource bootstrap', () => {
    const { dir, spec } = fixture();
    const reserved = '__upwind_preview_resources.mjs';
    const job = {
      ...spec,
      mainModule: reserved,
      modules: spec.modules.map((module) => ({ ...module, name: reserved })),
    };

    expect(() => {
      return deploymentFunctions(
        dir,
        {
          deploymentId: 'dpl_preview',
          cloudflareWorkflows: [definition],
          functions: { app: spec, cloudflareWorkflows: { JOBS: job } },
        },
        { text: [], services: [] },
      );
    }).toThrow('reserved local preview module name');
  });
});
