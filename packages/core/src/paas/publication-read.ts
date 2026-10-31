import { publicationIdentity, type PublicationGrant } from '../cache/publication.ts';
import { inPublicNextCache } from './next-cache-registry.ts';
import { observePublicationTags } from './publication.ts';

export const PUBLICATION_READ_OBSERVER = Symbol.for('upwind.publication-read-observer@1');
const PRIVATE_PREFIX = 'upwind:publication:private:';
interface Observer {
  [PUBLICATION_READ_OBSERVER]?: () => void;
}

/** A trusted producer starts a read before suspending; this is never a reusable cache proof. */
export function beginPublicationRead(): void {
  (globalThis as Observer)[PUBLICATION_READ_OBSERVER]?.();
}

/** Private results require an authenticated authority identity, rather than a public grant. */
export async function observePrivatePublication(
  identity: Omit<PublicationGrant, 'validUntil'>,
): Promise<void> {
  if (inPublicNextCache()) throw new Error('Private publication cannot enter a shared cache.');
  const hash = await publicationIdentity({ ...identity, validUntil: 1 });
  // Unknown/older cache readers treat this deliberately non-grant publication tag as expired.
  observePublicationTags([`${PRIVATE_PREFIX}${hash}`]);
}

export function privatePublicationIdentity(tag: string): string | undefined {
  if (!tag.startsWith(PRIVATE_PREFIX)) return undefined;
  const hash = tag.slice(PRIVATE_PREFIX.length);
  return /^[a-f\d]{64}$/u.test(hash) ? hash : undefined;
}
