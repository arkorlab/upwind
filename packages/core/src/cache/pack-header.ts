import { SHA256_HEX_LENGTH } from '../artifact/hash.ts';
import { ARTIFACT_ENCODINGS, ARTIFACT_ROLES } from './artifacts.ts';
import { MAX_TAG_LENGTH, MAX_TAGS_PER_ENTRY, ROUTE_ENTRY_KINDS, TAG_KINDS } from './keys.ts';
import type {
  CachePolicy,
  Duration,
  GenerationPackHeader,
  GenerationTag,
  InvalidationState,
  PackArtifactRef,
} from './schema.ts';
import { CACHE_POLICY_SOURCES } from './timing.ts';

/**
 * The header of a delivery record, checked as `generationPackHeaderSchema` checks it and handed
 * back as that schema hands it back: the fields it names, in its order, and nothing else.
 *
 * Written out rather than asked of the schema, because this is the check the runtime makes on a
 * request, and nothing else it makes needs a schema library: with zod bundled for this one check,
 * zod was most of the runtime's bytes and was built before its first response. The two are held to
 * the same verdicts, and to the same fields, by the tests.
 *
 * What is checked is JSON, as the reader parses it, so there is no `undefined` to tell from an absent
 * key; a record's `__proto__` is not one of its keys, as the schema's record type has it.
 */

export const PACK_SCHEMA_VERSION = 1;
/** Whether a generation came out of a build or out of a regeneration at runtime. */
export const GENERATION_SOURCE_KINDS = ['build', 'runtime'] as const;

const LOWER_HEX = /^[0-9a-f]+$/u;
const PROTO = '__proto__';

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/');
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && value.length === SHA256_HEX_LENGTH && LOWER_HEX.test(value);
}

/** `z.number().int()`: a safe integer, which is also a finite number. */
function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

function durationOf(value: unknown): Duration | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const { kind, seconds } = value;
  if (kind === 'unbounded' || kind === 'unknown') {
    return { kind };
  }
  const finite = kind === 'finite' && typeof seconds === 'number' && Number.isFinite(seconds);
  return finite && seconds >= 0 ? { kind, seconds } : undefined;
}

function policyOf(value: unknown): CachePolicy | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const revalidateAfter = durationOf(value['revalidateAfter']);
  const expireAfter = durationOf(value['expireAfter']);
  const clientStale = durationOf(value['clientStale']);
  const { source } = value;
  if (
    revalidateAfter === undefined ||
    expireAfter === undefined ||
    clientStale === undefined ||
    !isOneOf(CACHE_POLICY_SOURCES, source)
  ) {
    return undefined;
  }
  return { revalidateAfter, expireAfter, clientStale, source };
}

function headersOf(value: unknown): Record<string, string> | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (name === PROTO) {
      continue;
    }
    if (typeof header !== 'string') {
      return undefined;
    }
    headers[name] = header;
  }
  return headers;
}

function tagOf(value: unknown): GenerationTag | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const { kind, value: tag } = value;
  return isOneOf(TAG_KINDS, kind) && isFilled(tag) && tag.length <= MAX_TAG_LENGTH
    ? { kind, value: tag }
    : undefined;
}

function artifactOf(value: unknown): PackArtifactRef | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const { artifactId, sha256, byteLength, contentType, encoding, role, representationKey } = value;
  if (
    !isFilled(artifactId) ||
    !isSha256Hex(sha256) ||
    !isCount(byteLength) ||
    !isFilled(contentType) ||
    !isOneOf(ARTIFACT_ENCODINGS, encoding) ||
    !isOneOf(ARTIFACT_ROLES, role) ||
    !isFilled(representationKey)
  ) {
    return undefined;
  }
  return { artifactId, sha256, byteLength, contentType, encoding, role, representationKey };
}

/** Each item as `itemOf` checks it, or `undefined` when one fails or there are too many. */
function listOf<T>(
  value: unknown,
  itemOf: (item: unknown) => T | undefined,
  max = Infinity,
): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) {
    return undefined;
  }
  const items: T[] = [];
  for (const item of value as readonly unknown[]) {
    const checked = itemOf(item);
    if (checked === undefined) {
      return undefined;
    }
    items.push(checked);
  }
  return items;
}

