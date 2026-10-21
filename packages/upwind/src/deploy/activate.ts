import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { compareCodeUnits } from '@stayingupwind/core/util';

import {
  type AccountScope,
  createDeployment,
  listDeployments,
  type VersionShare,
  type WorkerDeployment,
} from './cloudflare/workers.ts';
import { READINESS_PATH, type Readiness } from './workers/protocol.ts';

/**
 * A deployment's edge version checked, and then made the live one.
 *
 * Cloudflare sends a request to a version that takes no traffic when the request names it
 * (`Cloudflare-Workers-Version-Overrides`) — but only to a version the edge's deployment holds, and
 * to another version without a word where it does not. So the version is first given a share of
 * none beside the live one, and then asked, by name, which version it is and which deployment it
 * serves (`READINESS_PATH`) until it answers as itself; and each path the project names
 * (`deploy.checks`) is asked through it as well. A version that does not answer as itself, or a
 * path that fails, leaves the live version as it was, all its traffic its own again.
 *
 * Only then is the version given all of it. Either way, the deployment is read again first, to see
 * that it is still the one this run made: Cloudflare's deployments take no condition that would
 * refuse a change somebody else made in between, and a run puts back or switches only what it
 * changed itself. Where somebody has changed it since — another deploy, a rollback made while the
 * checks ran — theirs stays as it is, failed checks or not.
 *
 * A project's first deployment is live as soon as its edge is uploaded, with nothing to go back
 * to. It is asked the same questions, without naming a version.
 */

const OVERRIDE_HEADER = 'cloudflare-workers-version-overrides';
/** How long a new version may take to answer as itself, by name and then unnamed. */
const READY_WAIT_MS = 90_000;
const LIVE_WAIT_MS = 60_000;
const POLL_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;
const SECOND_MS = 1000;
const FULL = 100;
const SERVER_ERROR = 500;
/** What the edge says when it serves no deployment (`handleStandalone`). */
const NO_DEPLOYMENT = new Set(['reason=no-pointer', 'reason=pointer-unavailable']);

