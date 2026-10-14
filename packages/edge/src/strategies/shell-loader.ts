import {
  type ArtifactLocator,
  sha256Hex,
  staticAssetShellPath,
} from '@stayingupwind/core/artifact';
import { withDeadline } from '@stayingupwind/core/util';
import type { ShellDeliveryStrategy, ShellRead } from '@stayingupwind/host/delivery';

import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from './context.ts';

const ONE_YEAR_SECONDS = 31_536_000;
/** Longest the shell flush waits on the per-data-center Cache API before going to the backend. */
const CACHE_API_READ_BUDGET_MS = 100;

export type ShellLoadResult =
  | { readonly kind: 'ok'; readonly read: ShellRead }
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt'; readonly source: string }
  /** The backend threw (rate limit, internal error, timeout): an infrastructure fact, not a data one. */
  | { readonly kind: 'unavailable'; readonly detail: string };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cacheApiKey(ctx: EdgeContext, sha256: string): Request {
  return new Request(`https://${ctx.host.names.cacheKeyHost}${staticAssetShellPath(sha256)}`);
}

async function matchCacheApi(
  ctx: EdgeContext,
  ref: ArtifactLocator,
): Promise<Uint8Array | undefined> {
  const hit = await caches.default.match(cacheApiKey(ctx, ref.sha256));
  return hit === undefined ? undefined : new Uint8Array(await hit.arrayBuffer());
}

/**
 * A Cache API failure or a slow answer is a miss: the layer is an accelerator on the first-byte
 * path, the backend is the source of truth. The Cache API cannot be cancelled, so the budget only
 * stops the wait; a late answer is discarded.
 */
async function readCacheApi(
  ctx: EdgeContext,
  ref: ArtifactLocator,
): Promise<ShellRead | undefined> {
  const startedAt = ctx.runtime.now();
  try {
    const bytes = await withDeadline(
      matchCacheApi(ctx, ref),
      CACHE_API_READ_BUDGET_MS,
      'shell cache-api read',
    );
    if (bytes === undefined) {
      return undefined;
    }
    return { bytes, source: 'cache-api', latencyMs: ctx.runtime.now() - startedAt };
  } catch (error) {
    logWarn('shell cache-api read failed', { sha256: ref.sha256, detail: errorDetail(error) });
    return undefined;
  }
}

function storeCacheApi(ctx: EdgeContext, ref: ArtifactLocator, bytes: Uint8Array): void {
  const response = new Response(bytes, {
    headers: {
      'content-type': ref.contentType,
      'cache-control': `public, max-age=${ONE_YEAR_SECONDS}, immutable`,
    },
  });
  ctx.ctx.waitUntil(putCacheApi(ctx, ref, response));
}

async function putCacheApi(
  ctx: EdgeContext,
  ref: ArtifactLocator,
  response: Response,
): Promise<void> {
  try {
    await caches.default.put(cacheApiKey(ctx, ref.sha256), response);
  } catch (error) {
    logWarn('shell cache-api write failed', { sha256: ref.sha256, detail: errorDetail(error) });
  }
}

/**
 * What a backend throws for an object under a shell's key that cannot be the shell, told before
 * any of its bytes are read: the size it states is not the shell's. Corrupt, as a read whose bytes
 * are not the shell's is (`verifyRead`), rather than a backend that failed.
 */
export class ShellSizeMismatchError extends Error {
  readonly statedBytes: number;

  constructor(statedBytes: number, options?: ErrorOptions) {
    super(`a shell object of ${String(statedBytes)} bytes`, options);
    this.name = 'ShellSizeMismatchError';
    this.statedBytes = statedBytes;
  }
}

type BackendMiss = Extract<ShellLoadResult, { kind: 'missing' | 'corrupt' | 'unavailable' }>;

/** The backend read is the one place every shell backend's exception is folded into a result. */
async function readBackend(
  ref: ArtifactLocator,
  strategy: ShellDeliveryStrategy<EdgeContext>,
  ctx: EdgeContext,
): Promise<ShellRead | BackendMiss> {
  try {
    return (await strategy.getShell(ref, ctx)) ?? { kind: 'missing' };
  } catch (error) {
    if (error instanceof ShellSizeMismatchError) {
      logWarn('shell backend length mismatch', {
        source: strategy.id,
        sha256: ref.sha256,
        expected: ref.byteLength,
        actual: error.statedBytes,
      });
      return { kind: 'corrupt', source: strategy.id };
    }
    const detail = errorDetail(error);
    logWarn('shell backend read failed', { source: strategy.id, sha256: ref.sha256, detail });
    return { kind: 'unavailable', detail };
  }
}

async function verifyRead(ref: ArtifactLocator, read: ShellRead): Promise<ShellLoadResult> {
  const digest = await sha256Hex(read.bytes);
  if (digest !== ref.sha256 || read.bytes.byteLength !== ref.byteLength) {
    logWarn('shell hash mismatch', { expected: ref.sha256, actual: digest, source: read.source });
    return { kind: 'corrupt', source: read.source };
  }
  return { kind: 'ok', read };
}

/**
 * Cache API bytes are ones this isolate (or another in the colo) already hashed before `put`.
 * Re-hashing them on every hit was first-byte on a warm colo's cold isolate — the same trust as
 * memory, which also does not hash again. Length is the cheap check that a truncated entry is a
 * miss rather than a short shell.
 */
