import {
  staticPageDataHeadersAllowSharing,
  staticPageHasNoTransform,
} from '@stayingupwind/core/cache';
import type { ConfiguredHeaders } from '@stayingupwind/core/manifest';
import {
  EDGE_DEBUG_HEADER,
  manifestIdPrefix,
  varyOn,
  removeSharedCacheOverrides,
  REVALIDATE_CACHE_CONTROL,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';
import type { RuntimeCacheSettings, ShellDeliveryStrategy } from '@stayingupwind/host/delivery';

import { CacheBody } from '../cache/cache-body.ts';
import type { GenerationDecision } from '../cache/decision.ts';
import { readServedAgain } from '../cache/generation-hold.ts';
import { shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { finishShellBody, loadShell, storageReadsOf } from '../strategies/shell-loader.ts';
import { layStoredConfiguredOver } from './configured-headers.ts';
import { observeMetric, observeServed } from './observer.ts';
import { pageDataArtifact } from './static-page-record.ts';
import type { StaticPageInput } from './static-page.ts';

const HTTP_OK = 200;
const ENTITY_HEADERS = new Set(['content-encoding', 'content-length', 'content-range', 'etag']);

interface Delivery {
  readonly decision: Extract<GenerationDecision, { kind: 'serve' }>;
  readonly configured: ConfiguredHeaders;
  readonly settings: RuntimeCacheSettings;
  readonly startedAt: number;
  readonly dispatches: number;
}

/** Runtime parts use their recorded locator; the normal immutable loader still checks their bytes. */
function dataStrategy(storageRef: string): ShellDeliveryStrategy<EdgeContext> {
  return {
    id: 'r2',
    async getShell(ref, ctx, reading = new CacheBody()) {
      const began = ctx.runtime.now();
      const object = await ctx.env.ARTIFACTS.get(storageRef);
      if (object === null) return;
      if (object.size !== ref.byteLength) {
        releaseStream(object.body, 'paired Pages data of another length');
        return;
      }
      const pending = reading.open(new Response(object.body), ref.byteLength);
      if (pending === undefined) return;
      return {
        bytes: finishShellBody(reading, await pending, ref.byteLength),
        source: 'r2',
        latencyMs: ctx.runtime.now() - began,
      };
    },
  };
}

/** These props come only from the exact current HTML generation; application headers grant nothing. */
export async function servePairedPageData(
  input: StaticPageInput,
  current: Delivery,
): Promise<Response | undefined> {
  const { edge, entry } = input;
  const scopeId = input.manifest.cache?.scopeId;
  if (scopeId === undefined) return undefined;
  const { decision, configured, settings, startedAt, dispatches } = current;
  const artifact = pageDataArtifact(decision.pack, entry, scopeId);
  if (artifact?.storageRef === undefined) return undefined;
  const headers = new Headers({ 'content-type': artifact.contentType });
  layStoredConfiguredOver(headers, configured, edge.forwarding, ENTITY_HEADERS);
  if (configured.conditioned || !staticPageDataHeadersAllowSharing(headers)) return undefined;
  const noTransform = staticPageHasNoTransform([
    ...Object.entries(decision.pack.header.headers),
    ...headers,
  ]);
  removeSharedCacheOverrides(headers);
  headers.set('cache-control', `${REVALIDATE_CACHE_CONTROL}${noTransform ? ', no-transform' : ''}`);
  const ref = {
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
    contentType: artifact.contentType,
    encoding: 'identity' as const,
  };
  const loaded = await loadShell(ref, dataStrategy(artifact.storageRef), edge);
  if (loaded.kind !== 'ok') return undefined;
  headers.set('content-length', String(loaded.read.bytes.byteLength));
  headers.set('x-nextjs-cache', decision.validity === 'stale' ? 'STALE' : 'HIT');
  varyOn(headers, 'Accept-Encoding');
  headers.set(
    EDGE_DEBUG_HEADER,
    `pages-data;src=${loaded.read.source};m=${manifestIdPrefix(edge.manifestId)}`,
  );
  const response = new Response(loaded.read.bytes, { status: HTTP_OK, headers });
  if (decision.readBytes !== undefined) observeServed(edge.host, decision.readBytes);
  const point: EdgeMetric = {
    projectId: edge.projectId,
    kind: 'data',
    pathname: entry.pathname,
    shellStrategy: 'r2',
    shellSource: loaded.read.source,
    outcomeKind: `pages-data-${decision.validity}`,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: 'identity',
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    recordLookupMs: decision.lookupMs,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: loaded.read.bytes.byteLength,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    subrequests: dispatches + storageReadsOf(loaded),
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
  };
  if (decision.validity === 'stale' && shouldAsk(edge, entry.entryId, settings)) {
    triggerDetached(edge, {
      request: new Request(new URL(entry.pathname, input.request.url), input.request),
      middleware: undefined,
      target: { pack: decision.pack, entryId: entry.entryId },
      function: entry.function,
    }).record(point);
  } else observeMetric(edge.host, point);
  if (decision.validity === 'stale')
    readServedAgain(edge, decision.pack, settings, { servedStale: true });
  return response;
}
