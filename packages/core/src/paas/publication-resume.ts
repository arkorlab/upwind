import { isPublicationTag } from '../cache/publication.ts';
import { PLATFORM_HEADER_PREFIX } from '../request/constants.ts';

/** Set only by the trusted selected-shell transport after public request headers are stripped. */
export const PUBLICATION_RESUME_HEADER = `${PLATFORM_HEADER_PREFIX}publication-resume`;
const MAX_BYTES = 8192;
const MAX_TAGS = 64;
const PUBLIC_GRANT = /^upwind:publication:v1:[a-f\d]{64}:[1-9]\d{0,15}$/u;

function checked(tags: unknown): readonly string[] {
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_TAGS ||
    tags.some((tag: unknown) => typeof tag !== 'string' || !PUBLIC_GRANT.test(tag))
  )
    throw new TypeError('Invalid selected publication grants.');
  return tags as string[];
}

/** Ordinary resource tags are omitted; private markers are never authority proofs on this wire. */
export function resumePublicationHeader(tags: readonly string[]): string | undefined {
  const selected = checked(tags.filter((tag) => isPublicationTag(tag)));
  if (selected.length === 0) return undefined;
  const value = JSON.stringify(selected);
  if (value.length > MAX_BYTES)
    throw new RangeError('Selected publication grants exceed the transport bound.');
  return value;
}

export function parseResumePublicationHeader(value: string | null): readonly string[] {
  if (value === null) return [];
  if (value.length > MAX_BYTES)
    throw new RangeError('Selected publication grants exceed the transport bound.');
  return checked(JSON.parse(value) as unknown);
}
