import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bundleStackScripts, bundleWorker } from '@stayingupwind/local';

import {
  assertUpwindOnly,
  bundleWorkers,
  cacheHostEntry,
  PREVIEW_ROLES,
  type PreviewRole,
  SHIPPED_MANIFEST_FILE,
  type ShippedFile,
  type ShippedManifest,
  sha256Of,
  WORKER_ROLES,
  type WorkerRole,
} from '../src/deploy/shipped.ts';

/**
 * The code `upwind deploy` and `upwind preview` ship beside the command, in `dist/shipped/`: the
 * five Workers a deploy puts on an account of a project's own, bundled as `wrangler deploy` bundles
 * one; the three of its own the stack of a preview runs beside the cache's; and the runtime cache's
 * Function host — with a manifest of their digests (`src/deploy/shipped.ts` says why they are
 * shipped built).
 *
 * The host is bundled differently from the Workers. It is not a Worker but a module a project's
 * build bundles into each of its Functions, so it leaves the runtime and the core out, for the build
 * to resolve to the project's own (`src/deploy/cache-host.ts`), along with the runtime's built-ins.
 */

const CACHE_HOST_FILE = 'cache-host.mjs';

/** What the host leaves for the build that bundles it to resolve. */
const HOST_EXTERNALS = [/^@stayingupwind\/(?:core|runtime)(?:\/|$)/u];

/** The stack's names for the cache's three Workers, which a preview runs as the deploy ships them. */
const STACK_CACHE_WORKERS = [
  ['cache', 'cache'],
  ['cache-read', 'cacheRead'],
  ['prefetch', 'prefetch'],
] as const;

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
  const [workers, cacheHost, stack] = await Promise.all([
    bundleWorkers(),
    bundleCacheHost(),
    bundleStackScripts(),
  ]);
  // A preview runs the cache's three as a deploy ships them, so the stack's own bundle of each has
  // to be those same bytes: a preview of other code would say nothing of what a deploy runs.
  for (const [role, name] of STACK_CACHE_WORKERS) {
    if (sha256Of(stack[name]) !== workers[role].sha256) {
      throw new Error(
        `the stack's ${role} Worker is not the one a deploy ships; bundle both alike`,
      );
    }
  }
  const entries = await Promise.all(
    WORKER_ROLES.map(async (role): Promise<readonly [WorkerRole, ShippedFile]> => {
      const file = `${role}.mjs`;
      await writeFile(path.join(dir, file), workers[role].script);
      return [role, { file, sha256: workers[role].sha256 }];
    }),
  );
  const preview = await Promise.all(
    PREVIEW_ROLES.map(async (role): Promise<readonly [PreviewRole, ShippedFile]> => {
      const file = `preview-${role}.mjs`;
      const script = stack[role];
      await writeFile(path.join(dir, file), script);
      return [role, { file, sha256: sha256Of(script) }];
    }),
  );
  await writeFile(path.join(dir, CACHE_HOST_FILE), cacheHost);
  const manifest: ShippedManifest = {
    workers: Object.fromEntries(entries) as ShippedManifest['workers'],
    cacheHost: { file: CACHE_HOST_FILE, sha256: sha256Of(cacheHost) },
    preview: Object.fromEntries(preview) as Record<PreviewRole, ShippedFile>,
  };
  await writeFile(
    path.join(dir, SHIPPED_MANIFEST_FILE),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
  );
  return manifest;
}
