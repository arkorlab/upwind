import {
  publicationDeadline,
  publicationTimeFor,
  type PublicationRequirement,
  SNAPSHOT_PUBLICATION_VERSION,
  resourceSnapshotOf,
} from '@stayingupwind/core/cache';
import { privatePublicationIdentity } from '@stayingupwind/core/paas';

function resourceState(
  tags: readonly string[],
  required: PublicationRequirement | undefined,
): { readonly valid: boolean; readonly ready: boolean } {
  if (required?.version !== SNAPSHOT_PUBLICATION_VERSION) return { valid: true, ready: true };
  try {
    const snapshots = tags.map((tag) => resourceSnapshotOf(tag));
    return {
      valid: true,
      ready:
        tags.every((tag) => !tag.startsWith('upwind:publication:')) ||
        snapshots.some((witness) => witness !== undefined),
    };
  } catch {
    return { valid: false, ready: false };
  }
}

/** Private proof is accepted only from the trusted observer, never a response/request header. */
export function livePublicationState(
  observed: ReadonlySet<string>,
  headers: readonly string[],
  required: PublicationRequirement | undefined,
  now: number,
): { readonly valid: boolean; readonly ready: boolean } {
  const checked = required === undefined ? now : publicationTimeFor(required, now);
  const identities = new Set<string>();
  const publicTags: string[] = [...headers];
  for (const tag of observed) {
    const identity = privatePublicationIdentity(tag);
    if (identity === undefined) publicTags.push(tag);
    else identities.add(identity);
  }
  const deadline = publicationDeadline(publicTags);
  if (deadline !== undefined && (!Number.isFinite(checked) || checked >= deadline))
    return { valid: false, ready: false };
  for (const tag of publicTags) {
    const match = /^upwind:publication:v1:([a-f\d]{64}):/u.exec(tag);
    if (match?.[1] !== undefined) identities.add(match[1]);
  }
  if (required !== undefined && [...identities].some((id) => !required.identities.includes(id)))
    return { valid: false, ready: false };
  const resources = resourceState(publicTags, required);
  return {
    valid: Number.isFinite(checked) && resources.valid,
    ready:
      resources.ready &&
      (required === undefined || required.identities.every((id) => identities.has(id))),
  };
}
