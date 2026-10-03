import { canonicalJson, sha256HexOfText } from '../artifact/hash.ts';
import { createDerivedId } from '../util/id.ts';
import type {
  CacheEntryKind,
  EntryDescriptor,
  KeyDescriptor,
  RouteEntryDescriptor,
  RouteEntryKind,
  TagKind,
} from './schema.ts';

export type {
  CacheEntryKind,
  DataEntryDescriptor,
  EntryDescriptor,
  GenerationTag,
  KeyDescriptor,
  OutputRepresentation,
  RouteEntryDescriptor,
  RouteEntryKind,
  TagKind,
} from './schema.ts';

/**
 * How a cache entry is named.
 *
 * An entry is the logical thing that gets replaced by a new generation: a route's output, or one
 * value of the data cache. Its identity is a digest of versioned key material inside a scope, so
 * the same URL in two deployments is two entries, and a change to what the key is made of is a new
 * key schema rather than a silent collision. Nothing here is a pathname alone, a group alone or a
 * body hash alone. The raw material of a data entry is Next.js's own key, which may embed what a
 * request contained; only its digest is stored, and the descriptor shown on a screen names the
 * kind and the handler, never the key.
 *
 * The shapes these name are checked in `schema.ts`, and nothing here imports it: a Function's
 * runtime names entries on every request and validates none of them, so it does not have to load a
 * schema library to start (see `schema.ts`).
 */

export const KEY_SCHEMA_VERSION = 1;
export const ENTRY_ID_PREFIX = 'ent';
export const GENERATION_ID_PREFIX = 'gen';
export const TAG_ID_PREFIX = 'tag';
/** Next.js prefixes the tags it derives from a route (`revalidatePath` works through them). */
export const IMPLICIT_TAG_PREFIX = '_N_T_';
/** Next.js's own limit on a tag's length (`NEXT_CACHE_TAG_MAX_LENGTH`). */
export const MAX_TAG_LENGTH = 256;
/**
 * How many tags one call may name: Next.js's `NEXT_CACHE_TAG_MAX_ITEMS`, which `validateTags`
 * applies per `fetch`, per `revalidateTag`, per `use cache` entry.
 *
 * The bound of a request, where `MAX_TAGS_PER_ENTRY` is the bound of a record. A data-cache
 * entry's tags are one call's, an invalidation names one call's, and a read of named tags asks
 * about one read's. A host may have encoded this bound into what it records — one that carries a
 * membership bit per tag has nowhere to put the hundred and twenty-ninth — so it is a number the
 * protocol rests on rather than a limit that may be raised here.
 */
export const MAX_TAGS_PER_CALL = 128;
/**
 * How many tags one route's generation may carry.
 *
 * Not `MAX_TAGS_PER_CALL`, which is what Next.js allows one call: a generation carries what a whole
 * render accumulated — every call's tags, plus the route's implicit ones — so a page with twenty
 * tagged fetches passes 128 without any one call coming near it. Held to 128 here, such a page's
 * commit was refused for good and its entry never got a generation: the route silently fell back
 * to rendering on every request.
 *
 * Eight fully tagged calls' worth, which is past what a page reasonably writes and still small
 * enough to lay out. What actually stops a generation past this is the record's header: it may not
 * pass `MAX_PACK_HEADER_BYTES`, and a thousand tags of `MAX_TAG_LENGTH` are more than that on
 * their own, so a host refuses such a commit by the byte count rather than by this one. A quota a
 * host keeps for the tags an *invalidation* names is a different count, which the tags a generation
 * carries do not add to; what they cost it is one derived id each, per commit.
 */
export const MAX_TAGS_PER_ENTRY = 1024;
const REVISION_DIGITS = 12;

/** A route's output, by router and kind. */
export const ROUTE_ENTRY_KINDS = ['app-page', 'pages', 'app-route'] as const;
/** The two data caches Next.js keeps. */
export const DATA_ENTRY_KINDS = ['data:fetch', 'data:use-cache'] as const;
/** Every kind of entry: the route outputs and the data caches. */
export const CACHE_ENTRY_KINDS = [...ROUTE_ENTRY_KINDS, ...DATA_ENTRY_KINDS] as const;
/** What a tag a generation carries says it is (`generationTagSchema`). */
export const TAG_KINDS = ['next-explicit', 'next-implicit', 'platform-delivery'] as const;

