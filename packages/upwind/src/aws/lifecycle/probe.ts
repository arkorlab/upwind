import { request } from 'node:https';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';

/** Verify a new ALB before the application's DNS can be pointed at it. */
export function deploymentProbeFetch(
  publicOrigin: string,
  loadBalancerDnsName: string | undefined,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  if (loadBalancerDnsName === undefined || fetchImpl !== globalThis.fetch) return fetchImpl;
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:')
    throw new Error('Direct ALB probes require an HTTPS public origin');
  return async (input, init) => {
    const probe = new Request(input, init);
    const url = new URL(probe.url);
    if (url.origin !== origin.origin || (probe.method !== 'GET' && probe.method !== 'HEAD'))
      throw new Error('Direct ALB probes require a GET or HEAD request to the public origin');
    probe.signal.throwIfAborted();
    const headers = Object.fromEntries(probe.headers);
    headers['host'] = origin.host;
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: loadBalancerDnsName,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: probe.method,
          headers,
          servername: origin.hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) =>
            checkServerIdentity(origin.hostname, certificate),
          signal: probe.signal,
          agent: false,
        },
        (incoming) => {
          incoming.once('error', reject);
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
          }
          const status = incoming.statusCode ?? 502;
          const noBody = probe.method === 'HEAD' || [204, 205, 304].includes(status);
          if (noBody) incoming.resume();
          resolve(
            new Response(noBody ? null : Readable.toWeb(incoming), {
              status,
              statusText: incoming.statusMessage ?? '',
              headers: responseHeaders,
            }),
          );
        },
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
  };
}
