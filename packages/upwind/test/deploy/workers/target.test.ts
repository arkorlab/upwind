import { readFileSync } from 'node:fs';
import path from 'node:path';

import { publishDeployment, stageDeployment } from '@stayingupwind/deploy/deploy';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentClient } from '../../../src/deploy/agent-client.ts';
import { appRuntimeOf } from '../../../src/deploy/names.ts';
import { BUNDLE_PATH } from '../../../src/deploy/preflight.ts';
import { remoteTarget, uploadBuildBlobs } from '../../../src/deploy/target.ts';
import { bundleOf, deployableFunction, moduleOf, projectDir, writeBundle } from '../bundle.ts';
import { AGENT_KEY, type RunningStack, runStack } from './stack.ts';

describe('staging and publishing through the deploy agent', () => {
  let stack: RunningStack;

  beforeAll(async () => {
    stack = await runStack();
  }, 60_000);

  afterAll(async () => {
    await stack.dispose();
  });

  it('uploads what the bucket lacks, seeds the scope, and publishes the manifest', async () => {
    const dir = projectDir();
    const robots = moduleOf(dir, 'robots.txt', 'text', 'User-agent: *\n');
    const bundle = bundleOf(deployableFunction(dir), {
      staticFiles: [
        {
          pathname: '/robots.txt',
          blob: { ...robots.blob, contentType: 'text/plain; charset=utf-8' },
          immutable: false,
        },
      ],
    });
    writeBundle(dir, bundle);
    const bundleFile = path.join(dir, BUNDLE_PATH);
    const bundleDir = path.dirname(bundleFile);
    const agent = agentClient({ url: await stack.url('agent'), key: AGENT_KEY });

    await expect(uploadBuildBlobs(agent, bundleDir, bundle)).resolves.toStrictEqual({
      uploaded: 1,
      held: 0,
    });
    await expect(uploadBuildBlobs(agent, bundleDir, bundle)).resolves.toStrictEqual({
      uploaded: 0,
      held: 1,
    });

    const target = remoteTarget(agent, bundleDir);
    const staged = await stageDeployment(target, {
      bundle,
      json: readFileSync(bundleFile, 'utf8'),
      projectId: 'shop',
      runId: 'run_test',
      originHost: 'shop.example.com',
      environment: 'production',
      owner: 'account-1',
      app: appRuntimeOf('shop', bundle),
      recoverySource: await recoveryScriptCspSource(),
      now: () => Date.now(),
    });

    expect(staged.token).toMatch(/^v1\./u);

    const pointer = await publishDeployment(target, staged, {
      policy: DEFAULT_DELIVERY_POLICY,
      now: () => Date.now(),
    });

    expect(pointer.manifestId).toBe(staged.manifestId);
    await expect(target.edgeState.get(`manifest:${staged.manifestId}`)).resolves.toBeDefined();
    await expect(target.bucket.get(`manifests/${staged.manifestId}.json`)).resolves.toBeDefined();
  });

  it('stops a run whose key another run has replaced', async () => {
    const agent = agentClient({ url: await stack.url('agent'), key: 'x'.repeat(48) });

    await expect(remoteTarget(agent, '/nowhere').edgeState.get('manifest:x')).rejects.toThrow(
      /another deploy of the project has started/u,
    );
  });
});
