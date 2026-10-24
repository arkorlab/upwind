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

async function failureOf(
  site: URL,
  path: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(new URL(path, site), {
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

/** Why each path fails at the site, in the order the paths are given; none where all answer. */
export async function failedChecks(
  site: URL,
  paths: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const failures: string[] = [];
  for (const path of paths) {
    const failure = await failureOf(site, path, fetchImpl);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}