export function isRouteDescriptor(descriptor: EntryDescriptor): descriptor is RouteEntryDescriptor {
  return 'pathname' in descriptor;
}

/** The pathname as Next.js keys a prerender: no trailing slash, except the root's own. */
export function normalizeRoutePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** The versioned material an entry's digest is taken over; deterministic for equal descriptors. */
export function canonicalEntryMaterial(descriptor: EntryDescriptor): string {
  if (isRouteDescriptor(descriptor)) {
    return canonicalJson({
      keySchemaVersion: KEY_SCHEMA_VERSION,
      kind: descriptor.kind,
      route: descriptor.route,
      pathname: normalizeRoutePathname(descriptor.pathname),
    });
  }
  return canonicalJson({
    keySchemaVersion: KEY_SCHEMA_VERSION,
    kind: descriptor.kind,
    handler: descriptor.handler,
    key: descriptor.key,
  });
}

export function cacheKeyDigestOf(descriptor: EntryDescriptor): Promise<string> {
  return sha256HexOfText(canonicalEntryMaterial(descriptor));
}

/** The entry id: scope, key schema, kind and digest, so no two scopes share one. */
export function entryIdFor(scopeId: string, kind: CacheEntryKind, digest: string): Promise<string> {
  return createDerivedId(ENTRY_ID_PREFIX, `${scopeId}|k${KEY_SCHEMA_VERSION}|${kind}|${digest}`);
}

export function keyDescriptorFor(
  descriptor: EntryDescriptor,
  allowQuery?: readonly string[],
): KeyDescriptor {
  if (isRouteDescriptor(descriptor)) {
    return {
      kind: descriptor.kind,
      route: descriptor.route,
      pathname: normalizeRoutePathname(descriptor.pathname),
      ...(allowQuery !== undefined && { allowQuery: [...allowQuery] }),
    };
  }
  return {
    kind: descriptor.kind,
    ...(descriptor.handler !== undefined && { handler: descriptor.handler }),
  };
}

export interface DerivedEntry {
  readonly entryId: string;
  readonly cacheKeyDigest: string;
  readonly keyDescriptor: KeyDescriptor;
}

export async function deriveEntry(
  scopeId: string,
  descriptor: EntryDescriptor,
  allowQuery?: readonly string[],
): Promise<DerivedEntry> {
  const cacheKeyDigest = await cacheKeyDigestOf(descriptor);
  return {
    entryId: await entryIdFor(scopeId, descriptor.kind, cacheKeyDigest),
    cacheKeyDigest,
    keyDescriptor: keyDescriptorFor(descriptor, allowQuery),
  };
}

/** The build's generation of an entry: the same id whenever the seed is retried. */
export function buildGenerationIdFor(scopeId: string, entryId: string): Promise<string> {
  return createDerivedId(GENERATION_ID_PREFIX, `${scopeId}|${entryId}|build`);
}

/** A regeneration's generation: one per attempt, so a retried commit converges. */
export function attemptGenerationIdFor(scopeId: string, attemptId: string): Promise<string> {
  return createDerivedId(GENERATION_ID_PREFIX, `${scopeId}|${attemptId}`);
}

export const ARTIFACT_ID_PREFIX = 'blob';

/** A blob's id within its scope: by content, so two outputs of the same bytes share one. */
export function artifactIdFor(scopeId: string, sha256: string): Promise<string> {
  return createDerivedId(ARTIFACT_ID_PREFIX, `${scopeId}|${sha256}`);
}

/** A tag Next.js supplied: derived from the route when it carries the implicit prefix. */
export function tagKindOf(value: string): 'next-explicit' | 'next-implicit' {
  return value.startsWith(IMPLICIT_TAG_PREFIX) ? 'next-implicit' : 'next-explicit';
}

export function tagIdFor(scopeId: string, kind: TagKind, value: string): Promise<string> {
  return createDerivedId(TAG_ID_PREFIX, `${scopeId}|${kind}|${value}`);
}

