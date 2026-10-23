import {
  type DecodedGenerationPack,
  type decodeGenerationPack,
  verifyGenerationPack,
} from '@stayingupwind/core/cache';
import { allowRecoveryScript } from '@stayingupwind/core/request';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';
import { RECOVERY_SCRIPT_CSP_SOURCE } from '@stayingupwind/host/splice';

import { LONGEST_COPY_AGE_MS } from '../memory/invalidations.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { isInvalidated } from './condemned.ts';
import type { GenerationKey, HeldGeneration, Read } from './generation-hold.ts';
import { transportableIds } from './generation-identities.ts';

const DECODED_METADATA_MULTIPLIER = 4;
const CSP_HEADER = 'content-security-policy';

function packBytes(pack: DecodedGenerationPack, recordBytes: number): number {
  const bodyBytes = pack.html.byteLength + (pack.postponed?.byteLength ?? 0);
  // The body views retain the complete record buffer. Budget decoded strings/objects too,
  // including metadata-only records; this arithmetic runs only when a record is read.
  const metadataAllowance = DECODED_METADATA_MULTIPLIER * (recordBytes - bodyBytes);
  return recordBytes + metadataAllowance;
}

/**
 * The record with its policy permitting the recovery script, as the deployment run records a
 * route's (`allowRecoveryScript`): the edge replays the headers of the generation it serves and
 * appends that script to a document whose resume fails, and a policy restricting inline scripts
 * would block it. Widened here, once per read of the record, rather than on every request that
 * serves it. Only a record a resume completes, with a policy, comes here; any other — nearly every
 * one — goes on as it was read, without waiting on anything. One complete in itself has no resume
 * to fail and no script behind it, and keeps the policy its render set, as a route the deployment
 * run records complete does. The default source is bound to the emitted script by CI, so reading
 * a record does not need to digest that script or wait for its permission.
 */
function withRecoveryPermitted(pack: DecodedGenerationPack): DecodedGenerationPack {
  const permitted = allowRecoveryScript(pack.header.headers, RECOVERY_SCRIPT_CSP_SOURCE);
  return { ...pack, header: { ...pack.header, headers: { ...permitted } } };
}

/** Where a record's bytes came from, which decides what they are checked for. */
export type Origin =
  | { readonly kind: 'kv' | 'authority' }
  /** This data center's copy, whose stamp says which revision it holds. */
  | { readonly kind: 'copy'; readonly revision: number };

/** A record decoded and held by this isolate, or why it is not held. */
export type Adoption =
  | { readonly kind: 'adopted'; readonly pack: DecodedGenerationPack; readonly readAt: number }
  /** The record checked out, at `revision`, and this isolate holds a later one, which it keeps. */
  | {
      readonly kind: 'behind';
      readonly held: HeldGeneration;
      readonly revision: number;
      readonly pack: DecodedGenerationPack;
    }
  | { readonly kind: 'unusable'; readonly reason: 'corrupt' | 'unsupported' };

export type Decoded = Extract<ReturnType<typeof decodeGenerationPack>, { kind: 'ok' }>;

/** What is logged of bytes that are not the record they are to be served as (`untrusted`). */
type Refusal = string | undefined;
const NOT_THE_COPY = 'record copy is not the record its stamps say';
const NOT_THE_DIGESTS = 'delivery record does not match its digests';

/**
 * Why decoded bytes are not the record they are to be served as, or `undefined` where they are.
 * Wherever they came from, they are the record of the entry they were read under: a header naming
 * another scope or entry is no record of this one, however sound its bytes. Bytes from KV are held
 * to their digests as well. A copy is bytes an isolate held to them before it kept them, which is
 * why a hit is not hashed again; what is asked of it besides is only that it is at the revision its
 * stamp says — the stamp is what copies are ordered by.
 */
async function untrusted(decoded: Decoded, key: GenerationKey, from: Origin): Promise<Refusal> {
  const { header } = decoded.pack;
  const ofTheEntry = header.scopeId === key.scopeId && header.entryId === key.entryId;
  if (ofTheEntry && !transportableIds(decoded.pack)) {
    return 'delivery record identities cannot be sent in regeneration headers';
  }
  if (from.kind === 'copy') {
    return ofTheEntry && header.revision === from.revision ? undefined : NOT_THE_COPY;
  }
  if (!ofTheEntry) {
    return 'delivery record is not the entry it was read under';
  }
  return (await verifyGenerationPack(decoded.pack)) ? undefined : NOT_THE_DIGESTS;
}

