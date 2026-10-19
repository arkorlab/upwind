/**
 * Where a Function of the stack sends what it fetches itself (`outboundService`): a request for the
 * site — at any origin the site is served under, at the edge's port, or one a check names it by
 * (`SITE_ORIGINS`) — to the edge, as such a request reaches the site deployed, rather than over TLS
 * to the edge's plain socket, or out to the real host a check only names; anything else out to the
 * network, as before.
 */

interface OutboundEnv {
  /** The edge, which serves the site. */
  readonly EDGE: Fetcher;
  /** Every origin a request for the site may name, as a URL writes it, comma-separated. */
  readonly SITE_ORIGINS: string;
}

export default {
  fetch(request, env): Promise<Response> {
    const { origin } = new URL(request.url);
    return env.SITE_ORIGINS.split(',').includes(origin) ? env.EDGE.fetch(request) : fetch(request);
  },
} satisfies ExportedHandler<OutboundEnv>;
