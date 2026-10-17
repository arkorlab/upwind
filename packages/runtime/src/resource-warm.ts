import { pagesDataPathnameUnder, queryDependent } from '@stayingupwind/core/bundle';
import {
  type ResourceWarmProps,
  type ResourceWarmResult,
  withPrimaryResourceReads,
} from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import { requestContextFor } from './cache/context.ts';
import { regenerate } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { type EntryTables, nodeHandlerOf } from './entries.ts';
import { descriptorFor } from './generations.ts';
import { routingParameters } from './route-parameters.ts';
import { bypassesPrerender } from './serve.ts';
import { findShell, getStore, isClassShell } from './store.ts';

export interface ResourceWarmInput {
  readonly props: ResourceWarmProps['resourceWarm'];
  readonly tables: EntryTables;
  readonly request: Request;
  readonly runtime: CacheRuntime | undefined;
  readonly waitUntil: (pending: Promise<unknown>) => void;
}

/** A static regeneration whose ACK follows publication, so the durable owner can check fencing. */
export async function warmResourceRoute(input: ResourceWarmInput): Promise<ResourceWarmResult> {
  const { runtime, props, request, tables, waitUntil } = input;
  if (runtime?.scopeId !== props.scopeId) {
    return { v: 1, kind: 'unsupported' };
  }
  const store = getStore();
  const { entry } = props;
  if (
    store.manifest.deploymentId !== props.scopeId ||
    descriptorFor(store, entry.route, entry.pathname).kind !== entry.kind ||
    (entry.kind === 'pages' && isClassShell(entry.pathname, entry.route))
  )
    return { v: 1, kind: 'unsupported' };
  const shell =
    store.prerendersByPathname.get(entry.pathname) ?? findShell(store, entry.route, entry.pathname);
  if (
    queryDependent(shell, entry.route, entry.pathname) ||
    bypassesPrerender(store, request, shell)
  ) {
    return { v: 1, kind: 'skipped' };
  }
  const handler = await nodeHandlerOf(tables, entry.route);
  if (handler === undefined) return { v: 1, kind: 'unsupported' };
  const context = requestContextFor({
    tables,
    runtime,
    request,
    startedAt: nowMs(),
    waitUntil,
    clock: runtime.clockOf(request),
  });
  // As routing hands a render of a request for it the page's parameters, where Next.js would read
  // them otherwise off its name (`routingParameters`).
  const parameters = routingParameters(store, entry.route, entry.pathname);
  return context.run(() => {
    return withPrimaryResourceReads(async (): Promise<ResourceWarmResult> => {
      const outcome = await regenerate({
        runtime,
        request,
        handler,
        target: {
          descriptor: entry,
          reason: 'invalidated',
          allowHeader: shell?.allowHeader,
          ...(entry.kind === 'pages' && {
            dataPathname: pagesDataPathnameUnder(
              store.manifest.buildId,
              store.manifest.config.basePath,
              entry.pathname,
            ),
          }),
          ...(parameters !== undefined && { parameters }),
        },
        previewToken: store.manifest.bypassToken,
        waitUntil,
        run: context.run,
      });
      switch (outcome.kind) {
        case 'busy': {
          return { v: 1, kind: 'busy' };
        }
        // Never `superseded` here, which says no generation it replaces (`replaces`): a later one
        // standing is nothing to warm all the same.
        case 'skipped':
        case 'superseded': {
          return { v: 1, kind: 'skipped' };
        }
        case 'refused': {
          return { v: 1, kind: 'failed', error: outcome.reason };
        }
        case 'failed': {
          return { v: 1, kind: 'failed', error: outcome.error };
        }
        case 'accepted': {
          const published = await outcome.published;
          return published.kind === 'published'
            ? { v: 1, kind: 'published', generationId: published.generationId }
            : {
                v: 1,
                kind: 'failed',
                error: published.kind === 'failed' ? published.error : published.reason,
              };
        }
      }
    });
  });
}
