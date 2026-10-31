import {
  publicationDeadline,
  publicationTimeFor,
  type PublicationRequirement,
} from '@stayingupwind/core/cache';
import { privatePublicationIdentity } from '@stayingupwind/core/paas';

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
  return {
    valid: Number.isFinite(checked),
    ready: required === undefined || required.identities.every((id) => identities.has(id)),
  };
}
