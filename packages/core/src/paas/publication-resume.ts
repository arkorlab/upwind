import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY } from '../cache/keys.ts';
import { isPublicationTag, publicationDeadline } from '../cache/publication.ts';
import { resourceSnapshotOf } from '../cache/resource-snapshot.ts';
import { PLATFORM_HEADER_PREFIX } from '../request/constants.ts';

/** Set only by the trusted selected-shell transport after public request headers are stripped. */
export const PUBLICATION_RESUME_HEADER = `${PLATFORM_HEADER_PREFIX}publication-resume`;
const MAX_BYTES = 8192;
const MAX_GRANTS = 64;
const JSON_UNIT_DIGITS = 4;
const HEX_RADIX = 16;
const NON_ASCII = /\P{ASCII}/gu;
const INVALID_GRANTS = 'Invalid selected publication grants.';
const UNSAFE_TAG = /[\p{Cc},]/u;
const PUBLIC_GRANT = /^upwind:publication:v1:[a-f\d]{64}:[1-9]\d{0,15}$/u;

function checked(tags: unknown): readonly string[] {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS_PER_ENTRY) throw new TypeError(INVALID_GRANTS);
  let grants = 0;
  let snapshots = 0;
  for (const tag of tags as unknown[]) {
    if (
      typeof tag !== 'string' ||
      tag.length === 0 ||
      tag.length > MAX_TAG_LENGTH ||
      UNSAFE_TAG.test(tag)
    )
      throw new TypeError(INVALID_GRANTS);
    if (isPublicationTag(tag)) {
      if (!PUBLIC_GRANT.test(tag)) throw new TypeError(INVALID_GRANTS);
      grants += 1;
    } else if (resourceSnapshotOf(tag) !== undefined) snapshots += 1;
  }
  if (grants > MAX_GRANTS || (snapshots === 0 && tags.length > grants))
    throw new TypeError(INVALID_GRANTS);
  return tags as string[];
}

function selectedGrants(tags: readonly string[]): string[] {
  const earliest = new Map<string, { readonly tag: string; readonly until: number }>();
  for (const tag of tags) {
    if (!isPublicationTag(tag)) continue;
    const until = publicationDeadline([tag]);
    if (until === undefined || until === 0) throw new TypeError(INVALID_GRANTS);
    const identity = tag.slice(0, tag.lastIndexOf(':'));
    const old = earliest.get(identity);
    if (old === undefined || until < old.until) earliest.set(identity, { tag, until });
  }
  return [...earliest.values()].map((grant) => grant.tag);
}

function selectedResources(tags: readonly string[]): string[] {
  const snapshots = new Map<string, { readonly tag: string; readonly version: number }>();
  const ordinary = new Set<string>();
  for (const tag of tags) {
    if (isPublicationTag(tag)) continue;
    const witness = resourceSnapshotOf(tag);
    if (witness === undefined) ordinary.add(tag);
    else {
      const old = snapshots.get(witness.resourceId);
      if (old === undefined || witness.version < old.version)
        snapshots.set(witness.resourceId, { tag, version: witness.version });
    }
  }
  return snapshots.size === 0
    ? []
    : [...ordinary, ...[...snapshots.values()].map((read) => read.tag)];
}

function headerJson(tags: readonly string[]): string {
  return JSON.stringify(tags).replaceAll(NON_ASCII, (part) => {
    // JSON escapes encode UTF-16 units, including both halves of an astral character.
    return Array.from({ length: part.length }, (_, index) => {
      const unit = part[index]?.codePointAt(0);
      if (unit === undefined) throw new TypeError(INVALID_GRANTS);
      return String.raw`\u${unit.toString(HEX_RADIX).padStart(JSON_UNIT_DIGITS, '0')}`;
    }).join('');
  });
}

/** Reused values retain their earliest grants and witnesses; private markers are never proofs. */
export function resumePublicationHeader(tags: readonly string[]): string | undefined {
  if (tags.length > MAX_TAGS_PER_ENTRY) throw new TypeError(INVALID_GRANTS);
  const selected = checked([...selectedGrants(tags), ...selectedResources(tags)]);
  if (selected.length === 0) return undefined;
  const value = headerJson(selected);
  if (value.length > MAX_BYTES)
    throw new RangeError('Selected publication grants exceed the transport bound.');
  return value;
}

export function parseResumePublicationHeader(value: string | null): readonly string[] {
  if (value === null) return [];
  if (value.length > MAX_BYTES)
    throw new RangeError('Selected publication grants exceed the transport bound.');
  if (/\P{ASCII}/u.test(value)) throw new TypeError(INVALID_GRANTS);
  return checked(JSON.parse(value) as unknown);
}
