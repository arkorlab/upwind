import { staticPagesPrivacyOf } from '@stayingupwind/core/bundle';
import {
  type RouteEntryDescriptor,
  type RouteEntryKind,
  generationResponseHeaders,
  staticPageHasNoTransform,
  staticPageHeadersAllowSharing,
} from '@stayingupwind/core/cache';

import type { CapturedRender } from './capture.ts';

/** Existing immutable build data, not a capability supplied by the regeneration's caller. */
export type StaticPagesManifest = Parameters<typeof staticPagesPrivacyOf>[0];

type StaticPage = StaticPagesManifest['prerenders'][number];

// Only this runtime's immutable Store manifests are cached, on the first ISR regeneration.
const admissions = new WeakMap<StaticPagesManifest, ReadonlyMap<string, StaticPage>>();

const HTTP_OK = 200;

/** Internal proof earned only by this module's synthetic-render boundary. */
export interface StaticRender extends CapturedRender {
  readonly staticPagePrivacy?: 2 | undefined;
}

interface RenderInput {
  readonly manifest: StaticPagesManifest | undefined;
  readonly scopeId: string;
  readonly descriptor: RouteEntryDescriptor;
  readonly request: Request;
  readonly parameters: Readonly<Record<string, string>> | undefined;
  readonly allowHeader: readonly string[] | undefined;
  readonly render: CapturedRender;
}

function knownLifetime(render: CapturedRender): boolean {
  const { revalidate, expire } = render.cacheControl;
  return (
    typeof revalidate === 'number' &&
    Number.isSafeInteger(revalidate) &&
    revalidate > 0 &&
    (expire === undefined || (Number.isSafeInteger(expire) && expire >= revalidate))
  );
}

function admittedPages(manifest: StaticPagesManifest): ReadonlyMap<string, StaticPage> {
  const held = admissions.get(manifest);
  if (held !== undefined) return held;
  const eligible = staticPagesPrivacyOf(manifest);
  const seen = new Set<string>();
  const pages = new Map<string, StaticPage>();
  for (const page of manifest.prerenders) {
    if (page.route !== page.pathname || seen.has(page.pathname)) continue;
    // Preserve the previous exact first-match rule even if malformed inputs repeat a pathname.
    seen.add(page.pathname);
    if (eligible.get(page) === 2) pages.set(page.pathname, page);
  }
  admissions.set(manifest, pages);
  return pages;
}

/** Called only after renderStatic made and rendered its own synthetic request. */
function staticPageRenderPrivacy(input: RenderInput): 2 | undefined {
  const { manifest, descriptor, request, render } = input;
  if (
    manifest?.staticPagesPrivacy !== 2 ||
    manifest.deploymentId !== input.scopeId ||
    descriptor.kind !== 'pages' ||
    descriptor.pathname !== descriptor.route ||
    request.method !== 'GET' ||
    new URL(request.url).search !== '' ||
    Object.keys(input.parameters ?? {}).length > 0
  )
    return undefined;
  const page = admittedPages(manifest).get(descriptor.pathname);
  if (
    page === undefined ||
    (input.allowHeader ?? []).some((name) => !(page.allowHeader ?? []).includes(name)) ||
    !renderAgrees(manifest, descriptor, render)
  )
    return undefined;
  return 2;
}

function renderAgrees(
  manifest: StaticPagesManifest,
  descriptor: RouteEntryDescriptor,
  render: CapturedRender,
): boolean {
  if (
    render.pagesStatic?.page !== descriptor.route ||
    render.pagesStatic.buildId !== manifest.buildId ||
    render.status !== HTTP_OK ||
    render.html.byteLength === 0 ||
    render.postponed !== undefined ||
    render.rscData !== undefined ||
    render.segments.size > 0 ||
    !knownLifetime(render) ||
    !staticPageHeadersAllowSharing(Object.entries(render.headers))
  )
    return false;
  const contentType = render.headers['content-type'];
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html';
}

interface StaticInput {
  readonly staticPagesManifest?: StaticPagesManifest | undefined;
  readonly runtime: { readonly scopeId: string };
  readonly target: {
    readonly descriptor: RouteEntryDescriptor;
    readonly parameters?: Readonly<Record<string, string>> | undefined;
    readonly allowHeader?: readonly string[] | undefined;
  };
}

/** Stamp only after renderStatic created and captured this request itself. */
export function staticPageRender(
  input: StaticInput,
  request: Request,
  render: CapturedRender,
): StaticRender {
  const staticPagePrivacy = staticPageRenderPrivacy({
    manifest: input.staticPagesManifest,
    scopeId: input.runtime.scopeId,
    descriptor: input.target.descriptor,
    parameters: input.target.parameters,
    allowHeader: input.target.allowHeader,
    request,
    render,
  });
  return staticPagePrivacy === undefined ? render : { ...render, staticPagePrivacy };
}

/** Preserve the existing filtered headers, and only a proved render's transform prohibition. */
export function generationHeadersFor(
  kind: RouteEntryKind,
  render: StaticRender,
): Record<string, string> {
  const headers = generationResponseHeaders(kind, render.status, Object.entries(render.headers));
  if (render.staticPagePrivacy === 2 && staticPageHasNoTransform(Object.entries(render.headers))) {
    headers['cache-control'] = 'no-transform';
  }
  return headers;
}
