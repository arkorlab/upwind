import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';

/**
 * Where a build's bundle is: `.arkor/` beside the project the adapter built, which is the application
 * itself, or, in a workspace whose build script builds one of its packages, that package.
 */

const BUNDLE_DIRECTORY = '.arkor';
const BUNDLE_FILE = 'bundle.json';
const BLOBS_DIRECTORY = 'blobs';
/** How far below the application a workspace package is looked for: `apps/web`, `packages/a/b`. */
const WORKSPACE_DEPTH = 3;
const DEPENDENCIES = 'node_modules';

export function bundleFile(projectDir: string): string {
  return path.join(projectDir, BUNDLE_DIRECTORY, BUNDLE_FILE);
}

export function blobFile(projectDir: string, sha256: string): string {
  return path.join(projectDir, BUNDLE_DIRECTORY, BLOBS_DIRECTORY, sha256);
}

export async function readBundle(projectDir: string): Promise<DeploymentBundle> {
  const json = await readFile(bundleFile(projectDir), 'utf8');
  return deploymentBundleSchema.parse(JSON.parse(json));
}

/**
 * The project the build wrote its bundle beside: the application, or the one package of it whose
 * build its build script ran (`pnpm run --dir apps/web build`, which is what
 * `import-meta-glob-monorepo` does). The deploy hook names the deployment before the build
 * (`NEXT_DEPLOYMENT_ID`) and the adapter writes that id into the bundle, so a bundle that names
 * another — left by an earlier build, checked in, copied — is no candidate. One, or refused: a build
 * that left a bundle in two places — the application and a package, two packages, a package and one
 * nested in it — leaves two, and which of them is this deployment would be a guess.
 */
export async function bundleProject(
  appDir: string,
  deploymentId: string | undefined = process.env['NEXT_DEPLOYMENT_ID'],
): Promise<string> {
  const candidates = [
    ...((await isFile(bundleFile(appDir))) ? [appDir] : []),
    ...(await bundlesBelow(appDir, WORKSPACE_DEPTH)),
  ];
  const named = await Promise.all(
    candidates.map(async (dir) => ({ dir, id: await deploymentOf(dir) })),
  );
  const found = named
    .filter(({ id }) => deploymentId === undefined || id === deploymentId)
    .map(({ dir }) => dir);
  const [only, ...others] = found;
  if (only !== undefined && others.length === 0) {
    return only;
  }
  const where = (dirs: readonly string[]): string =>
    dirs.map((dir) => path.relative(appDir, dir) || '.').join(', ');
  if (only === undefined) {
    const of = deploymentId === undefined ? '' : ` for ${deploymentId}`;
    const elsewhere =
      candidates.length === 0 ? '' : ` (found: ${where(candidates)}, each of another deployment)`;
    throw new Error(
      `the build wrote no bundle${of}: no ${path.join(BUNDLE_DIRECTORY, BUNDLE_FILE)} in ${appDir} or in a package of it${elsewhere}`,
    );
  }
  throw new Error(
    `the build left a bundle in more than one place (${where(found)}), and which is this deployment would be a guess`,
  );
}

/** The deployment a bundle says it is; `undefined` for one that does not read as a bundle at all. */
async function deploymentOf(projectDir: string): Promise<string | undefined> {
  try {
    const { deploymentId } = JSON.parse(await readFile(bundleFile(projectDir), 'utf8')) as {
      deploymentId?: unknown;
    };
    return typeof deploymentId === 'string' ? deploymentId : undefined;
  } catch {
    return undefined;
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The packages below `directory` that hold a bundle, `depth` levels down at most. */
async function bundlesBelow(directory: string, depth: number): Promise<string[]> {
  if (depth === 0) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const below = await Promise.all(
    entries
      // Dependencies hold no build of the application's, and a dot directory — `.arkor` itself,
      // `.git`, `.next` — no package of it.
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name !== DEPENDENCIES && !entry.name.startsWith('.'),
      )
      .map(async (entry) => {
        const dir = path.join(directory, entry.name);
        // On down past a bundle, too: one nested in a package is a second candidate, not none.
        const nested = await bundlesBelow(dir, depth - 1);
        return (await isFile(bundleFile(dir))) ? [dir, ...nested] : nested;
      }),
  );
  return below.flat();
}
