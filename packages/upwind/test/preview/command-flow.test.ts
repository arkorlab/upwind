import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
  type DeploymentBundle,
} from '@stayingupwind/core/bundle';
import type { CheckResult, LocalStack, StackOptions } from '@stayingupwind/local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUNDLE_PATH } from '../../src/deploy/preflight.ts';
import { ownVersion } from '../../src/manifest.ts';
import type { PreviewOptions } from '../../src/preview/args.ts';
import type { CheckOptions } from '../../src/preview/checks.ts';
import { runPreview } from '../../src/preview/command.ts';
import {
  bundleOf,
  deployableFunction,
  functionOf,
  moduleOf,
  projectDir,
  writeBundle,
} from '../deploy/bundle.ts';
import { projectWith } from '../deploy/project.ts';

/**
 * What `upwind preview` makes of a project around the stack, with the stack itself stood in for:
 * what it is started with, what it warns of, and what a check exits with.
 */

const local = vi.hoisted(() => {
  return {
    started: [] as StackOptions[],
    check: (): Promise<CheckResult> => Promise.resolve({ checked: 3, failures: [], skipped: [] }),
    disposed: 0,
  };
});

/**
 * The paths of `deploy.checks`, as asked: failing as the test says, or — `held` — answered only once
 * the asking is stopped, which is then noted.
 */
const paths = vi.hoisted(() => ({ failures: [] as string[], held: false, stopped: false }));

vi.mock(import('@stayingupwind/local'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    startStack: (options: StackOptions) => {
      local.started.push(options);
      return Promise.resolve({
        url: new URL('http://localhost:3000/'),
        deploymentId: 'dpl_previewed',
        dispose: () => {
          local.disposed += 1;
          return Promise.resolve();
        },
      } as unknown as LocalStack);
    },
    checkStack: () => local.check(),
  };
});

vi.mock(import('../../src/preview/checks.ts'), () => {
  return {
    failedChecks: (_site: URL, _asked: readonly string[], options?: CheckOptions) => {
      if (!paths.held) {
        return Promise.resolve(paths.failures);
      }
      return new Promise<string[]>((resolve) => {
        options?.signal?.addEventListener('abort', () => {
          paths.stopped = true;
          resolve([]);
        });
      });
    },
  };
});

/** A project configured as the test says, with a build of one Function; or of what the test changes. */
async function project(
  config: unknown,
  build: { readonly cacheHost?: boolean; readonly bundle?: Partial<DeploymentBundle> } = {},
): Promise<string> {
  const dir = projectDir();
  projectWith({ dir, adapterVersion: await ownVersion(), config });
  const app =
    build.cacheHost === false
      ? functionOf([moduleOf(dir, 'index.mjs', 'esm', 'export default {};')])
      : deployableFunction(dir);
  writeBundle(dir, bundleOf(app, build.bundle));
  return dir;
}

function checking(dir: string, envFiles: readonly string[] = []): PreviewOptions {
  return { projectDir: dir, port: 0, envFiles, check: true };
}

