/* eslint-disable unicorn/no-keyword-prefix -- Native registration metadata uses className. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLOUDFLARE_WORKFLOW_BUNDLE_VERSION } from '@stayingupwind/core/bundle';
import { bundleWorker, type LocalStack } from '@stayingupwind/local';
import { describe, expect, it } from 'vitest';

import { ownVersion } from '../../src/manifest.ts';
import { runPreview } from '../../src/preview/command.ts';
import {
  bundleOf,
  CACHE_HOST_SOURCE,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from '../deploy/bundle.ts';
import { projectWith } from '../deploy/project.ts';

const WORKFLOW = `import {WorkflowEntrypoint} from 'cloudflare:workers';
import {kv, workflow} from ${JSON.stringify(fileURLToPath(new URL('../../../sdk/src/named.ts', import.meta.url)))};
const data = kv('DATA');
const nested = workflow('OTHER');
export class UpwindCloudflareWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do('store', async () => {
      await data.put(event.instanceId, event.payload.value);
      await this.env.FILES.put(event.instanceId, event.payload.value);
      await this.env.DB.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT)');
      await this.env.DB.prepare('INSERT OR REPLACE INTO jobs (id,value) VALUES (?,?)').bind(event.instanceId,event.payload.value).run();
    });
    const approval = await step.waitForEvent('approval', {type:'approved', timeout:'1 minute'});
    return step.do('finish', async () => ({
      value: await data.get(event.instanceId),
      file: await (await this.env.FILES.get(event.instanceId)).text(),
      row: await this.env.DB.prepare('SELECT value FROM jobs WHERE id=?').bind(event.instanceId).first('value'),
      approved: approval.payload,
      secret: this.env.CUSTOMER_SECRET,
      nestedId: event.payload.nested ? (await nested.create({params:{value:'nested'}})).id : null,
      platform: ['ARKOR_CACHE_TOKEN','ARKOR_CACHE','ARTIFACTS','EDGE_STATE'].some(name => name in this.env)
    }));
  }
}`;

async function builtProject(): Promise<string> {
  const dir = projectDir();
  projectWith({
    dir,
    adapterVersion: await ownVersion(),
    config: {
      file: undefined,
      deploy: { storage: { DATA: 'kv', FILES: 'r2', DB: 'd1' } },
    },
  });
  const appSource = await bundleWorker(
    fileURLToPath(new URL('../../../local/test/fixtures/workflow-app.ts', import.meta.url)),
  );
  const app = functionOf([
    moduleOf(dir, 'index.mjs', 'esm', `${CACHE_HOST_SOURCE}\n${appSource.script}`),
  ]);
  writeFileSync(path.join(dir, 'jobs.ts'), WORKFLOW);
  const workflowSource = await bundleWorker(path.join(dir, 'jobs.ts'));
  const job = functionOf([moduleOf(dir, 'index.mjs', 'esm', workflowSource.script)]);
  writeBundle(
    dir,
    bundleOf(app, {
      v: CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
      routerReferences: 'one-pass',
      cloudflareWorkflows: [
        { name: 'JOBS', module: 'jobs.ts', className: 'Job' },
        { name: 'OTHER', module: 'jobs.ts', className: 'Job' },
      ],
      functions: { app, cloudflareWorkflows: { JOBS: job, OTHER: job } },
    }),
  );
  writeFileSync(path.join(dir, 'preview.env'), 'CUSTOMER_SECRET=only-local\n');
  return dir;
}

interface Status {
  readonly status: string;
  readonly output?: unknown;
}

async function ask(stack: LocalStack, operation: string, binding = 'JOBS'): Promise<unknown> {
  const url = new URL(operation, stack.url);
  url.searchParams.set('binding', binding);
  url.searchParams.set('id', 'same-id');
  const response = await fetch(url, { method: 'POST' });

  expect(response.status).toBe(200);

  return response.json();
}

async function status(stack: LocalStack, binding = 'JOBS'): Promise<Status> {
  return (await ask(stack, '/status', binding)) as Status;
}

async function endedBeforeServing(running: Promise<number>): Promise<never> {
  await running;
  throw new Error('preview stopped before serving');
}

async function duplicateCreateFails(stack: LocalStack): Promise<void> {
  const duplicate = await fetch(new URL('/create?id=same-id&binding=JOBS', stack.url));

  expect(duplicate.status).toBe(400);
  await expect(duplicate.text()).resolves.toMatch(/already exists/iu);
}

async function batchesAndDeletion(stack: LocalStack): Promise<void> {
  await expect(ask(stack, '/batch', 'OTHER')).resolves.toStrictEqual([{ id: 'legacy-batch' }]);
  await expect(ask(stack, '/batchObject', 'OTHER')).resolves.toStrictEqual({
    created: [{ id: 'object-batch' }],
    errors: [],
  });

  await ask(stack, '/delete', 'OTHER');
  const deleted = await fetch(new URL('/status?id=same-id&binding=OTHER', stack.url));

  expect(deleted.status).toBe(400);
  await expect(deleted.text()).resolves.toContain('instance.not_found');
}

describe('built native Workflows in upwind preview', () => {
  it('runs native controls, steps, events and explicit local stores through the public SDK', async () => {
    const dir = await builtProject();
    const served = Promise.withResolvers<LocalStack>();
    const stopped = Promise.withResolvers<undefined>();
    const running = runPreview(
      {
        projectDir: dir,
        port: 0,
        envFiles: [path.join(dir, 'preview.env')],
        check: false,
        crons: false,
      },
      {
        stopped: stopped.promise,
        serving: (stack) => {
          served.resolve(stack);
        },
      },
    );
    try {
      const stack = await Promise.race([served.promise, endedBeforeServing(running)]);
      const resources = await fetch(new URL('/resources', stack.url));

      await expect(resources.json()).resolves.toStrictEqual({
        names: ['DATA', 'DB', 'FILES', 'JOBS', 'OTHER'],
        unknown: true,
      });
      await expect(ask(stack, '/create')).resolves.toStrictEqual({ id: 'same-id' });
      await expect(ask(stack, '/create', 'OTHER')).resolves.toStrictEqual({ id: 'same-id' });

      await duplicateCreateFails(stack);

      await expect
        .poll(async () => (await status(stack)).status, { timeout: 15_000 })
        .toMatch(/^(running|waiting)$/u);

      await ask(stack, '/pause');

      await expect
        .poll(async () => (await status(stack)).status, { timeout: 15_000 })
        .toBe('paused');

      await ask(stack, '/resume');
      await ask(stack, '/sendEvent');

      await expect
        .poll(async () => (await status(stack)).status, { timeout: 15_000 })
        .toBe('complete');

      const generatedId: unknown = expect.any(String);

      await expect(status(stack)).resolves.toMatchObject({
        output: {
          value: 'same-id',
          file: 'same-id',
          row: 'same-id',
          approved: true,
          secret: 'only-local',
          nestedId: generatedId,
          platform: false,
        },
      });
      await expect
        .poll(async () => (await status(stack, 'OTHER')).status)
        .toMatch(/^(running|waiting)$/u);

      await ask(stack, '/restart');

      await expect
        .poll(async () => (await status(stack)).status, { timeout: 15_000 })
        .toMatch(/^(running|waiting)$/u);

      await ask(stack, '/sendEvent');

      await expect
        .poll(async () => (await status(stack)).status, { timeout: 15_000 })
        .toBe('complete');

      await ask(stack, '/terminate', 'OTHER');

      await expect
        .poll(async () => (await status(stack, 'OTHER')).status, { timeout: 15_000 })
        .toBe('terminated');

      await batchesAndDeletion(stack);
    } finally {
      stopped.resolve(undefined);

      await expect(running).resolves.toBe(0);
    }
  }, 120_000);
});
