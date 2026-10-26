/**
 * Where a Function of the stack sends what it fetches itself (`outboundService`): a request for the
 * site — at any origin the site is served under, at the edge's port, or one a check names it by
 * (`SITE_ORIGINS`) — to the edge, as such a request reaches the site deployed, rather than over TLS
 * to the edge's plain socket, or out to the real host a check only names; anything else out to the
 * network, as before.
 *
 * A request for the site waits a turn of the runtime's timers first. The edge, and whatever answers
 * behind it, runs in this same runtime, so a Function that fetches its own site without pause — a
 * background poll of its own data — would otherwise keep the runtime's queue from ever emptying,
 * and the runtime asks the system for new connections and due timers only once it has: every other
 * visitor, and the poll's own timeout, were shut out for as long as it ran. A deployed Function's
 * self-fetch leaves the process and comes back over the network, which gives the same turn.
 */

interface OutboundEnv {
  /** The edge, which serves the site. */
  readonly EDGE: Fetcher;
  /** Every origin a request for the site may name, as a URL writes it, comma-separated. */
  readonly SITE_ORIGINS: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const { origin } = new URL(request.url);
    if (!env.SITE_ORIGINS.split(',').includes(origin)) {
      return fetch(request);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return env.EDGE.fetch(request);
  },
} satisfies ExportedHandler<OutboundEnv>;
