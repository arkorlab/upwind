import { kvArtifactKey, sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import {
  type AppRuntime,
  buildProjectManifest,
  computeManifestId,
  type DynamicRoute,
  type HeaderRule,
  type ProjectManifest,
  type ReservedRoute,
  type RouteEntry,
  type RouteSegment,
  serializeManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { NAVIGATION_REQUEST_HEADERS } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { blobObjectKey, kvManifestKey, kvPolicyKey } from '@stayingupwind/host/storage';
import { env } from 'cloudflare:workers';

import type { IncomingRequest } from '../../src/request-context.ts';

/** The site's own hostname, the first `vitest.config.mts` routes to the edge. */
const SITE_HOST = 'site.example';
const PROJECT_ID = 'site';
/** The deployment's one Function, by the name the pointer gives it. */
const APP: AppRuntime = { deploymentId: 'dpl_site', scriptName: 'site-app' };
const UPDATED_AT = '2026-10-09T00:00:00.000Z';

/** A partially prerendered page: the shell the edge stores, and the suffix its resume answers. */
export interface Document {
  readonly shell: Uint8Array;
  readonly shellText: string;
  readonly suffix: Uint8Array;
  readonly suffixText: string;
}

/** The shell as Next.js writes a prelude, one boundary pending; the suffix completes it. */
export function pprDocument(dynamicText = 'Hello dynamic'): Document {
  const shellText =
    '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/></head><body>' +
    '<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main>';
  const suffixText =
    `<div hidden id="S:0"><p>${dynamicText}</p></div>` +
    '<script>$RC("B:0","S:0")</script></body></html>';
  return {
    shell: encodeUtf8(shellText),
    shellText,
    suffix: encodeUtf8(suffixText),
    suffixText,
  };
}

/** A Function's HTML answer, streamed as one chunk. */
export function htmlResponse(body: Uint8Array | string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return new Response(body, { status: init.status ?? 200, headers });
}

export interface SiteOptions {
  readonly document: Document;
  readonly pathname?: string | undefined;
  /** Files the manifest serves from storage, by pathname, each stored under `blobs/`. */
  readonly files?: Readonly<Record<string, string>> | undefined;
  /** Files kept from the deployment before (`KEPT_DEPLOYMENT`), stored the same way. */
  readonly keptFiles?: Readonly<Record<string, string>> | undefined;
  /** The build's `next/image` configuration; none, absent. */
  readonly images?: ImagesConfig | undefined;
  /** The build's dynamic routes, in Next.js's order; none, absent. */
  readonly dynamicRoutes?: readonly DynamicRoute[] | undefined;
  /** The redirects and rewrites Next.js evaluates ahead of its dynamic routes; none, absent. */
  readonly reservedRoutes?: readonly ReservedRoute[] | undefined;
  /** The page's prefetch segments, by the path the router names each with, each stored in KV. */
  readonly segments?: Readonly<Record<string, string>> | undefined;
  /** The rules of `next.config` `headers()`, in Next.js's order; none, absent. */
  readonly headerRules?: readonly HeaderRule[] | undefined;
  /** What the page's prerender is not served under, as Next.js recorded it; nothing, absent. */
  readonly bypassFor?: RouteEntry['bypassFor'];
  /** The routes the build declared a gate for, each with its gate's name; none, absent. */
  readonly gates?: Readonly<Record<string, string>> | undefined;
  /** The deployment of the site the manifest names (`deployment.dplId`); none unless said. */
  readonly dplId?: string | undefined;
  /** The pathnames Next.js resolves exactly that are of a gated route, each with that route. */
  readonly gatedPathnames?: Readonly<Record<string, string>> | undefined;
}

export interface Site {
  readonly manifest: ProjectManifest;
  readonly manifestId: string;
  readonly pointer: EdgePointer;
}

/** The deployment before, whose files a manifest keeps for the documents still open of it. */
export const KEPT_DEPLOYMENT = 'dpl_before';

async function fileEntries(
  files: Readonly<Record<string, string>>,
  kept = false,
): Promise<Record<string, StaticFileEntry>> {
  const entries: Record<string, StaticFileEntry> = {};
  for (const [pathname, text] of Object.entries(files)) {
    const bytes = encodeUtf8(text);
    const sha256 = await sha256Hex(bytes);
    await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
    entries[pathname] = {
      sha256,
      byteLength: bytes.byteLength,
      contentType: 'text/plain; charset=utf-8',
      immutable: false,
      ...(kept && { deploymentId: KEPT_DEPLOYMENT }),
    };
  }
  return entries;
}

async function segmentEntries(
  segments: Readonly<Record<string, string>>,
): Promise<Record<string, RouteSegment>> {
  const entries: Record<string, RouteSegment> = {};
  for (const [segmentPath, text] of Object.entries(segments)) {
    const bytes = encodeUtf8(text);
    const sha256 = await sha256Hex(bytes);
    await env.EDGE_STATE.put(kvArtifactKey(sha256), bytes);
    entries[segmentPath] = {
      artifact: {
        sha256,
        byteLength: bytes.byteLength,
        contentType: 'text/x-component',
        encoding: 'identity',
      },
    };
  }
  return entries;
}

/**
 * A deployment as whatever deploys to a standalone edge leaves it: its manifest, its shell and the
 * default policy in `EDGE_STATE`, its files in the bucket, and the pointer that names them, which the
 * caller pins on the edge or keeps in `EDGE_STATE` itself.
 */
export async function seedSite(options: SiteOptions): Promise<Site> {
  const pathname = options.pathname ?? '/';
  const { shell } = options.document;
  const sha256 = await sha256Hex(shell);
  const route: RouteEntry = {
    pathname,
    status: 200,
    shell: {
      sha256,
      byteLength: shell.byteLength,
      contentType: 'text/html; charset=utf-8',
      encoding: 'identity',
    },
    headers: { 'content-type': 'text/html; charset=utf-8', vary: 'RSC' },
    prerenderId: pathname,
    ...(options.segments !== undefined && { segments: await segmentEntries(options.segments) }),
    ...(options.bypassFor !== undefined && { bypassFor: [...options.bypassFor] }),
  };
  const manifest = buildProjectManifest({
    projectId: PROJECT_ID,
    runId: 'run_site',
    generatedAt: UPDATED_AT,
    originHost: SITE_HOST,
    deployment: {
      assetSetHash: 'a'.repeat(64),
      observedAt: UPDATED_AT,
      ...(options.dplId !== undefined && { dplId: options.dplId }),
    },
    routes: [route],
    app: APP,
    staticFiles: {
      ...(await fileEntries(options.keptFiles ?? {}, true)),
      ...(await fileEntries(options.files ?? {})),
    },
    images: options.images,
    ...(options.headerRules !== undefined && { headerRules: [...options.headerRules] }),
    ...(options.dynamicRoutes !== undefined && { dynamicRoutes: [...options.dynamicRoutes] }),
    ...(options.reservedRoutes !== undefined && { reservedRoutes: options.reservedRoutes }),
    gates: options.gates,
    gatedPathnames: options.gatedPathnames,
    crawlersStreamed: true,
  });
  const manifestId = await computeManifestId(manifest);
  await env.EDGE_STATE.put(kvManifestKey(manifestId), serializeManifest(manifest));
  await env.EDGE_STATE.put(kvArtifactKey(sha256), shell);
  await env.EDGE_STATE.put(
    kvPolicyKey(DEFAULT_DELIVERY_POLICY.id),
    JSON.stringify(DEFAULT_DELIVERY_POLICY),
  );
  const pointer: EdgePointer = {
    v: 1,
    projectId: PROJECT_ID,
    originHost: SITE_HOST,
    mode: 'edge',
    manifestId,
    policyId: DEFAULT_DELIVERY_POLICY.id,
    app: APP,
    updatedAt: UPDATED_AT,
  };
  return { manifest, manifestId, pointer };
}

/** A browser navigation to the site. */
export function navigation(path: string, init: RequestInit = {}): IncomingRequest {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(NAVIGATION_REQUEST_HEADERS)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return new Request(`https://${SITE_HOST}${path}`, { ...init, headers }) as IncomingRequest;
}
