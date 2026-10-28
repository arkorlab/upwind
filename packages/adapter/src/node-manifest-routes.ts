import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { ManifestGraphInput } from './node-manifest-graph.ts';
import type { NodeManifestNormalization } from './node-manifest-normalization.ts';
import {
  nodeManifestPagesDefinitions,
  type NodeManifestPagesDefinition,
} from './node-manifest-pages-definitions.ts';

const ENTRYPOINTS = 'entrypoints';
const OPAQUE_ROUTE_METADATA = 'opaque route metadata';
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js client manifest ${reason}; refusing native publication`);
}
export interface SealedRoute {
  readonly kind: 'app-page' | 'app-route' | 'pages' | 'pages-api';
  readonly file: string;
  readonly page: string;
  readonly pathname: string;
  readonly definition?: NodeManifestPagesDefinition | undefined;
}
interface RouteLocation {
  readonly relative: string;
  readonly app: boolean;
  readonly pages: boolean;
  readonly shared: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function metadataEntries(input: ManifestGraphInput): readonly Record<string, unknown>[] {
  if (input.runtimeManifest === undefined) refuse('missing sealed route metadata');
  let value: unknown;
  try {
    value = JSON.parse(input.runtimeManifest);
  } catch {
    return refuse(OPAQUE_ROUTE_METADATA);
  }
  if (!record(value) || !Array.isArray(value[ENTRYPOINTS])) refuse(OPAQUE_ROUTE_METADATA);
  const entries: unknown[] = value[ENTRYPOINTS];
  if (entries.some((entry) => !record(entry))) refuse(OPAQUE_ROUTE_METADATA);
  return entries.filter((entry) => record(entry));
}
export async function sealedRoutes(
  input: ManifestGraphInput,
  normalization: NodeManifestNormalization,
): Promise<{
  readonly routes: ReadonlyMap<string, SealedRoute>;
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
}> {
  const metadata = metadataById(input);
  const app = path.join(normalization.canonicalDistDir, 'server', 'app');
  const pages = path.join(normalization.canonicalDistDir, 'server', 'pages');
  const routes = new Map<string, SealedRoute>();
  const ownedPages = new Set(
    normalization.entries
      .filter((entry) => metadata.get(entry.id)?.['kind'] === 'pages')
      .map((entry) => entry.canonicalFilePath),
  );
  const canonical = await nodeManifestPagesDefinitions(normalization, ownedPages);
  for (const entry of normalization.entries) {
    const location = routeLocation(entry.canonicalFilePath, app, pages);
    if (location === undefined) continue;
    const route = sealedRoute(
      entry,
      metadata.get(entry.id),
      location,
      canonical.definitions.get(entry.canonicalFilePath),
    );
    if (route === undefined) continue;
    const previous = routes.get(entry.canonicalFilePath);
    if (
      previous !== undefined &&
      (previous.kind !== route.kind ||
        previous.page !== route.page ||
        previous.pathname !== route.pathname)
    )
      refuse('shared physical route has conflicting definitions');
    if (previous !== undefined && route.kind === 'pages' && route.definition === undefined)
      refuse('shared Pages file lacks canonical compiler metadata');
    routes.set(entry.canonicalFilePath, route);
  }
  return { routes, files: canonical.files };
}

function metadataById(input: ManifestGraphInput): ReadonlyMap<string, Record<string, unknown>> {
  const metadata = new Map<string, Record<string, unknown>>();
  const entries = metadataEntries(input);
  for (const entry of entries) {
    const id = entry['id'];
    if (typeof id !== 'string' || metadata.has(id)) refuse('ambiguous route metadata');
    metadata.set(id, entry);
  }
  return metadata;
}

function routeLocation(file: string, app: string, pages: string): RouteLocation | undefined {
  const appRelative = beneath(app, file);
  const pagesRelative = beneath(pages, file);
  const relative = appRelative ?? pagesRelative;
  if (relative?.endsWith('.js') !== true) return undefined;
  return {
    relative,
    app: appRelative !== undefined,
    pages: pagesRelative !== undefined,
    shared: pagesRelative !== undefined && ['_app.js', '_document.js'].includes(pagesRelative),
  };
}

function sealedRoute(
  entry: NodeManifestNormalization['entries'][number],
  metadata: Record<string, unknown> | undefined,
  location: RouteLocation,
  definition: NodeManifestPagesDefinition | undefined,
): SealedRoute | undefined {
  // Shared Pages _app/_document inputs stay in the normalization seal, but cannot terminate a
  // protected route-export chain when the route inventory does not declare them.
  if (metadata === undefined && location.shared) return undefined;
  if (metadata?.['pathname'] !== entry.id || metadata['runtime'] !== undefined)
    refuse('unsealed app route metadata');
  const kind = metadata['kind'];
  const appKind = kind === 'app-page' || kind === 'app-route';
  const pagesKind = kind === 'pages' || kind === 'pages-api';
  if ((!appKind && location.app) || (!pagesKind && location.pages)) refuse('unsealed route kind');
  // The exact Node SDK root also seals handler requestMeta for private API route modules.
  if (kind !== 'app-page' && kind !== 'app-route' && kind !== 'pages' && kind !== 'pages-api')
    refuse('unsealed route kind');
  if (kind === 'pages' && definition !== undefined)
    return {
      kind,
      file: entry.canonicalFilePath,
      page: definition.page,
      pathname: definition.pathname,
      definition,
    };
  return {
    kind,
    file: entry.canonicalFilePath,
    page: `/${location.relative.slice(0, -'.js'.length).split(path.sep).join('/')}`,
    pathname: entry.id,
  };
}
