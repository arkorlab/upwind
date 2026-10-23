import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bundleWorker } from '@stayingupwind/local';

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
const HOST_EXTERNALS = [/^@stayingupwind\/(?:core|runtime)(?:\/|$)/u];

async function bundleCacheHost(): Promise<string> {
  const worker = await bundleWorker(cacheHostEntry(), {
    platform: 'neutral',
    external: HOST_EXTERNALS,
  });
  assertUpwindOnly(worker.entry, worker.inputs, worker.root);
  return worker.script;
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
