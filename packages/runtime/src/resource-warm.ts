import { pagesDataPathname, queryDependent } from '@stayingupwind/core/bundle';
import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import {
  type ResourceWarmProps,
  type ResourceWarmResult,
  withPrimaryResourceReads,
} from '@stayingupwind/core/paas';

import { nowMs } from './cache/clock.ts';
import { requestContextFor } from './cache/context.ts';
import { regenerate } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import type { EntryTables } from './entries.ts';
import { nodeHandlerOf } from './entries.ts';
import { descriptorFor } from './generations.ts';
import { bypassesPrerender } from './serve.ts';
import { findShell, getStore, isClassShell } from './store.ts';

function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** This operation is selected by trusted dispatch props, never by a URL or request header. */
export function resourceWarmOf(props: unknown): ResourceWarmProps['resourceWarm'] | undefined {
  if (!fields(props) || !fields(props['resourceWarm'])) return undefined;
  const warm = props['resourceWarm'];
  const entry = warm['entry'];
  if (
    warm['v'] !== 1 ||
    typeof warm['scopeId'] !== 'string' ||
    warm['scopeId'].length === 0 ||
    !fields(entry) ||
    !['app-page', 'pages', 'app-route'].includes(entry['kind'] as string) ||
    typeof entry['route'] !== 'string' ||
    !entry['route'].startsWith('/') ||
    typeof entry['pathname'] !== 'string' ||
    !entry['pathname'].startsWith('/')
  )
    return undefined;
  return {
    v: 1,
    scopeId: warm['scopeId'],
    entry: {
      kind: entry['kind'] as RouteEntryDescriptor['kind'],
      route: entry['route'],
      pathname: entry['pathname'],
    },
  };
}

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
  if (runtime === undefined || runtime.scopeId !== props.scopeId) {
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
  return context.run(() =>
    withPrimaryResourceReads(async (): Promise<ResourceWarmResult> => {
      const outcome = await regenerate({
        runtime,
        request,
        handler,
        target: {
          descriptor: entry,
          reason: 'invalidated',
          allowHeader: shell?.allowHeader,
          ...(entry.kind === 'pages' && {
            dataPathname: pagesDataPathname(store.manifest.buildId, entry.pathname),
          }),
        },
        previewToken: store.manifest.bypassToken,
        waitUntil,
        run: context.run,
      });
      switch (outcome.kind) {
        case 'busy':
          return { v: 1, kind: 'busy' };
        case 'skipped':
          return { v: 1, kind: 'skipped' };
        case 'refused':
          return { v: 1, kind: 'failed', error: outcome.reason };
        case 'failed':
          return { v: 1, kind: 'failed', error: outcome.error };
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
    }),
  );
}
