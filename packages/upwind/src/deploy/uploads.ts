import { createHash } from 'node:crypto';

import { type WorkerMetadata, workerForm } from './cloudflare/form.ts';
import {
  type AccountScope,
  createWorker,
  getScriptSubdomain,
  listVersions,
  type ScriptSubdomain,
  setScriptSubdomain,
  type WorkerVersion,
} from './cloudflare/workers.ts';

/**
 * How a deploy uploads a Worker of the project's own — the edge, the cache and its read gateway,
 * the prefetch Worker, the agent — as opposed to a Function, which the build made.
 *
 * Each is one ES module, the one `dist/shipped/` holds, run at the date its packages are tested at.
 * Each is made first with the reach it should have (`ensureWorker`), so that one meant for service
 * bindings alone is never on `workers.dev`, not even between its upload and a change of setting;
 * and held to that reach again after each upload, which a first upload may have changed.
 */

/** The date every Worker of the project's own runs at: the one its packages are tested at. */
export const COMPATIBILITY_DATE = '2026-09-15';
/** The one module of a shipped Worker. */
export const MAIN_MODULE = 'index.mjs';

/** Reached by service bindings alone: on neither `workers.dev` nor a version's preview URL. */
export const UNREACHED: ScriptSubdomain = { enabled: false, previews_enabled: false };

const encoder = new TextEncoder();
const TAG_DIGITS = 16;

/** The form that uploads a shipped Worker. */
export function shippedForm(
  script: string,
  metadata: Omit<WorkerMetadata, 'main_module'>,
): FormData {
  return workerForm({ ...metadata, main_module: MAIN_MODULE }, [
    { name: MAIN_MODULE, type: 'esm', bytes: encoder.encode(script) },
  ]);
}

/**
 * What a Worker of the project's own is tagged with: its code and everything its upload says
 * besides a secret's value, digested. The same tag is the same upload, which is not made again.
 */
export function infraTag(script: string, metadata: unknown): string {
  const digest = createHash('sha256')
    .update(script)
    .update('\n')
    .update(JSON.stringify(metadata))
    .digest('hex');
  return `upwind:infra:${digest.slice(0, TAG_DIGITS)}`;
}

/**
 * The tag of a Worker's newest version — the one numbered highest, whatever order a listing is in;
 * nothing for a Worker with none, or none tagged.
 */
export async function newestTag(scope: AccountScope, name: string): Promise<string | undefined> {
  const versions = await listVersions(scope, name);
  let newest: WorkerVersion | undefined;
  for (const version of versions) {
    if (newest === undefined || (version.number ?? 0) > (newest.number ?? 0)) {
      newest = version;
    }
  }
  return newest?.annotations?.['workers/tag'];
}

/** Make a Worker that is not on the account yet, reachable only as said. */
export async function ensureWorker(
  scope: AccountScope,
  name: string,
  reach: ScriptSubdomain,
  existing: ReadonlySet<string>,
): Promise<void> {
  if (!existing.has(name)) {
    await createWorker(scope, name, reach);
  }
}

/** Hold a Worker to the reach it should have, where an upload left it otherwise. */
export async function holdReach(
  scope: AccountScope,
  name: string,
  reach: ScriptSubdomain,
): Promise<void> {
  const now = await getScriptSubdomain(scope, name);
  if (now?.enabled !== reach.enabled || now.previews_enabled !== reach.previews_enabled) {
    await setScriptSubdomain(scope, name, reach);
  }
}
