import {
  type DeploymentBundle,
  type EntrypointKind,
  pagesDataPathnameUnder,
  type Prerender,
  prerenderResponseHeaders,
  sharedShellPathname,
} from '@stayingupwind/core/bundle';
import {
  appPathFor,
  buildGenerationIdFor,
  deriveEntry,
  generationResponseHeaders,
  implicitTagsFor,
  parseCacheTagsHeader,
  policyFromBuild,
  sharedShellTagOf,
  type RouteEntryDescriptor,
  type RouteEntryKind,
  tagKindOf,
  type GenerationTag,
} from '@stayingupwind/core/cache';
import type { RouteCache } from '@stayingupwind/core/manifest';
import type { SeedArtifact, SeedEntryInput, SeedOutput } from '@stayingupwind/host/cache';
import { blobObjectKey } from '@stayingupwind/host/storage';

/**
 * The build's generation of a route, as deploying it seeds the runtime cache with it: the
 * document (and the state that resumes it) the build wrote, under the build's own storage keys,
 * with the lifetime Next.js gave it and the tags it recorded. Sequence one of every entry the
 * edge may serve — and of every route handler the build rendered, which the deployment's Worker
 * serves. A Pages Router page brings the data its route serves beside the document.
 *
 * Reusable terminal shells also carry the shared identity manual revalidation names across
 * Functions. Deploy this seed support before the runtime that uses it, then create a new immutable
 * deployment and cache scope. Never replace that runtime inside an existing deployment or reuse
 * another deployment's scope. The identity counts with every existing tag toward the authority's
 * per-entry quota; none is dropped to make room for it.
 */

const CACHE_TAGS_HEADER = 'x-next-cache-tags';
/** Seconds the client router may keep the page, as the build records it. */
const STALE_TIME_HEADER = 'x-nextjs-stale-time';
const HTTP_OK = 200;

export interface SeedContext {
  readonly scopeId: string;
  /** When the build ran (unix ms): the origin every lifetime is measured from. */
  readonly generatedAt: number;
}

export interface SeededRoute {
  readonly input: SeedEntryInput;
  /** What the manifest carries for the route; nothing for a route handler, which no route names. */
  readonly cache: RouteCache | undefined;
}

function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

function headerText(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.join(', ');
}

/** What seeding looks a bundle up by, for each of its routes. */
interface BundleIndex {
  /** The kind of the entrypoint a route is served by: the first the bundle names for it. */
  readonly kinds: ReadonlyMap<string, EntrypointKind>;
  /** The prerenders of each pathname, in the bundle's order. */
  readonly prerenders: ReadonlyMap<string, readonly Prerender[]>;
}

/**
 * The index of each bundle seeding has read. Every cacheable prerender is seeded on its own, and
 * found its entrypoint, and a Pages Router page its data, by going through the whole bundle: the
 * seeding of a deployment grew with the square of its routes. A bundle is not changed once it is
 * read, so its index is made the first time it is asked, and goes with it.
 */
const INDEXES = new WeakMap<DeploymentBundle, BundleIndex>();

function indexOf(bundle: DeploymentBundle): BundleIndex {
  const held = INDEXES.get(bundle);
  if (held !== undefined) {
    return held;
  }
  const kinds = new Map<string, EntrypointKind>();
  for (const entrypoint of bundle.entrypoints) {
    if (!kinds.has(entrypoint.pathname)) {
      kinds.set(entrypoint.pathname, entrypoint.kind);
    }
  }
  const prerenders = new Map<string, Prerender[]>();
  for (const prerender of bundle.prerenders) {
    const named = prerenders.get(prerender.pathname);
    if (named === undefined) {
      prerenders.set(prerender.pathname, [prerender]);
    } else {
      named.push(prerender);
    }
  }
  const index = { kinds, prerenders };
  INDEXES.set(bundle, index);
  return index;
}

/** The router a prerender belongs to, and the kind of output: from its entrypoint. */
export function prerenderEntryKind(bundle: DeploymentBundle, prerender: Prerender): RouteEntryKind {
  const kind = indexOf(bundle).kinds.get(prerender.route);
  if (kind === 'pages') {
    return 'pages';
  }
  return kind === 'app-route' ? 'app-route' : 'app-page';
}

/**
 * The tags the build recorded for the page, and the ones Next.js derives from its route: a
 * `revalidatePath` reaches the page through the latter. A class shell (unresolved parameters)
 * gets no pathname tag, as Next.js gives it none.
 */
export function buildTagsOf(kind: RouteEntryKind, prerender: Prerender): GenerationTag[] {
  const recorded = parseCacheTagsHeader(headerText(prerender.initialHeaders?.[CACHE_TAGS_HEADER]));
  const concrete = isTemplate(prerender.pathname) ? undefined : prerender.pathname;
  const implicit =
    kind === 'pages' ? [] : implicitTagsFor(appPathFor(kind, prerender.route), concrete);
  const values = new Set(recorded);
  for (const value of implicit) {
    values.add(value);
  }
  return [...values].map((value) => ({ kind: tagKindOf(value), value }));
}

function seededTagsOf(
  bundle: DeploymentBundle,
  prerender: Prerender,
  kind: RouteEntryKind,
  entryId: string,
): GenerationTag[] {
  const tags = buildTagsOf(kind, prerender);
  if (
    bundle.config.cacheComponents === true &&
    indexOf(bundle).kinds.get(prerender.route) === 'app-page' &&
    sharedShellPathname(prerender) !== undefined
  ) {
    // The identity counts toward the existing per-entry quota; the per-call invalidation bound
    // does not permit dropping existing tags or bypassing the generation quota.
    const value = sharedShellTagOf(entryId);
    if (tags.every((tag) => tag.value !== value)) {
      tags.push({ kind: 'next-implicit', value });
    }
  }
  return tags;
}

