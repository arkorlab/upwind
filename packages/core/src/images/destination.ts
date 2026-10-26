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
 * This portable check judges literal addresses. The native image transport also validates the
 * DNS results used by its sockets; Workers leave network transport to the platform.
 */
export function allowedImageDestination(config: ImagesConfig, target: URL): boolean {
  return config.dangerouslyAllowLocalIP || !isLocalAddress(target.hostname);
}
