import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { UPWIND_CLOUDFLARE_WORKFLOWS_ENV } from '@stayingupwind/core/paas';

import { workflow } from '../../sdk/src/named.ts';
import { startLocalResources } from '../src/resources/local.ts';

/** Native local engine smoke test: no credentials, account resources, or Next.js build. */
const project = await mkdtemp(path.join(os.tmpdir(), 'upwind-cloudflare-workflows-'));
const before = process.env[UPWIND_CLOUDFLARE_WORKFLOWS_ENV];
let resources: Awaited<ReturnType<typeof startLocalResources>> | undefined;
try {
  await mkdir(path.join(project, 'node_modules', '@stayingupwind'), { recursive: true });
  await symlink(
    path.resolve(import.meta.dirname, '../../adapter'),
    path.join(project, 'node_modules', '@stayingupwind', 'adapter'),
  );
  await writeFile(
    path.join(project, 'job.ts'),
    `import { WorkflowEntrypoint } from 'cloudflare:workers';
export class Job extends WorkflowEntrypoint {
  async run(event, step) {
    await step.do('store', async () => { await this.env.UPWIND_KV.put('workflow-proof', event.payload.value); });
    const approval = await step.waitForEvent('approval', {type: 'approved', timeout: '1 minute'});
    return step.do('finish', async () => ({value: await this.env.UPWIND_KV.get('workflow-proof'), approved: approval.payload}));
  }
}`,
  );
  process.env[UPWIND_CLOUDFLARE_WORKFLOWS_ENV] = JSON.stringify([
    { name: 'JOBS', module: 'job.ts', className: 'Job' },
  ]);
  resources = await startLocalResources(project, { answersSignals: true });
  const jobs = workflow<{ value: string }>('JOBS');
  assert.ok(jobs, 'local Workflow binding was not published');
  const run = await jobs.create({ params: { value: 'native storage' } });
  assert.equal(typeof run.id, 'string');
  await run.sendEvent({ type: 'approved', payload: true });
  let result = await run.status();
  for (let attempt = 0; attempt < 100 && result.status !== 'complete'; attempt += 1) {
    assert.notEqual(result.status, 'errored', JSON.stringify(result));
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await run.status();
  }
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.output, { value: 'native storage', approved: true });
  assert.ok(resources.watchedFiles?.includes(path.join(project, 'job.ts')));
  console.log('Cloudflare Workflows: native steps, events, storage and scoped SDK passed');
} finally {
  await resources?.dispose();
  if (before === undefined) Reflect.deleteProperty(process.env, UPWIND_CLOUDFLARE_WORKFLOWS_ENV);
  else process.env[UPWIND_CLOUDFLARE_WORKFLOWS_ENV] = before;
  await rm(project, { recursive: true, force: true });
}