/**
 * The record this isolate holds of the entry, past its hold or not, when it is later than one at
 * `revision`: an earlier answer neither answers in its place nor is held over it.
 */
export function heldLater(
  edge: EdgeContext,
  recordKey: string,
  revision: number,
): HeldGeneration | undefined {
  const held = edge.runtime.memory.generations.get(recordKey);
  return held !== undefined && held.pack.header.revision > revision ? held : undefined;
}

/** The same published generation, including its verified document bodies. */
export function sameGeneration(left: DecodedGenerationPack, right: DecodedGenerationPack): boolean {
  const first = left.header;
  const second = right.header;
  return (
    first.revision === second.revision &&
    first.generationId === second.generationId &&
    first.seq === second.seq &&
    first.htmlSha256 === second.htmlSha256 &&
    first.htmlLength === second.htmlLength &&
    first.postponedSha256 === second.postponedSha256 &&
    first.postponedLength === second.postponedLength
  );
}

/** A copy can preserve an isolate's existing proof, but can neither earn nor renew one. */
function authorityConfirmation(
  edge: EdgeContext,
  read: Read,
  pack: DecodedGenerationPack,
  origin: Origin,
): number | undefined {
  if (origin.kind === 'authority') return edge.runtime.now();
  if (origin.kind !== 'copy') return undefined;
  const held = edge.runtime.memory.generations.get(read.recordKey);
  return held !== undefined && sameGeneration(held.pack, pack)
    ? held.authorityConfirmedAt
    : undefined;
}

/**
 * Hold a decoded record: checked for what its origin has to prove, its policy widened for the
 * recovery script where a resume completes it, and set in this isolate's memory in place of
 * whatever was there — unless what is there is later, which is weighed after the last wait here,
 * so that another request's record held meanwhile counts.
 */
export async function adoptDecoded(
  edge: EdgeContext,
  read: Read,
  decoded: Decoded,
  from: { readonly origin: Origin; readonly byteLength: number; readonly wanted?: () => boolean },
): Promise<Adoption> {
  const refused = await untrusted(decoded, read.key, from.origin);
  if (refused !== undefined) {
    logWarn(refused, { key: read.recordKey });
    return { kind: 'unusable', reason: 'corrupt' };
  }
  if (from.wanted?.() === false) return { kind: 'unusable', reason: 'unsupported' };
  const pack =
    decoded.pack.header.headers[CSP_HEADER] === undefined || decoded.pack.postponed === undefined
      ? decoded.pack
      : withRecoveryPermitted(decoded.pack);
  const { revision } = pack.header;
  const later = heldLater(edge, read.recordKey, revision);
  if (later !== undefined) {
    return { kind: 'behind', held: later, revision, pack };
  }
  const readAt = edge.runtime.now();
  // There is a record, condemned or not: an absence held of it no longer stands.
  edge.runtime.memory.absentRecords.delete(read.recordKey);
  if (isInvalidated(edge.runtime.memory, pack, edge.app?.deploymentId)) {
    // Answered, not held: a record held is served past its hold however long ago it was read, and an
    // invalidation reached this one (`isInvalidated`) — a read that set out before it was taken in,
    // or one KV or the copy answered from before it. Nothing is put in place, so `read.adopted`
    // names nothing: it is what this read put in memory, for `forgetSeen` to take back.
    return { kind: 'adopted', pack, readAt };
  }
  const bytes = packBytes(pack, from.byteLength);
  const authorityConfirmedAt = authorityConfirmation(edge, read, pack, from.origin);
  const held = {
    pack,
    readAt,
    bytes,
    ...(authorityConfirmedAt !== undefined && { authorityConfirmedAt }),
  };
  edge.runtime.memory.generations.set(read.recordKey, held, bytes);
  read.adopted.held = held;
  return { kind: 'adopted', pack, readAt };
}

/**
 * How old this data center's copy of a record may be and still answer; zero when no copy is read
 * or kept at all — the policy keeps none, the project has turned them off, or the request is a
 * validation, which reads no record and must leave nothing behind for live traffic to be served.
 * Never past `LONGEST_COPY_AGE_MS`, whatever the policy asks: an at-once invalidation is kept only
 * so long past that (`memory/invalidations.ts`), and a copy from before one must not outlive it.
 */
export function copyMaxAgeMs(edge: EdgeContext, settings: RuntimeCacheSettings): number {
  const asked = edge.cacheApi && !edge.validated ? (settings.cacheApiMaxAgeMs ?? 0) : 0;
  return Math.min(asked, LONGEST_COPY_AGE_MS);
}
