import { UPWIND_INTERNAL_PREFIX } from '@stayingupwind/core/paas';

/**
 * Is this address one this machine reaches *this* server on?
 *
 * Asked rather than assumed, because the answer depends on the host. A socket bound to `::` is
 * dual-stack nearly everywhere, and IPv4 loopback reaches it — but not on a host with no IPv4 stack, nor
 * on one where `bindv6only` is set. And on such a host `127.0.0.1:<port>` may be answered by something
 * else entirely, which is why a connection is not the question: the question is who answers it.
 *
 * So the run asks its own door, and reads back the identity it stamps on every answer. What is verified
 * is not that something is listening but that upwind is — the address the adapter is given sends
 * internally rewritten requests somewhere, and somewhere else is worse than nowhere.
 */

/** Reaching a socket this process is itself listening on is immediate or never. */
const PROBE_TIMEOUT_MS = 500;
/** The header every internal answer carries (`internal/router.ts`). */
const RUN_HEADER = 'x-upwind-run';

export async function reachable(address: string, runId: string): Promise<boolean> {
  if (!URL.canParse(address)) {
    return false;
  }
  try {
    const answer = await fetch(`${address}${UPWIND_INTERNAL_PREFIX}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Whatever the state of the server, the header is on the answer: a `503` from a run still
      // compiling is as good an answer as the `200` after it.
      headers: { accept: 'application/json' },
    });
    return answer.headers.get(RUN_HEADER) === runId;
  } catch {
    return false;
  }
}