export interface ActivateInput {
  readonly scope: AccountScope;
  readonly edge: string;
  /** Where the edge is reached: its `workers.dev` name, or the first of its hostnames. */
  readonly origin: URL;
  /** What the new version should answer with. */
  readonly expected: {
    readonly deploymentId: string;
    readonly manifestId: string;
    readonly versionId: string;
  };
  /** Whether the version is live already: a project's first. */
  readonly first: boolean;
  readonly checks: readonly string[];
  readonly message: string;
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export type Activation =
  /** The version takes all the edge's traffic, and answers as itself. */
  | { readonly kind: 'live' }
  /** It was given the traffic, and did not answer as itself in time. */
  | { readonly kind: 'unconfirmed' }
  /** It failed its checks, and the live version keeps the traffic. */
  | { readonly kind: 'kept'; readonly versionId: string; readonly reasons: readonly string[] }
  /**
   * The edge's deployment was changed by somebody else while the version was checked: nothing was
   * switched, and nothing put back. The reasons are its checks' failures, where they failed.
   */
  | { readonly kind: 'overtaken'; readonly reasons: readonly string[] }
  /** It is live, being a first, and failed its checks. */
  | { readonly kind: 'failing'; readonly reasons: readonly string[] };

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function overrideFor(edge: string, versionId: string): Record<string, string> {
  return { [OVERRIDE_HEADER]: `${edge}="${versionId}"` };
}

/** The version that takes all the edge's traffic, beside versions of none — or a refusal. */
export function liveVersionOf(deployment: WorkerDeployment | undefined): string {
  const shares = deployment?.versions ?? [];
  const full = shares.filter((share) => share.percentage === FULL);
  const [live] = full;
  if (
    live === undefined ||
    full.length !== 1 ||
    shares.some((share) => share.percentage !== FULL && share.percentage !== 0)
  ) {
    const split = shares.map((share) => `${share.version_id} at ${String(share.percentage)}%`);
    throw new Error(
      `the edge's traffic is split (${split.join(', ')}); a deploy switches from one version that takes all of it`,
    );
  }
  return live.version_id;
}

function sameShares(
  one: readonly VersionShare[] | undefined,
  other: readonly VersionShare[],
): boolean {
  const key = (shares: readonly VersionShare[]): string => {
    return shares
      .map((share) => `${share.version_id}=${String(share.percentage)}`)
      .toSorted(compareCodeUnits)
      .join(',');
  };
  return one !== undefined && key(one) === key(other);
}

/** Whether the answer is the version's, serving the deployment from a manifest in place. */
function answersAs(readiness: Readiness | undefined, expected: ActivateInput['expected']): boolean {
  return (
    readiness?.deploymentId === expected.deploymentId &&
    readiness.manifestId === expected.manifestId &&
    readiness.versionId === expected.versionId &&
    readiness.manifest.kv &&
    readiness.manifest.r2
  );
}

async function readinessOf(
  input: ActivateInput,
  headers: Readonly<Record<string, string>>,
): Promise<Readiness | undefined> {
  const send = input.fetch ?? fetch;
  try {
    const response = await send(new URL(READINESS_PATH, input.origin), {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    return (await response.json()) as Readiness;
  } catch {
    // Not routed yet, or not answering yet: asked again until the wait is over.
    return undefined;
  }
}

/** Ask until the version answers as itself, or the wait is over; whether it did. */
async function answered(
  input: ActivateInput,
  headers: Readonly<Record<string, string>>,
  waitMs: number,
): Promise<boolean> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? waitFor;
  const until = now() + waitMs;
  for (;;) {
    if (answersAs(await readinessOf(input, headers), input.expected)) {
      return true;
    }
    if (now() >= until) {
      return false;
    }
    await sleep(POLL_MS);
  }
}

/** Why a path fails, asked through the version; nothing where it does not. */
async function failureOf(
  input: ActivateInput,
  path: string,
  headers: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const send = input.fetch ?? fetch;
  try {
    const response = await send(new URL(path, input.origin), {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await response.body?.cancel();
    const said = (response.headers.get(EDGE_DEBUG_HEADER) ?? '').split(';');
    if (said.some((part) => NO_DEPLOYMENT.has(part.trim()))) {
      return `${path} was answered with no deployment`;
    }
    return response.status >= SERVER_ERROR
      ? `${path} was answered with ${String(response.status)}`
      : undefined;
  } catch (error) {
    return `${path} was not answered: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function failures(
  input: ActivateInput,
  headers: Readonly<Record<string, string>>,
): Promise<string[]> {
  const found: string[] = [];
  for (const path of input.checks) {
    const failure = await failureOf(input, path, headers);
    if (failure !== undefined) {
      found.push(failure);
    }
  }
  return found;
}

/** Whether the edge's deployment is still the one this run made to check its version. */
async function stillChecking(
  input: ActivateInput,
  checking: readonly VersionShare[],
): Promise<boolean> {
  const [now] = (await listDeployments(input.scope, input.edge)) ?? [];
  return sameShares(now?.versions, checking);
}

async function activateFirst(input: ActivateInput): Promise<Activation> {
  if (!(await answered(input, {}, READY_WAIT_MS))) {
    return { kind: 'unconfirmed' };
  }
  const reasons = await failures(input, {});
  return reasons.length === 0 ? { kind: 'live' } : { kind: 'failing', reasons };
}

/** Check the new version, and give it the edge's traffic if it passes. */
export async function activate(input: ActivateInput): Promise<Activation> {
  if (input.first) {
    return activateFirst(input);
  }
  const { scope, edge, expected } = input;
  // Read now, not when the run began: what this run makes the deployment is said from what it is.
  const [current] = (await listDeployments(scope, edge)) ?? [];
  const previous = liveVersionOf(current);
  if (previous === expected.versionId) {
    // Live already: nothing to switch, and a split of a version with itself is no deployment.
    return activateFirst(input);
  }
  const checking = [
    { version_id: previous, percentage: FULL },
    { version_id: expected.versionId, percentage: 0 },
  ];
  await createDeployment(scope, edge, checking, `${input.message} (checking)`);
  const headers = overrideFor(edge, expected.versionId);
  const reasons = (await answered(input, headers, READY_WAIT_MS))
    ? await failures(input, headers)
    : [`the new version did not answer as itself within ${String(READY_WAIT_MS / SECOND_MS)} s`];
  // Read again before either write: what somebody else made of the deployment meanwhile stays.
  if (!(await stillChecking(input, checking))) {
    return { kind: 'overtaken', reasons };
  }
  if (reasons.length > 0) {
    await createDeployment(
      scope,
      edge,
      [{ version_id: previous, percentage: FULL }],
      `${input.message} (not switched)`,
    );
    return { kind: 'kept', versionId: previous, reasons };
  }
  await createDeployment(
    scope,
    edge,
    [{ version_id: expected.versionId, percentage: FULL }],
    input.message,
  );
  return { kind: (await answered(input, {}, LIVE_WAIT_MS)) ? 'live' : 'unconfirmed' };
}
