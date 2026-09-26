import type { ImagesConfig } from './config.ts';
import { isLocalAddress } from './local-address.ts';

/**
 * Whether the optimizer may fetch a destination.
 *
 * `/_next/image` takes its source from the query, and anyone may call it. A remote pattern that
 * admits a private address — or an allowed public host that redirects to one — would make the
 * optimizer a way to reach whatever the Function itself can reach: somebody else's application, a
 * metadata service, anything on the network behind it. Next.js gates that behind
 * `images.dangerouslyAllowLocalIP`, and so does this.
 *
 * Checked on the first destination and again on every redirect hop, because a host that answers
 * publicly is free to point somewhere else in a `Location`.
 *
 * Only literal addresses are judged. A name that resolves to a private address is not caught here
 * — nothing in a Function can see what a name resolves to before `fetch` follows it — and that is a
 * limit worth stating rather than papering over.
 */
export function allowedImageDestination(config: ImagesConfig, target: URL): boolean {
  return config.dangerouslyAllowLocalIP || !isLocalAddress(target.hostname);
}
