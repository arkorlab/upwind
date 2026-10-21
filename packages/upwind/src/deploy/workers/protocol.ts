/**
 * How a deploy speaks to the two Workers of its own it puts on an account — the deploy agent
 * (`./agent.ts`) and the edge's entry (`./edge.ts`) — read by the command under Node and by the
 * Workers alike, and so holding nothing either side's runtime lacks.
 */

/** Where the agent answers, each behind its key. */
export const AGENT_PATHS = {
  /** Whether the agent holds the key it was asked with. */
  health: '/v1/health',
  /** A value of the edge's namespace, read or written (`EDGE_STATE`). */
  kv: '/v1/kv/',
  /** An object of the bucket, read or written (`ARTIFACTS`). */
  blob: '/v1/blob/',
  /** Which of a list of the bucket's keys it does not hold. */
  missing: '/v1/blobs/missing',
  seedScope: '/v1/cache/seed-scope',
  seedEntries: '/v1/cache/seed-entries',
  retireScope: '/v1/cache/retire-scope',
  /** A batch of the bucket's objects deleted, for a project being destroyed and for nothing else. */
  purge: '/v1/purge',
} as const;

/**
 * A write's metadata, as JSON percent-encoded (`encodeURIComponent`): a header value holds Latin-1
 * alone, and a pathname a build records there need not be.
 */
export const METADATA_HEADER = 'x-upwind-metadata';

/** The shortest key the agent will hold: shorter, and it answers nothing. */
export const AGENT_KEY_MIN_LENGTH = 32;

/** How many keys one question about missing objects may name. */
export const MISSING_BATCH = 1000;

/**
 * The object in the artifacts bucket that says whose the bucket is (`account.ts`): the one a purge
 * leaves, so that a destroy stopped half way can be run again on what it marked as the project's.
 */
export const OWNER_KEY = 'upwind/owner.json';

/** What the agent's mode is when it may destroy, and is otherwise never. */
export const DESTROY_MODE = 'destroy';

/**
 * Where the edge says which deployment it serves: under `/__upwind`, a prefix an application never
 * holds a route of, and answered before the deployment is.
 */
export const READINESS_PATH = '/__upwind/deployment';

/** What the edge says there. */
export interface Readiness {
  /** The deployment its pointer names; nothing for an edge with no pointer. */
  readonly deploymentId: string | undefined;
  readonly manifestId: string | undefined;
  /** The version of the edge that answered, as Cloudflare numbers it. */
  readonly versionId: string | undefined;
  /** Whether the manifest is where the edge reads it from: the namespace, and the bucket behind it. */
  readonly manifest: { readonly kv: boolean; readonly r2: boolean };
}
