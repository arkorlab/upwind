import type { ArtifactLocator } from '@stayingupwind/core/artifact';
import type { AssetRejection } from '@stayingupwind/core/assets';
import type { RouteEntry, ProjectManifest } from '@stayingupwind/core/manifest';

import type { AssetBackendId, DeliveryPolicy, ShellBackendId } from './policy.ts';

/** Result of reading shell bytes from a backend. */
export interface ShellRead {
  readonly bytes: Uint8Array;
  /** Human-readable source for `server-timing` / debug headers (e.g. `memory`, `cache-api`, `kv`). */
  readonly source: string;
  readonly latencyMs: number;
}

/** A whole body or the exact native byte view returned by an owned read. */
export type ShellBodyResult = ArrayBuffer | ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;

/** Optional body ownership supplied by the shell loader; existing custom strategies may ignore it. */
export interface ShellBodyReader {
  open(response: Response, expected?: number): Promise<ShellBodyResult> | undefined;
  finish(result: ShellBodyResult): ArrayBuffer | Uint8Array<ArrayBuffer>;
}

/**
 * Reads shells; generic over the runtime context so this contract stays Cloudflare-free. A
 * pre-compressed rendering of a shell is stored and read exactly like the shell itself. `Id` is the
 * backend the strategy is, which a registry files it under (`StrategyRegistry`).
 */
export interface ShellDeliveryStrategy<C, Id extends ShellBackendId = ShellBackendId> {
  readonly id: Id;
  getShell(ref: ArtifactLocator, ctx: C, body?: ShellBodyReader): Promise<ShellRead | undefined>;
}

/** What an asset strategy did, reported structurally so metrics never parse their own headers. */
export interface AssetHandleResult {
  readonly response: Response;
  /** The response was admitted as an immutable asset (cacheable at the edge). */
  readonly admitted: boolean;
  /** Why admission refused, so a caller can tell a merely uncacheable answer from an unshareable one. */
  readonly rejection?: AssetRejection | undefined;
  /** Served from an edge cache without asking the origin. */
  readonly hit: boolean;
  /** Origin requests made while handling this request. */
  readonly subrequests: number;
  /**
   * Settles once the strategy has finished with the copy of the body it set out to keep; never
   * rejects, and is already held with `waitUntil`. Absent when there was nothing to keep: a cache
   * hit, a `304`, a refusal, or a shadow-validation request.
   */
  readonly kept?: Promise<AssetKeepOutcome> | undefined;
}

/**
 * What became of the copy an asset strategy kept while the body went to the client.
 *
 * Anything but `kept` means nothing here vouches for a stored copy, so the next request for the
 * asset may ask the origin again: the copy was let go of, or its write may yet land
 * (`store-unconfirmed`). It says nothing of the body the client was sent, which goes on beside the
 * copy, whole where the origin's was and short where it was not, as an `interrupted` one may be.
 * The reason is the only place that shows, which is why it is a value and not a log line.
 */
export type AssetKeepOutcome =
  | 'kept'
  /** Past the manifest's size budget; there is nothing here that may hold it. */
  | 'too-large'
  /** The body stopped arriving for longer than the copy is allowed to wait. */
  | 'stalled'
  /** It kept arriving, but not inside the time the runtime leaves for work behind a response. */
  | 'out-of-time'
  /** The origin cut the body short, or the client's own read failed and took the source with it. */
  | 'interrupted'
  /** The Cache API refused or could not take it. */
  | 'store-failed'
  /**
   * The write did not answer in the time left for it.
   *
   * Not the same as failing: the deadline stops the edge waiting, not the write, which may land
   * after this was reported. Nothing here can vouch for the entry, and the next request tells.
   */
  | 'store-unconfirmed';

/** Serves immutable-asset candidates (admission is decided inside the strategy). */
export interface AssetDeliveryStrategy<C, Id extends AssetBackendId = AssetBackendId> {
  readonly id: Id;
  handle(request: Request, originUrl: URL, ctx: C): Promise<AssetHandleResult>;
}

export interface ContinuationHandle {
  readonly response: Promise<Response>;
  abort(reason: string): void;
}

/**
 * What a shell is resumed from: the build's own state, which the deployment's Worker holds under
 * the route's prerender id, or a generation's state, which the edge read with the shell and sends
 * along — under the route it was rendered for, since the Worker holds nothing of the generation
 * and would otherwise have to route the request itself.
 */
export type ContinuationResume =
  | { readonly kind: 'build' }
  | { readonly kind: 'runtime'; readonly state: Uint8Array; readonly route: string };

/** How a continuation is started: the request as the edge sends it, and what it completes. */
export interface ContinuationStart<C> {
  readonly request: Request;
  readonly entry: RouteEntry;
  readonly manifest: ProjectManifest;
  readonly ctx: C;
  /** Absent, the build's state. */
  readonly resume?: ContinuationResume | undefined;
  /** What the edge tells the runtime beside the request, such as a regeneration it asks for. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * Every backend the contract names, implemented. Total rather than partial: a policy is checked
 * against these ids where it is written, so a policy that parses always resolves, and the hot
 * path has no closed-fail branch to take. Each backend is the strategy that names itself so: the
 * id a resolved policy's strategy reports is the backend the policy chose.
 */
export interface StrategyRegistry<C> {
  readonly shell: { readonly [Id in ShellBackendId]: ShellDeliveryStrategy<C, Id> };
  readonly assets: { readonly [Id in AssetBackendId]: AssetDeliveryStrategy<C, Id> };
}

export interface ResolvedPolicy<C> {
  readonly policy: DeliveryPolicy;
  readonly shell: ShellDeliveryStrategy<C>;
  readonly assets: AssetDeliveryStrategy<C>;
}

/** Bind a policy to the concrete strategies its backends name. */
export function resolvePolicy<C>(
  registry: StrategyRegistry<C>,
  policy: DeliveryPolicy,
): ResolvedPolicy<C> {
  return {
    policy,
    shell: registry.shell[policy.shell.backend],
    assets: registry.assets[policy.assets.backend],
  };
}