/** The two optional instants, each an integer when it is there. */
function invalidationOf(value: unknown): InvalidationState | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const { revision, staleAt, hardExpireAt } = value;
  if (
    !isCount(revision) ||
    (staleAt !== undefined && !isInteger(staleAt)) ||
    (hardExpireAt !== undefined && !isInteger(hardExpireAt))
  ) {
    return undefined;
  }
  return {
    revision,
    ...(staleAt !== undefined && { staleAt }),
    ...(hardExpireAt !== undefined && { hardExpireAt }),
  };
}

/** What names the record and where it came from: every field but the lists and the digests. */
type Identity = Pick<
  GenerationPackHeader,
  'scopeId' | 'entryId' | 'generationId' | 'seq' | 'source' | 'kind' | 'route' | 'pathname'
>;

function identityOf(value: Fields): Identity | undefined {
  const { scopeId, entryId, generationId, seq, source, kind, route, pathname } = value;
  if (
    !isFilled(scopeId) ||
    !isFilled(entryId) ||
    !isFilled(generationId) ||
    !isInteger(seq) ||
    seq <= 0 ||
    !isOneOf(GENERATION_SOURCE_KINDS, source) ||
    !isOneOf(ROUTE_ENTRY_KINDS, kind) ||
    !isPath(route) ||
    !isPath(pathname)
  ) {
    return undefined;
  }
  return { scopeId, entryId, generationId, seq, source, kind, route, pathname };
}

/** The bodies the record carries, measured and digested. */
type Bodies = Pick<
  GenerationPackHeader,
  'htmlSha256' | 'htmlLength' | 'postponedSha256' | 'postponedLength'
>;

function bodiesOf(value: Fields): Bodies | undefined {
  const { htmlSha256, htmlLength, postponedSha256, postponedLength } = value;
  if (
    !isSha256Hex(htmlSha256) ||
    !isCount(htmlLength) ||
    (postponedSha256 !== null && !isSha256Hex(postponedSha256)) ||
    !isCount(postponedLength)
  ) {
    return undefined;
  }
  return { htmlSha256, htmlLength, postponedSha256, postponedLength };
}

/** The header `value` is, or `undefined` when `generationPackHeaderSchema` would refuse it. */
export function packHeaderOf(value: unknown): GenerationPackHeader | undefined {
  if (!isFields(value) || value['schemaVersion'] !== PACK_SCHEMA_VERSION) {
    return undefined;
  }
  const identity = identityOf(value);
  const bodies = bodiesOf(value);
  const policy = policyOf(value['policy']);
  const headers = headersOf(value['headers']);
  const tags = listOf(value['tags'], tagOf, MAX_TAGS_PER_ENTRY);
  const artifacts = listOf(value['artifacts'], artifactOf);
  const { cacheTimestamp, producedAt, status, revision, invalidation } = value;
  const invalidationState = invalidation === undefined ? undefined : invalidationOf(invalidation);
  if (
    identity === undefined ||
    bodies === undefined ||
    policy === undefined ||
    headers === undefined ||
    tags === undefined ||
    artifacts === undefined ||
    !isIntegerOrNull(cacheTimestamp) ||
    !isIntegerOrNull(producedAt) ||
    !isInteger(status) ||
    !isCount(revision) ||
    (invalidation !== undefined && invalidationState === undefined)
  ) {
    return undefined;
  }
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    scopeId: identity.scopeId,
    entryId: identity.entryId,
    generationId: identity.generationId,
    seq: identity.seq,
    source: identity.source,
    kind: identity.kind,
    route: identity.route,
    pathname: identity.pathname,
    cacheTimestamp,
    producedAt,
    policy,
    status,
    headers,
    tags,
    htmlSha256: bodies.htmlSha256,
    htmlLength: bodies.htmlLength,
    postponedSha256: bodies.postponedSha256,
    postponedLength: bodies.postponedLength,
    artifacts,
    revision,
    ...(invalidationState !== undefined && { invalidation: invalidationState }),
  };
}
