import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';

import {
  assertUpwindOnly,
  bundleWorkers,
  cacheHostEntry,
  SHIPPED_MANIFEST_FILE,
  type ShippedManifest,
  sha256Of,
  WORKER_ROLES,
} from '../src/deploy/shipped.ts';

/**
 * The code `upwind deploy` ships beside the command, in `dist/shipped/`: the five Workers of a
 * project's own, bundled as `wrangler deploy` bundles one, and the runtime cache's Function host,
 * with a manifest of their digests (`src/deploy/shipped.ts` says why they are shipped built).
 *
 * The host is bundled differently from the Workers. It is not a Worker but a module a project's
 * build bundles into each of its Functions, so it leaves the runtime and the core out, for the build
 * to resolve to the project's own (`src/deploy/cache-host.ts`), along with the runtime's built-ins.
 */

const CACHE_HOST_FILE = 'cache-host.mjs';

/** What the host leaves for the build that bundles it to resolve. */
const HOST_EXTERNALS = [
  '@stayingupwind/core',
  '@stayingupwind/core/*',
  '@stayingupwind/runtime',
  '@stayingupwind/runtime/*',
  'cloudflare:*',
  'node:*',
];

async function bundleCacheHost(): Promise<string> {
  const entry = cacheHostEntry();
  const root = path.dirname(entry);
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2024',
    conditions: ['workerd', 'worker', 'browser'],
    external: HOST_EXTERNALS,
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }
  assertUpwindOnly(entry, Object.keys(result.metafile.inputs), root);
  return output.text;
}

/** Bundle everything into `dir`, and say what was written. */
export async function writeShipped(dir: string): Promise<ShippedManifest> {
  await mkdir(dir, { recursive: true });
  const [workers, cacheHost] = await Promise.all([bundleWorkers(), bundleCacheHost()]);
  const entries = await Promise.all(
    WORKER_ROLES.map(async (role) => {
      const file = `${role}.mjs`;
      await writeFile(path.join(dir, file), workers[role].script);
      return [role, { file, sha256: workers[role].sha256 }] as const;
    }),
  );
  await writeFile(path.join(dir, CACHE_HOST_FILE), cacheHost);
  const manifest: ShippedManifest = {
    workers: Object.fromEntries(entries) as ShippedManifest['workers'],
    cacheHost: { file: CACHE_HOST_FILE, sha256: sha256Of(cacheHost) },
  };
  await writeFile(
    path.join(dir, SHIPPED_MANIFEST_FILE),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  return manifest;
}
