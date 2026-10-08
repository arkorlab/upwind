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
 * `import-meta-glob-monorepo` does). One, or refused: a workspace whose build left a bundle in two
 * packages leaves two, and which of them is this deployment would be a guess.
 */
export async function bundleProject(appDir: string): Promise<string> {
  if (await isFile(bundleFile(appDir))) {
    return appDir;
  }
  const found = await bundlesBelow(appDir, WORKSPACE_DEPTH);
  const [only, ...others] = found;
  if (only !== undefined && others.length === 0) {
    return only;
  }
  if (only === undefined) {
    throw new Error(
      `the build wrote no bundle: no ${path.join(BUNDLE_DIRECTORY, BUNDLE_FILE)} in ${appDir} or in a package of it`,
    );
  }
  const named = found.map((dir) => path.relative(appDir, dir)).join(', ');
  throw new Error(
    `the build left a bundle in more than one package (${named}), and which is this deployment would be a guess`,
  );
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
        return (await isFile(bundleFile(dir))) ? [dir] : bundlesBelow(dir, depth - 1);
      }),
  );
  return below.flat();
}
