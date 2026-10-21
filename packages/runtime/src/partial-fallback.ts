import { partialFallbackUpgradeOf } from '@stayingupwind/core/bundle';

import { afterBody } from './after-body.ts';
import type { Target } from './answers.ts';
import { currentGenerationAfterResponse, type PendingRecordLookup } from './cache/current.ts';
import type { AttemptReason } from './cache/host.ts';
import type { CacheRuntime } from './cache/runtime.ts';
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

/** A different request may have published the completed shell while this response was streaming. */
async function upgradeAfterResponse(job: PartialFallbackJob, schedule: Schedule): Promise<void> {
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

export function withPartialFallbackUpgrade(
  job: PartialFallbackJob,
  response: Response,
  schedule: Schedule,
): Response {
  return afterBody(response, () => {
    job.input.waitUntil(upgradeAfterResponse(job, schedule));
  });
}
