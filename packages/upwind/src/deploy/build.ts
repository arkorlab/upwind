import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEPLOYMENT_ID_PREFIX } from '@stayingupwind/core/bundle';
import {
  UPWIND_CACHE_HOST_MODULE_ENV,
  UPWIND_UNSHIPPED_OUTPUTS_ENV,
} from '@stayingupwind/core/paas';
import { createId } from '@stayingupwind/core/util';

import { spawnBuild } from '../build/run.ts';
import { ADAPTER_PACKAGE, resolveAdapterPath } from '../dev/adapter.ts';
import { ownVersion } from '../manifest.ts';
import { cacheHostModuleFor } from './cache-host.ts';
import { BUNDLE_PATH } from './preflight.ts';
import { shippedCacheHost } from './shipped.ts';

/**
 * A build for a deploy: `upwind build`, with the deployment's id chosen here and the build told it.
 *
 * The id is chosen before the build because the build writes it into what it builds: every asset
 * URL carries `?dpl=`, which is how a page of one deployment keeps loading its own files while the
 * next is live. A build that minted its own would warn that its assets carry no id, and a deploy
 * would have to read back what the build chose.
 *
 * And every Function is built with the runtime cache's host in it (`cache-host.ts`), named to the
 * adapter through the environment, since the project's `next.config` names the adapter itself; the
 * build leaves its prefetch segments out of the Functions, for the edge to answer from the bucket.
 *
 * What the build leaves beside the bundle — the deploy's own note, `upwind-deploy.json` — says that
 * it was built this way, for which deployment and by which version of this command. `--prebuilt`
 * deploys a bundle only with that note beside it: a bundle `upwind build` wrote for some other host,
 * or one of an older run, is not one this command can vouch was built for it.
 */

const SIDECAR_FILE = 'upwind-deploy.json';
const SIDECAR_VERSION = 1;

/** What a build for a deploy notes beside its bundle. */
export interface BuildNote {
  readonly v: typeof SIDECAR_VERSION;
  readonly deploymentId: string;
  /** The version of this command that built it. */
  readonly upwind: string;
  readonly builtAt: string;
}

function notePath(projectDir: string): string {
  return path.join(path.dirname(path.join(projectDir, BUNDLE_PATH)), SIDECAR_FILE);
}

/** The note a build for a deploy left, or nothing where none did. */
export async function readBuildNote(projectDir: string): Promise<BuildNote | undefined> {
  let raw: string;
  try {
    raw = await readFile(notePath(projectDir), 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'v' in parsed &&
    parsed.v === SIDECAR_VERSION &&
    'deploymentId' in parsed &&
    typeof parsed.deploymentId === 'string' &&
    'upwind' in parsed &&
    typeof parsed.upwind === 'string' &&
    'builtAt' in parsed &&
    typeof parsed.builtAt === 'string'
  ) {
    return {
      v: SIDECAR_VERSION,
      deploymentId: parsed.deploymentId,
      upwind: parsed.upwind,
      builtAt: parsed.builtAt,
    };
  }
  return undefined;
}

/** The deployment the bundle in the project was built for, or nothing where there is none. */
async function bundledDeployment(projectDir: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(projectDir, BUNDLE_PATH), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const id: unknown =
      typeof parsed === 'object' && parsed !== null
        ? Reflect.get(parsed, 'deploymentId')
        : undefined;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the project for a deployment and note it. The build's own exit code where it failed, the
 * deployment's id where it did not.
 *
 * A build that exits 0 has built this deployment only if the bundle it leaves says so: an adapter
 * other than upwind's writes no bundle, and leaves whatever an earlier build wrote there. So the
 * bundle is read back before the note vouches for it.
 */
export async function buildForDeploy(
  projectDir: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ readonly deploymentId: string } | { readonly exitCode: number }> {
  const adapter = resolveAdapterPath(projectDir);
  if (adapter === undefined) {
    throw new Error(`${ADAPTER_PACKAGE} is not installed in ${projectDir}; install it`);
  }
  const cacheHost = await cacheHostModuleFor(await shippedCacheHost(), projectDir, adapter);
  const deploymentId = createId(DEPLOYMENT_ID_PREFIX);
  const exitCode = await spawnBuild(
    { projectDir },
    {
      forDeploy: true,
      extraEnv: {
        ...extraEnv,
        NEXT_DEPLOYMENT_ID: deploymentId,
        [UPWIND_CACHE_HOST_MODULE_ENV]: cacheHost,
        [UPWIND_UNSHIPPED_OUTPUTS_ENV]: 'prefetch-segments',
      },
    },
  );
  if (exitCode !== 0) {
    return { exitCode };
  }
  const bundled = await bundledDeployment(projectDir);
  if (bundled !== deploymentId) {
    const found = bundled === undefined ? 'not there' : `${bundled}'s`;
    console.error(
      `upwind: the build finished, and ${BUNDLE_PATH} is ${found}, not ${deploymentId}'s: the project's next.config has to name ${ADAPTER_PACKAGE}, or an adapter that writes its bundle`,
    );
    return { exitCode: 1 };
  }
  const note: BuildNote = {
    v: SIDECAR_VERSION,
    deploymentId,
    upwind: (await ownVersion()) ?? 'unknown',
    builtAt: new Date().toISOString(),
  };
  await writeFile(notePath(projectDir), `${JSON.stringify(note, undefined, 2)}\n`);
  return { deploymentId };
}
