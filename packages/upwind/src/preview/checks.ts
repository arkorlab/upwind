import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';

/**
 * The paths a deploy asks before it switches to a deployment (`deploy.checks`), asked of a preview
 * as a deploy judges them (`activate.ts`): a path fails where it is answered with a server error,
 * where the edge says it has no deployment to serve, or where nothing answers it at all.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const SERVER_ERROR = 500;
/** What the edge says of a request it had no deployment to serve. */
const NO_DEPLOYMENT = new Set(['reason=no-pointer', 'reason=pointer-unavailable']);

/** How the paths are asked: through what, and until when. */
export interface CheckOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  /** Stops the asking: a path asked when it aborts, and those after it, are neither passed nor failed. */
  readonly signal?: AbortSignal | undefined;
}

async function failureOf(
  site: URL,
  path: string,
  fetchImpl: typeof fetch,
  stop: AbortSignal | undefined,
): Promise<string | undefined> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(new URL(path, site), {
      redirect: 'manual',
      signal: stop === undefined ? timeout : AbortSignal.any([timeout, stop]),
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
    if (stop?.aborted === true) {
      return undefined;
    }
    return `${path} was not answered: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Why each path fails at the site, in the order the paths are given; none where all answer. */
export async function failedChecks(
  site: URL,
  paths: readonly string[],
  options: CheckOptions = {},
): Promise<string[]> {
  const { fetchImpl = fetch, signal } = options;
  const failures: string[] = [];
  for (const path of paths) {
    if (signal?.aborted === true) {
      break;
    }
    const failure = await failureOf(site, path, fetchImpl, signal);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}