/** The tags of an `x-next-cache-tags` header, in order, without repeats. */
export function parseCacheTagsHeader(value: string | undefined | null): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const tags: string[] = [];
  for (const part of value.split(',')) {
    const tag = part.trim();
    if (tag !== '' && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * The app path Next.js derives a route's implicit tags from: the route with its `page` or `route`
 * leaf (`/blog/[slug]` → `/blog/[slug]/page`). A Pages Router page has no such path, and no
 * implicit tags: `revalidatePath` reaches it through its own pathname alone.
 */
export function appPathFor(kind: RouteEntryKind, route: string): string {
  const base = route === '/' ? '' : route;
  switch (kind) {
    case 'app-page': {
      return `${base}/page`;
    }
    case 'app-route': {
      return `${base}/route`;
    }
    case 'pages': {
      return route;
    }
  }
}

/**
 * The tags Next.js derives for a page (`getImplicitTags`): the root layout, a layout tag per
 * segment of the app path, the page or route itself, the concrete pathname when the route has no
 * unresolved parameters, and the `/index` twin of the root. A `revalidatePath` names one of these.
 */
export function implicitTagsFor(page: string, pathname?: string): string[] {
  const tags = new Set(derivedTags(page).map((tag) => `${IMPLICIT_TAG_PREFIX}${tag}`));
  if (pathname !== undefined) {
    tags.add(`${IMPLICIT_TAG_PREFIX}${pathname}`);
  }
  if (tags.has(`${IMPLICIT_TAG_PREFIX}/`)) {
    tags.add(`${IMPLICIT_TAG_PREFIX}/index`);
  }
  if (tags.has(`${IMPLICIT_TAG_PREFIX}/index`)) {
    tags.add(`${IMPLICIT_TAG_PREFIX}/`);
  }
  return [...tags];
}

/** Every prefix of the source route, as a layout tag; the page or route itself as it is. */
function derivedTags(page: string): string[] {
  const derived = ['/layout'];
  if (!page.startsWith('/')) {
    return derived;
  }
  for (const prefix of routePrefixes(page)) {
    derived.push(derivedTagFor(prefix));
  }
  return derived;
}

/** A page or route names itself; anything above it is a layout. */
function derivedTagFor(prefix: string): string {
  if (prefix.endsWith('/page') || prefix.endsWith('/route')) {
    return prefix;
  }
  return prefix.endsWith('/') ? `${prefix}layout` : `${prefix}/layout`;
}

/** `/a/b/c` → `/a`, `/a/b`, `/a/b/c`. */
function routePrefixes(page: string): string[] {
  const prefixes: string[] = [];
  let end = page.indexOf('/', 1);
  while (end !== -1) {
    prefixes.push(page.slice(0, end));
    end = page.indexOf('/', end + 1);
  }
  prefixes.push(page);
  return prefixes.filter((prefix) => prefix !== '');
}

/** The current generation of an entry, as the edge reads it. */
export function kvGenerationKey(scopeId: string, entryId: string): string {
  return `gen:${scopeId}:${entryId}`;
}

/** A data-cache entry, as the runtime's handlers read it through the gateway. */
export function kvDataKey(scopeId: string, cacheKeyDigest: string): string {
  return `data:${scopeId}:${cacheKeyDigest}`;
}

/** The latest invalidation of one tag, projected for reads in the caller's region. */
export function kvTagKey(scopeId: string, tagId: string): string {
  return `tag:${scopeId}:${tagId}`;
}

/** The scope's marker: present once it is retired, so a straggler is refused without the host. */
export function kvScopeKey(scopeId: string): string {
  return `scope:${scopeId}`;
}

export function r2CachePrefix(scopeId: string): string {
  return `cache/${scopeId}/`;
}

/** An artifact of a generation, by content, within its scope. */
export function r2BlobKey(scopeId: string, sha256: string): string {
  return `${r2CachePrefix(scopeId)}blobs/${sha256}`;
}

export function r2RecordPrefix(scopeId: string): string {
  return `${r2CachePrefix(scopeId)}records/`;
}

/** The confirmed record of one revision, ordered by name so a listing replays them in order. */
export function r2RecordKey(scopeId: string, revision: number): string {
  return `${r2RecordPrefix(scopeId)}${String(revision).padStart(REVISION_DIGITS, '0')}.json`;
}

/** An event payload too large for the queue message that names it. */
export function r2EventPayloadKey(scopeId: string, eventId: string): string {
  return `${r2CachePrefix(scopeId)}events/${eventId}.json`;
}