function adoptCacheApi(
  ctx: EdgeContext,
  ref: ArtifactLocator,
  read: ShellRead,
): ShellLoadResult | undefined {
  if (read.bytes.byteLength !== ref.byteLength) {
    logWarn('shell cache-api length mismatch', {
      sha256: ref.sha256,
      expected: ref.byteLength,
      actual: read.bytes.byteLength,
    });
    return undefined;
  }
  remember(ctx, ref, read, false);
  return { kind: 'ok', read };
}

function remember(
  ctx: EdgeContext,
  ref: ArtifactLocator,
  read: ShellRead,
  storeCache: boolean,
): void {
  if (ctx.policy.shell.memoryLru) {
    ctx.runtime.memory.shells.set(ref.sha256, read.bytes, read.bytes.byteLength);
  }
  if (storeCache && ctx.policy.shell.cacheApiLayer) {
    storeCacheApi(ctx, ref, read.bytes);
  }
}

async function adopt(
  ctx: EdgeContext,
  ref: ArtifactLocator,
  read: ShellRead | BackendMiss,
  storeCache: boolean,
): Promise<ShellLoadResult> {
  if ('kind' in read) {
    return read;
  }
  const verified = await verifyRead(ref, read);
  if (verified.kind === 'ok') {
    remember(ctx, ref, verified.read, storeCache);
  }
  return verified;
}

type CacheOutcome = { readonly kind: 'hit'; readonly read: ShellRead } | { readonly kind: 'miss' };

type FirstBytes =
  | { readonly source: 'cache'; readonly read: ShellRead }
  | { readonly source: 'backend'; readonly read: ShellRead | BackendMiss };

async function cacheOutcome(ctx: EdgeContext, ref: ArtifactLocator): Promise<CacheOutcome> {
  const read = await readCacheApi(ctx, ref);
  return read === undefined ? { kind: 'miss' } : { kind: 'hit', read };
}

async function taggedCache(
  cache: Promise<CacheOutcome>,
): Promise<{ readonly tag: 'cache'; readonly cached: CacheOutcome }> {
  return { tag: 'cache', cached: await cache };
}

async function taggedBackend(
  backend: Promise<ShellRead | BackendMiss>,
): Promise<{ readonly tag: 'backend'; readonly read: ShellRead | BackendMiss }> {
  return { tag: 'backend', read: await backend };
}

/**
 * First source that actually has bytes.
 *
 * A backend miss does not beat an in-flight Cache API lookup: this colo may already hold a shell
 * KV has not yet seen. A backend that has bytes does beat a Cache API miss still sitting out its
 * budget — that wait was first-byte, and the backend has been in flight the whole time.
 */
async function firstBytes(
  cache: Promise<CacheOutcome>,
  backend: Promise<ShellRead | BackendMiss>,
): Promise<FirstBytes> {
  const first = await Promise.race([taggedCache(cache), taggedBackend(backend)]);
  if (first.tag === 'cache') {
    if (first.cached.kind === 'hit') {
      return { source: 'cache', read: first.cached.read };
    }
    return { source: 'backend', read: await backend };
  }
  if (!('kind' in first.read)) {
    return { source: 'backend', read: first.read };
  }
  const cached = await cache;
  return cached.kind === 'hit'
    ? { source: 'cache', read: cached.read }
    : { source: 'backend', read: first.read };
}

/**
 * Shell lookup order: isolate memory → per-data-center Cache API (when enabled by the policy) →
 * the policy's backend. Backend bytes are hash-verified before they enter memory or the Cache API.
 * A Cache API hit is trusted the way a memory hit is: we put only verified bytes there.
 *
 * The backend starts as soon as memory misses, and the first source with bytes wins. Waiting for a
 * Cache API miss (or its 100 ms budget) before opening KV — or before using KV that already
 * answered — was first-byte on every cold colo. The unused loser is discarded.
 *
 * A pre-compressed rendering of a shell is an artifact like any other and is loaded the same way,
 * under its own hash; every layer stores it as opaque bytes, never as an encoded response.
 */
export async function loadShell(
  ref: ArtifactLocator,
  strategy: ShellDeliveryStrategy<EdgeContext>,
  ctx: EdgeContext,
): Promise<ShellLoadResult> {
  const startedAt = ctx.runtime.now();
  // Shadow validation reads the candidate's own backend and nothing in front of it. A shell this
  // colo already holds — put there by live traffic under the active policy — would answer a
  // validation request under the candidate's policy without its KV or R2 binding being touched at
  // all, so a candidate whose binding is broken would pass and be promoted, and the cold colos it
  // was promoted to would then find nothing and fall back to the origin.
  const layered = !ctx.validated;
  const inMemory =
    layered && ctx.policy.shell.memoryLru ? ctx.runtime.memory.shells.get(ref.sha256) : undefined;
  if (inMemory !== undefined) {
    const latencyMs = ctx.runtime.now() - startedAt;
    return { kind: 'ok', read: { bytes: inMemory, source: 'memory', latencyMs } };
  }
  const backend = readBackend(ref, strategy, ctx);
  if (!layered || !ctx.policy.shell.cacheApiLayer) {
    return adopt(ctx, ref, await backend, false);
  }
  const cache = cacheOutcome(ctx, ref);
  const winner = await firstBytes(cache, backend);
  if (winner.source === 'cache') {
    const cached = adoptCacheApi(ctx, ref, winner.read);
    if (cached !== undefined) {
      ctx.ctx.waitUntil(
        (async (): Promise<void> => {
          await backend;
        })(),
      );
      return cached;
    }
    return adopt(ctx, ref, await backend, true);
  }
  // The Cache API is still in flight. Holding it with waitUntil would keep the isolate on a miss
  // budget that this request no longer needs; adopt stores the backend bytes for the next one.
  return adopt(ctx, ref, winner.read, true);
}
