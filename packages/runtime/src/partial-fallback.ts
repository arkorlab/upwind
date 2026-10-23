import { partialFallbackUpgradeOf } from '@stayingupwind/core/bundle';

import { afterFirstBytes } from './after-body.ts';
import { answerFromRender, type Target, type Want, withOutcome } from './answers.ts';
import { currentGenerationAfterResponse, type PendingRecordLookup } from './cache/current.ts';
import type { AttemptReason } from './cache/host.ts';
import { answeringAtOnce, publishingKeyOf } from './cache/publishing.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { servable } from './cache/servable.ts';
import { documentFromBuild, rscFromBuild } from './documents.ts';
import type { GenerationSource } from './generation-source.ts';
import type { RoutedInput } from './serve.ts';
import { findShell, generationPathname, type Store } from './store.ts';

export interface PartialFallbackJob {
  readonly input: RoutedInput;
  readonly store: Store;
  readonly runtime: CacheRuntime;
  readonly target: Target;
  readonly pending?: PendingRecordLookup | undefined;
}

type Schedule = (reason: AttemptReason, base: string | null) => boolean;

/** Partial upgrades share the completed shell's key rather than resolving its dynamic tail. */
export function upgradePathname(store: Store, route: string, pathname: string): string {
  if (
    store.manifest.config.cacheComponents !== true ||
    store.manifest.config.partialPrefetching !== true
  ) {
    return pathname;
  }
  const shell = findShell(store, route, pathname);
  return shell?.partialFallback === true &&
    partialFallbackUpgradeOf(store.manifest, shell) !== undefined
    ? generationPathname(shell, pathname)
    : pathname;
}

/** Only the build's explicit partial fallback may be specialized behind its initial response. */
export function partialUpgrade(job: PartialFallbackJob): boolean {
  const { store, target } = job;
  if (
    store.manifest.config.cacheComponents !== true ||
    store.manifest.config.partialPrefetching !== true
  ) {
    return false;
  }
  const { descriptor } = target;
  const shell = findShell(store, descriptor.route, descriptor.pathname);
  return (
    shell?.partialFallback === true &&
    shell.pathname !== descriptor.pathname &&
    partialFallbackUpgradeOf(store.manifest, shell) !== undefined
  );
}

/** A different request may have published the completed shell since this one read the entry. */
async function upgradeBehindResponse(job: PartialFallbackJob, schedule: Schedule): Promise<void> {
  const { runtime, target, input } = job;
  const lookup = await currentGenerationAfterResponse(
    runtime,
    target.descriptor,
    input.waitUntil,
    job.pending,
  );
  if (lookup.kind === 'none') {
    schedule('miss', null);
  } else if (lookup.kind === 'generation' && lookup.current.validity === 'stale') {
    schedule('stale', lookup.current.pack.header.generationId);
  } else if (lookup.kind === 'generation' && lookup.current.validity === 'expired') {
    schedule('expired', lookup.current.pack.header.generationId);
  }
}

/**
 * `response`, with the completed shell's upgrade begun behind it as soon as its first bytes are on
 * their way (`afterFirstBytes`) rather than once it has ended, as Next.js begins it on the tick after
 * it has the fallback response (`scheduleOnNextTick`, `app-page-runtime.ts`). Every request for the
 * member is answered with the fallback until the upgrade is published — on this isolate, until it
 * is rendered (`answerFromPublishing`) — and the fallback's dynamic part lasts as long as the
 * slowest thing it waits for: a second, in Next.js's own shell-upgrade case. Begun behind its end,
 * the lookup, the lease, the render, the upload and the commit all came that much later, and a
 * request made a second or two after the first was answered with the fallback again.
 *
 * Nothing of the upgrade is in front of the first bytes: it is begun once a reader has taken them,
 * and what it does first — a lookup, a lease — is round trips, which hold the response up nowhere.
 * Its render, though, now runs on this isolate beside the visitor's own resume, as Next.js's runs
 * beside the response it is streaming, and the two share the isolate's time: the resume's later
 * chunks can come later by what the render costs. A stale entry's regeneration waits for the end
 * of the body for that reason (`serveFromGeneration`), but every request meanwhile is answered with
 * that entry's page whole; here it is answered with the class's fallback, and a fallback's resume
 * mostly waits on its data rather than on the isolate.
 *
 * A visitor who goes away after the first bytes calls nothing off: the upgrade is for the requests
 * after theirs. One who goes away before them has it begun there and then, as work behind a body
 * given up is begun (`afterBody`), and so does a body that fails or ends before it gave any.
 */
export function withPartialFallbackUpgrade(
  job: PartialFallbackJob,
  response: Response,
  schedule: Schedule,
): Response {
  return afterFirstBytes(response, () => {
    job.input.waitUntil(upgradeBehindResponse(job, schedule));
  });
}

/**
 * The answer from the completed shell's render this isolate is publishing, where it holds one that
 * may answer without asking the host (`answeringAtOnce`): the page every request after its publish
 * is answered with, and the one a regeneration of the member is answered with rather than asking
 * for the lease that render holds (`regenerate`). Its publish is not waited for — the request whose
 * upgrade it is waits for none of it either — and nothing is begun: the render is the upgrade.
 */
async function answerFromPublishing(
  job: PartialFallbackJob,
  want: Want,
): Promise<Response | undefined> {
  const { runtime, input, target } = job;
  const entryId = await publishingKeyOf(runtime, target.descriptor);
  const render = answeringAtOnce(runtime, 'miss', entryId)?.render;
  if (render === undefined || !servable(render.status, render.headers)) {
    return undefined;
  }
  const answered = await answerFromRender(input, target.handler, render, want);
  return answered && withOutcome(answered, 'publishing');
}

/**
 * A member of a partial fallback whose completed shell the cache holds no record of: answered from
 * the render of that shell this isolate is publishing, where there is one to answer from
 * (`answerFromPublishing`), and otherwise with the build's fallback, the upgrade begun behind it
 * (`withPartialFallbackUpgrade`) — save for a `HEAD`, which is sent the fallback's headers and
 * begins nothing.
 */
export async function answerPartialMiss(
  job: PartialFallbackJob,
  source: GenerationSource,
  want: Want,
  schedule: Schedule,
): Promise<Response> {
  const publishing = await answerFromPublishing(job, want);
  if (publishing !== undefined) {
    return publishing;
  }
  const { input, store, target } = job;
  const resolved = {
    route: source.route,
    pathname: new URL(source.url, input.request.url).pathname,
    url: source.url,
  };
  const entry = { kind: 'node' as const, handler: target.handler };
  const response = await (source.representation === 'html'
    ? documentFromBuild(input, store, resolved, { entry, status: 200 })
    : rscFromBuild(input, store, entry, resolved));
  return input.request.method === 'HEAD'
    ? response
    : withPartialFallbackUpgrade(job, response, schedule);
}
