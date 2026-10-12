import type { AuthorityHost } from './authority-host.ts';

/**
 * How long a Function's invalidation waits at the most for the host to have told the scope's copies
 * elsewhere that it moved (`AuthorityHost.announce`): a request made once the answer is in finds
 * them told, where the host told them in time.
 */
const ANNOUNCE_WAIT_MS = 1000;

/** What the host's telling comes to, its failures — the host's to log — included; none to tell. */
function told(host: AuthorityHost, scopeId: string, env: unknown): Promise<void> | undefined {
  const telling = host.announce?.(scopeId, env);
  if (telling === undefined) {
    return undefined;
  }
  return (async () => {
    try {
      await telling;
    } catch {
      // The host logs its own failures: the invalidation is recorded all the same.
    }
  })();
}

/**
 * Tell the host the scope moved, for `ANNOUNCE_WAIT_MS` at the most, and behind the answer past that
 * (`waitUntil`): for a Function's invalidation, whose next request — a navigation after a Server
 * Action, say — should find the copies told. Once for each invalidation: one sent a chunk at a
 * time waits on its last chunk alone (`InvalidateRequest.more`).
 */
export async function announceMoved(
  host: AuthorityHost,
  scopeId: string,
  env: unknown,
  waitUntil: (work: Promise<void>) => void,
): Promise<void> {
  const settled = told(host, scopeId, env);
  if (settled === undefined) {
    return;
  }
  waitUntil(settled);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ANNOUNCE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Tell the host the scope moved, behind the answer (`waitUntil`) and without waiting for it: for an
 * invalidation the host asks for itself, through its control entrypoint — a resource's change, or
 * one of its own — which it may make for many scopes in turn, a second's wait on each holding up
 * the rest, and which reads nothing of the copies once answered; and for each chunk of a
 * Function's invalidation that more follow (`InvalidateRequest.more`).
 */
export function announceBehind(
  host: AuthorityHost,
  scopeId: string,
  env: unknown,
  waitUntil: (work: Promise<void>) => void,
): void {
  const settled = told(host, scopeId, env);
  if (settled !== undefined) {
    waitUntil(settled);
  }
}
