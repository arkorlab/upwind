import { deriveEntry } from '@stayingupwind/core/cache';
import type { MemberOfClass, MemberRoute, RouteEntry } from '@stayingupwind/core/manifest';
import type { RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { memberEntryKey } from '../memory/caches.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { heldGeneration, loadGeneration } from './generation-hold.ts';
import type { GenerationKey, GenerationLoad } from './generation-loader.ts';

/**
 * A member's own record, beside the class shell's that answers the member otherwise
 * (`runtimeCache.concreteUpgrade`).
 *
 * The class shell's record is read for every member of the class; the member's own is read beside
 * it, in parallel, and costs the first byte nothing the class shell's read did not cost already:
 * when the class shell's record came from this isolate's memory or this data center's copy, the
 * member's is used only when it is in memory too — held as the request began, or landed by the time
 * the class shell's is judged — and a read of it that is still under way is left to finish for the
 * next request: a backend read in front of a first byte already in hand is the wait the edge exists
 * to avoid. When the class shell's record was read from KV, the member's read went out beside it and
 * is waited for as one.
 *
 * A member's entry is named by a digest of its pathname, derived once per isolate and kept in
 * memory; with the id in memory, and the record or its absence held, the lookup is synchronous —
 * past the hold as within it, the entry read again behind the response (`generation-hold.ts`).
 *
 * The same read answers a member of a class the build made no shell of (`memberRouteFor`), alone:
 * there is no class record beside it, and the member's own is the document or nothing.
 */

/** The member a read is of: its class's route and kind, which key its entry with its pathname. */
interface NamedMember {
  readonly scopeId: string;
  readonly route: string;
  readonly pathname: string;
  /** The class's kind of entry; an App Router page's where the class names none. */
  readonly kind?: MemberRoute['kind'] | undefined;
}

/** What a member read came to: the member's key, and its record or the reason there is none. */
export interface MemberLoad {
  readonly key: GenerationKey;
  readonly load: GenerationLoad;
}

/** What a member's read came to, once it has landed; nothing while it is out. */
interface Landing {
  landed: { readonly load: MemberLoad | undefined } | undefined;
}

export interface MemberRead {
  /** The member's pathname, as the request asks for it. */
  readonly pathname: string;
  /** Settled from this isolate's memory, when the id and the record — or its absence — are held. */
  readonly held: MemberLoad | undefined;
  /**
   * The read otherwise, whose result lands in memory for the next request. Never rejects: a
   * member that cannot be read is `undefined`, and the class shell answers.
   */
  readonly pending: Promise<MemberLoad | undefined>;
  /**
   * What `pending` came to, once it has landed — in memory by then, as a held one is: a read that
   * went out ahead of the middleware is often in hand long before the class shell's is judged.
   */
  readonly landing: Landing;
}

const HOLD_ABSENCE = { holdAbsence: true } as const;

/** Note what `pending` came to as it lands. */
async function noteLanding(
  landing: Landing,
  pending: Promise<MemberLoad | undefined>,
): Promise<void> {
  landing.landed = { load: await pending };
}

/** A read still out, whose result is noted as it lands (`MemberRead.landing`). */
function outstanding(pathname: string, pending: Promise<MemberLoad | undefined>): MemberRead {
  const landing: Landing = { landed: undefined };
  void noteLanding(landing, pending).catch(() => {
    // It never rejects; one that did is in hand as nothing.
  });
  return { pathname, held: undefined, pending, landing };
}

function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/** Whether the policy reads a member's own record beside the class shell's for this request. */
export function upgradesMember(
  settings: RuntimeCacheSettings,
  entry: RouteEntry,
  pathname: string,
): boolean {
  return (
    settings.concreteUpgrade &&
    entry.cache?.kind === 'app-page' &&
    isTemplate(entry.pathname) &&
    pathname !== entry.pathname
  );
}

/** The member's entry, derived from its pathname as the seed derives every entry's. */
async function deriveMemberKey(named: NamedMember): Promise<GenerationKey> {
  const { scopeId, route, pathname } = named;
  const derived = await deriveEntry(scopeId, { kind: named.kind ?? 'app-page', route, pathname });
  return { scopeId, entryId: derived.entryId };
}

async function readMember(
  edge: EdgeContext,
  settings: RuntimeCacheSettings,
  key: GenerationKey,
): Promise<MemberLoad> {
  return { key, load: await loadGeneration(edge, key, settings, HOLD_ABSENCE) };
}

async function deriveAndRead(
  edge: EdgeContext,
  settings: RuntimeCacheSettings,
  named: NamedMember,
): Promise<MemberLoad | undefined> {
  // Timed from before the entry is derived: the record's read waited behind the derivation, and a
  // response waiting on the member waited on both (`Server-Timing`'s `rec`).
  const startedAt = edge.runtime.now();
  try {
    const key = await deriveMemberKey(named);
    edge.runtime.memory.memberEntries.set(
      memberEntryKey(named.scopeId, named.route, named.pathname),
      key.entryId,
    );
    const { load } = await readMember(edge, settings, key);
    return { key, load: { ...load, lookupMs: edge.runtime.now() - startedAt } };
  } catch {
    return undefined;
  }
}

/**
 * Start the member's read: from memory when this isolate holds it — its record or its absence, past
 * the hold or not — else from KV, after the id is derived the first time this isolate sees the
 * member.
 */
export function startMemberRead(
  edge: EdgeContext,
  settings: RuntimeCacheSettings,
  named: NamedMember,
): MemberRead {
  const { pathname } = named;
  const entryId = edge.runtime.memory.memberEntries.get(
    memberEntryKey(named.scopeId, named.route, pathname),
  );
  if (entryId === undefined) {
    return outstanding(pathname, deriveAndRead(edge, settings, named));
  }
  const key = { scopeId: named.scopeId, entryId };
  const held = heldGeneration(edge, key, settings, HOLD_ABSENCE);
  if (held !== undefined) {
    const settled = { key, load: held };
    return {
      pathname,
      held: settled,
      pending: Promise.resolve(settled),
      landing: { landed: { load: settled } },
    };
  }
  return outstanding(pathname, readMember(edge, settings, key));
}

/**
 * The member's record, when it is in hand by the time the class shell's is: held by this isolate,
 * landed by then, or read beside a read of the class shell's own. A read the class shell's did not
 * wait for is left to finish, and answers the next request.
 */
export async function memberInHand(
  edge: EdgeContext,
  member: MemberRead | undefined,
  beside: GenerationLoad,
): Promise<MemberLoad | undefined> {
  if (member === undefined) {
    return undefined;
  }
  if (member.held !== undefined) {
    return member.held;
  }
  // Held by this isolate or answered by this data center's copy, the class shell's record is in
  // hand ahead of any KV read: a member's read that is not is left to finish for the next request.
  // One that has landed by now is in memory, as a held one is, and answers at no wait. One served
  // from memory only once KV had answered behind it waited as a read from KV does.
  if (beside.kind === 'generation' && beside.source !== 'kv' && beside.afterKv !== true) {
    const { landed } = member.landing;
    if (landed !== undefined) {
      return landed.load;
    }
    edge.ctx.waitUntil(member.pending);
    return undefined;
  }
  return member.pending;
}

/** The type a document from a record is sent as: what every page Next.js renders is. */
const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';

/**
 * The route a member of a class with no shell is served under, from its own record alone: named by
 * the class's route, as a class shell's members are counted, condemned and demoted under the class
 * (`offTheEdge`), with the class's conditions and its Function.
 *
 * It names no build shell, because there is none: `shell` is the type a document from a record
 * goes out as, and nothing is read by it — a read of the member's record that finds nothing to
 * serve hands the request to the Function rather than to the build (`noBuild`). The entry the
 * record is read under joins it once the member's id is derived.
 */
export function ownRecordEntry(member: MemberOfClass, entryId?: string): RouteEntry {
  const { members } = member;
  return {
    ...shelllessEntry(members.route),
    // Whether the document is complete is the record's to say (`isCompleteDocument`).
    ...(entryId !== undefined && { cache: { entryId, kind: members.kind, delivery: 'resume' } }),
    ...(members.bypassFor !== undefined && { bypassFor: members.bypassFor }),
    ...(member.function !== undefined && { function: member.function }),
  };
}

/**
 * The route `route`, of a page the build made no shell of, as a document of it is served under
 * (`ownRecordEntry`): no build shell named, and no Function, which the request's own finds.
 */
export function shelllessEntry(route: string): RouteEntry {
  return {
    pathname: route,
    status: 200,
    shell: { sha256: '', byteLength: 0, contentType: HTML_CONTENT_TYPE, encoding: 'identity' },
    headers: {},
  };
}
