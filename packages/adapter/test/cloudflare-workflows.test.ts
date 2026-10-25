/* eslint-disable unicorn/no-keyword-prefix -- Matches the host registration className field. */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
  CLOUDFLARE_WORKFLOW_EXPORT,
  CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION,
} from '@stayingupwind/core/bundle';
import { afterEach, describe, expect, it } from 'vitest';

import { BlobStore } from '../src/blobs.ts';
import {
  bundleCloudflareWorkflows,
  buildCloudflareWorkflowFunctions,
  cloudflareWorkflowParts,
} from '../src/cloudflare-workflows.ts';

const folders: string[] = [];
const execFile = promisify(execFileCallback);

async function fixture() {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'upwind-workflows-'));
  folders.push(projectDir);
  await writeFile(
    path.join(projectDir, 'job.ts'),
    "import {WorkflowEntrypoint} from 'cloudflare:workers'; export class Job extends WorkflowEntrypoint {async run(event,step){return step.do('greet',()=>event.payload);}}\n",
  );
  return {
    projectDir,
    outDir: path.join(projectDir, 'output'),
    declarations: [{ name: 'JOBS', module: 'job.ts', className: 'Job', definitionRevision: 3 }],
  };
}

describe('framework-independent Cloudflare Workflow artifacts', () => {
  afterEach(async () => {
    await Promise.all(
      folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
    );
  });

  it('builds through the public adapter entry without loading Next.js', async () => {
    const input = await fixture();
    const { stdout } = await execFile(process.execPath, [
      '--input-type=module',
      '--eval',
      `
        import { registerHooks } from 'node:module';
        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === 'next' || specifier.startsWith('next/')) {
              throw new Error('Native Workflow builds must not load Next.js');
            }
            return nextResolve(specifier, context);
          },
        });
        const { buildCloudflareWorkflowFunctions } = await import(process.argv[1]);
        const built = await buildCloudflareWorkflowFunctions({
          projectDir: process.argv[2],
          outDir: process.argv[3],
          declarations: JSON.parse(process.argv[4]),
        });
        console.log(Object.keys(built.functions).join(','));
      `,
      new URL('../src/index.ts', import.meta.url).href,
      input.projectDir,
      input.outDir,
      JSON.stringify(input.declarations),
    ]);

    expect(stdout.trim()).toBe('JOBS');
  });

  it('bundles the native class independently from application code and packages its maps and dependency report', async () => {
    const input = await fixture();
    const result = await buildCloudflareWorkflowFunctions({ ...input, sourceMaps: 'project' });
    const fn = result.functions['JOBS'];

    expect(fn).toBeDefined();
    expect(result.declarations).toStrictEqual(input.declarations);
    expect(fn?.mainModule).toBe('cloudflare-workflow.mjs');

    const source = await readFile(
      path.join(input.outDir, 'blobs', fn!.modules[0]!.blob.sha256),
      'utf8',
    );

    expect(source).toContain(CLOUDFLARE_WORKFLOW_EXPORT);
    expect(source).not.toContain('next/');
    expect(result.sourceMaps[0]?.name).toBe('cloudflare-workflow/JOBS/cloudflare-workflow.mjs');
    expect(result.dependencies['cloudflare-workflow/JOBS']?.externals).toContain(
      'cloudflare:workers',
    );
  });

  it('chooses versioned Workflow bundles only when registrations exist', async () => {
    const input = await fixture();
    const blobs = new BlobStore(input.outDir);
    await blobs.init();

    expect((await cloudflareWorkflowParts({ ...input, blobs, split: false })).bundle.v).toBe(
      CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
    );
    expect((await cloudflareWorkflowParts({ ...input, blobs, split: true })).bundle.v).toBe(
      CLOUDFLARE_WORKFLOW_SPLIT_BUNDLE_VERSION,
    );
    await expect(
      cloudflareWorkflowParts({ ...input, blobs, declarations: [], split: false }),
    ).resolves.toStrictEqual({ bundle: {}, functions: {}, sourceMaps: [], dependencies: {} });
  });

  it('rejects duplicate names, unresolved imports, absent classes, and symlinks outside the project', async () => {
    const input = await fixture();
    const definition = input.declarations[0]!;

    await expect(
      bundleCloudflareWorkflows(input.projectDir, [definition, definition]),
    ).rejects.toThrow('unique');
    await expect(
      bundleCloudflareWorkflows(input.projectDir, [{ ...definition, className: 'Absent' }]),
    ).rejects.toThrow('Absent');

    await writeFile(
      path.join(input.projectDir, 'job.ts'),
      "import missing from 'missing-workflow-dependency'; export const Job=missing;",
    );

    await expect(bundleCloudflareWorkflows(input.projectDir, [definition])).rejects.toThrow(
      'cannot be resolved',
    );

    const outside = await mkdtemp(path.join(os.tmpdir(), 'upwind-workflows-outside-'));
    folders.push(outside);
    await mkdir(path.join(input.projectDir, 'nested'));
    await writeFile(path.join(outside, 'job.ts'), 'export class Job {}');
    await symlink(path.join(outside, 'job.ts'), path.join(input.projectDir, 'nested', 'link.ts'));

    await expect(
      bundleCloudflareWorkflows(input.projectDir, [{ ...definition, module: 'nested/link.ts' }]),
    ).rejects.toThrow('inside the project');
  });
});