describe('a preview around its stack', () => {
  let out: string[];
  /** What a console method prints, kept with the method's name. */
  const kept = (method: string) => {
    return (text: string): void => {
      out.push(`${method}: ${text}`);
    };
  };

  beforeEach(() => {
    local.started = [];
    local.disposed = 0;
    local.check = () => Promise.resolve({ checked: 3, failures: [], skipped: [] });
    paths.failures = [];
    paths.held = false;
    paths.stopped = false;
    out = [];
    vi.spyOn(console, 'log').mockImplementation(kept('log'));
    vi.spyOn(console, 'warn').mockImplementation(kept('warn'));
    vi.spyOn(console, 'error').mockImplementation(kept('error'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the stack as the project's deploy section has it deployed", async () => {
    const dir = await project({
      file: undefined,
      deploy: {
        secrets: ['FROM_ENV'],
        hostnames: ['shop.example.com'],
        cspNonce: { mode: 'report-only' },
      },
    });
    const envFile = path.join(dir, 'preview.env');
    writeFileSync(envFile, 'FROM_FILE=file\n');
    vi.stubEnv('FROM_ENV', 'environment');

    await expect(runPreview(checking(dir, [envFile]))).resolves.toBe(0);

    expect(local.started).toHaveLength(1);
    expect(local.started[0]).toMatchObject({
      bundleDir: path.dirname(path.join(dir, BUNDLE_PATH)),
      port: 0,
      env: { FROM_FILE: 'file', FROM_ENV: 'environment' },
      hostnames: ['shop.example.com'],
      cspNonce: { mode: 'report-only', strictDynamic: false },
      // From this repository's sources: the stack bundles its own.
      scripts: undefined,
    });
    // A check leaves the signals to Miniflare: one stopped part way ends as a failure.
    expect(local.started[0]?.signals).toBeUndefined();
    expect(local.disposed).toBe(1);

    vi.unstubAllEnvs();
  });

  it('warns of what it serves otherwise than a deployment would', async () => {
    const dir = await project(
      { file: undefined, deploy: { storage: { UPWIND_D1: 'd1' }, images: true } },
      { cacheHost: false, bundle: { crons: [{ path: '/tick', schedule: '* * * * *' }] } },
    );
    const envFile = path.join(dir, 'preview.env');
    writeFileSync(envFile, 'PORT=1234\n');

    await expect(runPreview(checking(dir, [envFile]))).resolves.toBe(0);

    const warned = out.filter((line) => line.startsWith('warn: ')).join('\n');

    expect(warned).toMatch(/the app Function was built without the runtime cache's host/u);
    expect(warned).toMatch(/deploy.storage names UPWIND_D1, and a preview binds no storage yet/u);
    expect(warned).toMatch(/declares cron jobs, and a preview fires none of them/u);
    expect(warned).toMatch(/deploy.images is set, and a preview transforms no image/u);
    expect(warned).toMatch(/PORT is among the secrets/u);
    expect(local.started[0]?.storage).toBeUndefined();
  });

  it('shares explicit local store kinds with a built native Workflow preview', async () => {
    const dir = await project({
      file: undefined,
      deploy: { storage: { DATA: 'kv', DB: 'd1', FILES: 'r2' } },
    });
    const app = deployableFunction(dir);
    writeBundle(
      dir,
      bundleOf(app, {
        v: CLOUDFLARE_WORKFLOW_BUNDLE_VERSION,
        routerReferences: 'one-pass',
        // eslint-disable-next-line unicorn/no-keyword-prefix -- Native registration metadata uses className.
        cloudflareWorkflows: [{ name: 'JOBS', module: 'jobs.ts', className: 'Jobs' }],
        functions: { app, cloudflareWorkflows: { JOBS: app } },
      }),
    );

    await expect(runPreview(checking(dir))).resolves.toBe(0);

    expect(local.started[0]?.storage).toStrictEqual({ kv: ['DATA'], d1: ['DB'], r2: ['FILES'] });
    expect(out.join('\n')).not.toMatch(/preview binds no storage/u);
  });

  it('refuses a secret a deploy would refuse, before any stack starts', async () => {
    const dir = await project({ file: undefined, deploy: { secrets: ['MISSING'] } });

    await expect(runPreview(checking(dir))).rejects.toThrow(/MISSING/u);
    expect(local.started).toHaveLength(0);
  });

  it('ends a passing check with 0, and says how much it asked', async () => {
    const dir = await project({ file: undefined });

    await expect(runPreview(checking(dir))).resolves.toBe(0);
    expect(out).toContain(
      'log: upwind: dpl_previewed: 3 of 3 answered as deployed; 1 of 1 deploy.checks answered',
    );
  });

  it('ends with 1 where a route answers otherwise than deployed', async () => {
    local.check = () => {
      return Promise.resolve({
        checked: 3,
        failures: [{ path: '/blog', reason: 'answered 500' }],
        skipped: [],
      });
    };
    const dir = await project({ file: undefined });

    await expect(runPreview(checking(dir))).resolves.toBe(1);
    expect(out).toContain('error: upwind: /blog: answered 500');
  });

  it('ends with 1 where a path of deploy.checks fails, as a deploy would not switch to it', async () => {
    paths.failures = ['/ was answered with 502'];
    const dir = await project({ file: undefined });

    await expect(runPreview(checking(dir))).resolves.toBe(1);
    expect(out).toContain('error: upwind: / was answered with 502');
  });

  it('stops serving without waiting on a path of deploy.checks still asked', async () => {
    paths.held = true;
    const dir = await project({ file: undefined });
    const { promise: served, resolve } = Promise.withResolvers<undefined>();

    await expect(
      runPreview(
        { projectDir: dir, port: 0, envFiles: [], check: false },
        {
          stopped: served,
          serving: () => {
            resolve(undefined);
          },
        },
      ),
    ).resolves.toBe(0);
    expect(paths.stopped).toBe(true);
    expect(local.disposed).toBe(1);
  });

  it('ends with 1, and lets the stack go, where the check cannot finish', async () => {
    local.check = () => Promise.reject(new Error('the backstage went away'));
    const dir = await project({ file: undefined });

    await expect(runPreview(checking(dir))).resolves.toBe(1);
    expect(out.join('\n')).toMatch(/the check could not finish: the backstage went away/u);
    expect(local.disposed).toBe(1);
  });
});