/** When the build ran, in unix milliseconds: the origin every seeded lifetime is measured from. */
export function bundleGeneratedAtMs(bundle: DeploymentBundle): number {
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  return Date.parse(bundle.generatedAt);
}

function clientStaleOf(prerender: Prerender): number | undefined {
  const text = headerText(prerender.initialHeaders?.[STALE_TIME_HEADER]);
  if (text === undefined) {
    return undefined;
  }
  const seconds = Number.parseInt(text, 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

function artifactOf(
  role: SeedArtifact['role'],
  blob: NonNullable<Prerender['body']>,
): SeedArtifact {
  return {
    role,
    sha256: blob.sha256,
    byteLength: blob.byteLength,
    contentType: blob.contentType,
    encoding: 'identity',
    storageRef: blobObjectKey(blob.sha256),
  };
}

function outputOf(
  prerender: Prerender,
  representationKey: string,
  artifacts: SeedArtifact[],
  htmlSize: number | null,
): SeedOutput {
  return {
    representationKey,
    pathname: prerender.pathname,
    status: prerender.initialStatus ?? HTTP_OK,
    headers: prerender.initialHeaders ?? {},
    compute: prerender.compute ?? 'unknown',
    response: prerender.response ?? 'unknown',
    htmlSize,
    artifacts,
  };
}

/**
 * The data route's prerender beside a Pages Router page: the props it was rendered with, named as
 * the build names it, under the base path (`<basePath>/_next/data/<buildId>/…`).
 *
 * Of the page's own route and prerender group, as `routePagesData` takes it
 * (`@stayingupwind/core/bundle`): a bundle does not hold a pathname to one prerender, and another
 * group's prerender of the same data pathname holds the props of another render.
 */
function pagesDataOf(bundle: DeploymentBundle, prerender: Prerender): Prerender | undefined {
  const pathname = pagesDataPathnameUnder(
    bundle.buildId,
    bundle.config.basePath,
    prerender.pathname,
  );
  return indexOf(bundle)
    .prerenders.get(pathname)
    ?.find((twin) => {
      return (
        twin.route === prerender.route &&
        twin.groupId === prerender.groupId &&
        twin.body !== undefined
      );
    });
}

/** The outputs of the build's generation: the primary body, its state, and a page's data. */
function outputsOf(
  bundle: DeploymentBundle,
  kind: RouteEntryKind,
  prerender: Prerender,
  body: NonNullable<Prerender['body']>,
): SeedOutput[] {
  if (kind === 'app-route') {
    return [outputOf(prerender, 'route-body', [artifactOf('route-body', body)], null)];
  }
  const document = outputOf(
    prerender,
    'html',
    [
      artifactOf('html', body),
      ...(prerender.postponed === undefined ? [] : [artifactOf('postponed', prerender.postponed)]),
    ],
    prerender.htmlSize ?? null,
  );
  const data = kind === 'pages' ? pagesDataOf(bundle, prerender) : undefined;
  if (data?.body === undefined) {
    return [document];
  }
  return [document, outputOf(data, 'pages-data', [artifactOf('pages-data', data.body)], null)];
}

/**
 * The seed of one prerender. `undefined` for a prerender without a body, which
 * `cacheablePrerenders` never yields, and for one of a Pages Router API route. `next build` renders
 * no such route, and Next.js caches none: `cacheablePrerenders` takes one a bundle names for a
 * route handler's, but it is neither a page nor a handler a Function would regenerate.
 */
export async function seedRouteFor(
  bundle: DeploymentBundle,
  prerender: Prerender,
  ctx: SeedContext,
): Promise<SeededRoute | undefined> {
  const { body } = prerender;
  if (body === undefined || indexOf(bundle).kinds.get(prerender.route) === 'pages-api') {
    return undefined;
  }
  const kind = prerenderEntryKind(bundle, prerender);
  const descriptor: RouteEntryDescriptor = {
    kind,
    route: prerender.route,
    pathname: prerender.pathname,
  };
  const derived = await deriveEntry(ctx.scopeId, descriptor);
  const generationId = await buildGenerationIdFor(ctx.scopeId, derived.entryId);
  const input: SeedEntryInput = {
    descriptor,
    ...(prerender.allowQuery !== undefined &&
      prerender.allowQuery.length > 0 && { allowQuery: prerender.allowQuery }),
    groupInstanceId: String(prerender.groupId),
    generation: {
      generationId,
      cacheTimestamp: ctx.generatedAt,
      producedAt: ctx.generatedAt,
      policy: policyFromBuild({
        initialRevalidate: prerender.initialRevalidate,
        initialExpiration: prerender.initialExpiration,
        clientStale: clientStaleOf(prerender),
      }),
      status: prerender.initialStatus ?? HTTP_OK,
      headers: generationResponseHeaders(
        kind,
        prerender.initialStatus ?? HTTP_OK,
        prerenderResponseHeaders(bundle, prerender),
      ),
      tags: seededTagsOf(bundle, prerender, kind, derived.entryId),
      outputs: outputsOf(bundle, kind, prerender, body),
      dependencyCoverage: 'complete',
    },
  };
  return {
    input,
    cache:
      kind === 'app-route'
        ? undefined
        : {
            entryId: derived.entryId,
            kind,
            delivery: prerender.postponed === undefined ? 'complete' : 'resume',
            // What a member's own entry is keyed by beside a class's: the route, not the template.
            ...(isTemplate(prerender.pathname) && { route: prerender.route }),
          },
  };
}
