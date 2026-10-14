import type { RouteEntry } from '@stayingupwind/core/manifest';
import type { ResolvedPolicy, RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { type DocumentInput, handleDocument } from '../handlers/document.ts';
import type { MiddlewareOutcome } from '../handlers/middleware.ts';
import type { PassthroughWait } from '../handlers/passthrough.ts';
import { keptReadsOut } from '../preview/storage.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { loadShell, type ShellLoadResult } from '../strategies/shell-loader.ts';
import { condemnedIn } from './condemned.ts';
import { decideGeneration, type GenerationDecision } from './decision.ts';
import { heldGeneration, readServedAgain } from './generation-hold.ts';
import { type GenerationKey, type GenerationLoad, readGeneration } from './generation-loader.ts';
import { memberInHand, type MemberLoad, type MemberRead } from './member.ts';
import {
  foregroundDocument,
  regenerationHeaders,
  type RegenerationTarget,
  shouldAsk,
  triggerDetached,
} from './regenerate.ts';

/**
 * A hosted application's document, served from its runtime cache: the entry's record decides
 * what goes out (`decision.ts`), and the document handler composes it as it composes any shell —
 * from the record's bytes rather than the build's, resumed from the record's state, and with a
 * regeneration asked for behind the response when the record is stale. Nothing here is a read
 * the build's shell would not have cost: the record is the shell. Where this isolate holds nothing
 * of the entry, the build's shell is read beside the record (`startRecordRead`), so that a record
 * that turns out to be none to serve costs the first byte no second read after the first.
 *
 * A member of a dynamic route the build did not prerender is answered by the class shell's
 * record. Under `runtimeCache.concreteUpgrade` the member's own record is read beside it
 * (`member.ts`) and answers when it is in hand and one to serve; when there is none, the class
 * shell answers and the Worker is asked, behind the response, to make the member's own — a shell
 * rendered for its parameters — which a later request finds.
 */

/**
 * An entry's record, as a document's read of it starts: what this isolate holds of it, past the
 * hold or not (`generation-hold.ts`), or a read before the first byte — and then the build's shell
 * read beside it.
 */
export interface RecordRead {
  readonly load: Promise<GenerationLoad>;
  /**
   * The build's shell, read beside a record this isolate holds nothing of, for a read that ends in
   * the build (`decideGeneration`) — no record, none the edge can read, KV out of reach with
   * nothing held — to find under way rather than start then; one that ends in a record leaves it to
   * finish, into memory. `undefined` beside a record in memory, whose request reads nothing more,
   * and beside a member's own record (`startRecordRead`).
   */
  readonly shell: Promise<ShellLoadResult> | undefined;
}

/** The build's shell of the route, and the strategy it is read with. */
interface BuildShell {
  readonly entry: RouteEntry;
  readonly resolved: ResolvedPolicy<EdgeContext>;
}

/**
 * Start a document's read of its record, and of the build's shell beside a record not held — but
 * not beside a member's own record (`runtimeCache.concreteUpgrade`), for which `build` is none: the
 * member's two reads take the shell's two among the six a Worker may have waiting for headers at
 * once, and the shell is read as it was, once the record read has ended in the build.
 */
export function startRecordRead(
  edge: EdgeContext,
  key: GenerationKey,
  settings: RuntimeCacheSettings,
  build: BuildShell | undefined,
): RecordRead {
  const held = heldGeneration(edge, key, settings);
  if (held !== undefined) {
    return { load: Promise.resolve(held), shell: undefined };
  }
  const load = readGeneration(edge, key, settings);
  // Nor while reads the request keeps past its answer are still out (`keptReadsOut`): a pointer's
  // refresh, a policy's, the slower of a manifest's two copies. Beside them, the shell's two would
  // take the last of the six requests a Worker may have waiting for headers, which the record's
  // own two, and a middleware's dispatch, need.
  const shell =
    build === undefined || keptReadsOut(edge.ctx)
      ? undefined
      : loadShell(build.entry.shell, build.resolved.shell, edge);
  return { load, shell };
}

/** A record answers: the build's shell read beside it is left to finish, into memory. */
function abandonShell(edge: EdgeContext, read: RecordRead): void {
  if (read.shell !== undefined) {
    edge.ctx.waitUntil(read.shell);
  }
}

export interface CachedDocumentInput extends Omit<DocumentInput, 'shellRead' | 'generation'> {
  readonly key: GenerationKey;
  readonly settings: RuntimeCacheSettings;
  /** The record's read, started ahead of the middleware; `undefined` starts one now. */
  readonly generationRead: RecordRead | undefined;
  /** The member's own record beside the class shell's, when the policy upgrades members. */
  readonly member: MemberRead | undefined;
  /**
   * What answers where the record leaves the document to the build, for a route with no build shell:
   * a member of a class the build made none of, read alone (`ownRecordEntry`). Its record is a
   * member's own, and is regenerated as the member's. Absent for a route whose build shell answers.
   */
  readonly noBuild?: ((recordLookupMs: number) => Promise<Response>) | undefined;
  /**
   * The record read alone (`noBuild`) is the one the member's class completes to
   * (`MemberRoute.keyedBy`), not one of its own: regenerated as itself.
   */
  readonly keyed?: boolean | undefined;
  /**
   * Proxy the request to the application's Worker, with what the middleware decided, counted under
   * the route the document was classified as (`route`).
   */
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

/** What is decided about: the loads in hand, the document as far as it is composed. */
interface Decided {
  readonly input: CachedDocumentInput;
  readonly document: DocumentInput;
  readonly now: number;
  readonly member: MemberLoad | undefined;
  /**
   * What the response waited on the records for, whichever answers: the class shell's read, or the
   * member's beside it when that was waited for and took longer (`Server-Timing`'s `rec`).
   */
  readonly recordMs: number;
}

function middlewareOf(input: CachedDocumentInput) {
  return input.middleware?.kind === 'continue' ? input.middleware : undefined;
}

/**
 * What to have regenerated behind the response: the stale record's own regeneration first; the
 * member's upgrade when nothing else is asked for. Nothing behind a `HEAD`, which is answered with
 * the record's headers alone and dispatches nothing — no resume for a regeneration to ride, and no
 * request of its own.
 */
function wantedRegeneration(
  input: CachedDocumentInput,
  decision: Extract<GenerationDecision, { kind: 'serve' }>,
  target: RegenerationTarget,
  upgrade: RegenerationTarget | undefined,
): RegenerationTarget | undefined {
  if (input.request.method === 'HEAD') {
    return undefined;
  }
  return decision.validity === 'stale' ? target : upgrade;
}

/**
 * The record `target` names is served asking for its regeneration: read again behind the response
 * a second on rather than a hold on (`readServedAgain`). A member's own is read as it was, its
 * absence held (`startMemberRead`).
 */
function readTargetAgain(input: CachedDocumentInput, target: RegenerationTarget): void {
  const options = target.member === true ? { holdAbsence: true } : {};
  readServedAgain(input.edge, target.pack, input.settings, options);
}

/** Serve a record fresh or stale; stale, regenerated behind the response. */
function serveRecord(
  decided: Decided,
  decision: Extract<GenerationDecision, { kind: 'serve' }>,
  target: RegenerationTarget,
  upgrade: RegenerationTarget | undefined,
): Promise<Response> {
  const { input, document } = decided;
  const { edge, settings } = input;
  const complete = decision.pack.postponed === undefined;
  // At most once per cooldown, which only a response that asks for something spends.
  const wanted = wantedRegeneration(input, decision, target, upgrade);
  const asked =
    wanted !== undefined && shouldAsk(edge, wanted.entryId, settings) ? wanted : undefined;
  // A document nothing resumes has no request to ask beside: the regeneration is its own.
  if (asked !== undefined && complete) {
    triggerDetached(edge, {
      request: input.request,
      middleware: middlewareOf(input),
      target: asked,
      function: input.entry.function,
    });
  }
  return handleDocument({
    ...document,
    generation: {
      pack: decision.pack,
      validity: decision.validity,
      source: decision.source,
      readBytes: decision.readBytes,
      lookupMs: decided.recordMs,
      member: target.member === true,
      regeneration:
        asked !== undefined && !complete
          ? regenerationHeaders(edge, 'background', asked)
          : undefined,
      // Served stale with its own regeneration wanted — asked for by this request, or by one before
      // it within the cooldown — the record is read again a second on, for what that regeneration
      // publishes: once the document is certain to go out from it, and not where it is handed to the
      // application whole instead (`delegateSandboxedDocument`). A member's upgrade, asked beside a
      // fresh record, replaces nothing served here.
      onServed:
        wanted === target
          ? () => {
              readTargetAgain(input, target);
            }
          : undefined,
    },
  });
}

/**
 * The member's own record answers when it is one to serve or to regenerate; otherwise the class
 * shell's record answers, and the member's is worth asking for when none exists or the one that
 * does cannot be read — not when KV could not be asked, which the class read met too, and not
 * when the read is still under way.
 */
function serveMember(
  decided: Decided,
): { readonly response: Promise<Response> } | { readonly upgrade: boolean } {
  const { input, member } = decided;
  if (member === undefined) {
    return { upgrade: false };
  }
  const decision = decideGeneration(
    member.load,
    decided.now,
    condemnedIn(input.edge.runtime.memory),
  );
  switch (decision.kind) {
    case 'serve': {
      const target = { pack: decision.pack, entryId: member.key.entryId, member: true };
      return { response: serveRecord(decided, decision, target, undefined) };
    }
    case 'regenerate': {
      const target = { pack: decision.pack, entryId: member.key.entryId, member: true };
      return { response: regenerateInFront(input, target, decided.recordMs) };
    }
    case 'passthrough': {
      const waited = { recordLookupMs: decided.recordMs };
      return {
        response: input.passthrough(
          decision.reason,
          input.middleware,
          input.entry.pathname,
          waited,
        ),
      };
    }
    case 'build': {
      return { upgrade: member.load.kind !== 'unavailable' };
    }
  }
}

/**
 * A record past its expiry, regenerated in the foreground for a `GET`: the response is the render
 * the regeneration writes. A `HEAD` is the application's instead, as a `HEAD` of a document a
 * resume completes is (`head-expired`): the whole page rendered and published for its headers
 * alone, by every `HEAD` of the route until a `GET` had it regenerated.
 */
function regenerateInFront(
  input: CachedDocumentInput,
  target: RegenerationTarget,
  recordLookupMs: number,
): Promise<Response> {
  const waited = { recordLookupMs };
  if (input.request.method === 'HEAD') {
    return input.passthrough('head-expired', input.middleware, input.entry.pathname, waited);
  }
  // The render the response is publishes the record that replaces this one, which every request
  // regenerates in the foreground until the isolate holds that one: read again a second on.
  readTargetAgain(input, target);
  const dispatch = {
    request: input.request,
    middleware: middlewareOf(input),
    target,
    function: input.entry.function,
  };
  return foregroundDocument(input.edge, dispatch, waited);
}

export async function serveCachedDocument(input: CachedDocumentInput): Promise<Response> {
  const { edge, key, settings } = input;
  const read =
    input.generationRead ??
    startRecordRead(
      edge,
      key,
      settings,
      input.member === undefined && input.request.method !== 'HEAD' ? input : undefined,
    );
  const load = await read.load;
  const memberLoad = await memberInHand(edge, input.member, load);
  // The two reads ran side by side, and a member's read in hand was waited for after the class
  // shell's: the wait is the longer of the two, the member's with its entry's derivation the first
  // time this isolate sees it (`deriveAndRead`).
  const recordMs = Math.max(load.lookupMs, memberLoad?.load.lookupMs ?? 0);
  // Whatever hands the request on from here was held up by the read all the same: a record that
  // sends it on, and a document handed on whole (`document-handoffs.ts`, a shell that cannot be
  // served).
  const waited = { recordLookupMs: recordMs };
  const decided: Decided = {
    input,
    now: edge.runtime.now(),
    recordMs,
    document: {
      request: input.request,
      entry: input.entry,
      manifest: input.manifest,
      resolved: input.resolved,
      edge,
      middleware: input.middleware,
      shellRead: undefined,
      generation: undefined,
      passthrough: (reason, middleware, route, more) =>
        input.passthrough(reason, middleware, route, { ...more, ...waited }),
    },
    member: memberLoad,
  };
  const member = serveMember(decided);
  if ('response' in member) {
    abandonShell(edge, read);
    return member.response;
  }
  const decision = decideGeneration(load, decided.now, condemnedIn(edge.runtime.memory));
  if (decision.kind !== 'build') {
    abandonShell(edge, read);
  }
  // A member's record, where there is no class shell, is regenerated as the member's — or as
  // itself, where it is the one the member's keyed class completes to.
  const own = input.noBuild === undefined ? {} : { member: true, keyed: input.keyed };
  switch (decision.kind) {
    case 'build': {
      if (input.noBuild !== undefined) {
        // The read that found nothing to serve was waited for all the same.
        return input.noBuild(decided.recordMs);
      }
      // What the read that found nothing to serve cost is reported as a served record's would be.
      const recordRead = { lookupMs: decided.recordMs, description: decision.reason };
      return handleDocument({ ...decided.document, recordRead, shellRead: read.shell });
    }
    case 'passthrough': {
      return input.passthrough(decision.reason, input.middleware, input.entry.pathname, waited);
    }
    case 'regenerate': {
      const target = { pack: decision.pack, entryId: key.entryId, ...own };
      return regenerateInFront(input, target, decided.recordMs);
    }
    case 'serve': {
      const upgrade =
        memberLoad !== undefined && member.upgrade
          ? { pack: decision.pack, entryId: memberLoad.key.entryId, member: true }
          : undefined;
      const target = { pack: decision.pack, entryId: key.entryId, ...own };
      return serveRecord(decided, decision, target, upgrade);
    }
  }
}
