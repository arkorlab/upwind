import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { appEntrySource } from './app-entry.ts';
import { beneath } from './build-paths.ts';
import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import type { EntryModule } from './function.ts';
import {
  assertNodeManifestConsumer,
  type NodeManifestConsumerImport,
} from './node-manifest-consumers.ts';
import {
  APP_PAGE_FACTORY,
  EVALUATOR,
  frameworkParent,
  reviewedFrameworkSource,
  reviewedRouteConstructorSource,
  ROUTE_EXPORTS,
  type ManifestProtectedKind,
} from './node-manifest-framework.ts';
import {
  assertNodeManifestTemplateConsumer,
  type NodeManifestTemplateImport,
} from './node-manifest-templates.ts';
import { proveNodeManifestTurbopackConsumers } from './node-manifest-turbopack-consumers.ts';
import {
  inspectNodeManifestTurbopackEntry,
  type NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';

const MAX_SOURCE_MEBIBYTES = 128;
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_CALLER_LABEL_CHARACTERS = 240;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
const ENTRYPOINTS = 'entrypoints';
const OPAQUE_ROUTE_METADATA = 'opaque route metadata';
const TURBOPACK_PRODUCER_KINDS = {
  'app-page': 'app-page-factory',
  pages: 'pages-class',
  'app-route': 'app-route-class',
  'pages-api': 'pages-api-class',
} as const;

export interface ManifestGraphFile {
  readonly file: string;
  readonly sha256: string;
}
export interface ManifestGraphEdge {
  readonly specifier: string;
  readonly target: string;
}
export interface ManifestModuleGraph {
  readonly sources: ReadonlyMap<string, ManifestGraphFile>;
  readonly importers: ReadonlyMap<string, readonly string[]>;
  readonly imports?: ReadonlyMap<string, readonly ManifestGraphEdge[]> | undefined;
  readonly roots?: ReadonlySet<string> | undefined;
  readonly retained: ReadonlySet<string>;
  readonly rendered?: ReadonlyMap<string, string> | undefined;
}
export interface NodeManifestNormalization {
  readonly entries: readonly {
    readonly id: string;
    readonly filePath: string;
    readonly canonicalFilePath: string;
  }[];
  readonly distDir: string;
  readonly canonicalDistDir: string;
  readonly runtimeRootDir?: string;
}
export interface ManifestGraphInput {
  readonly distDir: string;
  readonly rootDir?: string;
  readonly entries?: readonly EntryModule[] | undefined;
  readonly runtimeManifest?: string | undefined;
  readonly instrumentation?: string | undefined;
  readonly analysisEntry?: string | undefined;
}
interface ProtectedModule {
  readonly id: string;
  readonly relative: string;
  readonly kind: ManifestProtectedKind;
}
interface SealedRoute {
  readonly kind: 'app-page' | 'app-route' | 'pages' | 'pages-api';
  readonly file: string;
  readonly page: string;
  readonly pathname: string;
}
interface RouteLocation {
  readonly relative: string;
  readonly app: boolean;
  readonly pages: boolean;
  readonly shared: boolean;
}

function turbopackKind(child: ProtectedModule, sha256: string): SealedRoute['kind'] | undefined {
  if (child.kind === APP_PAGE_FACTORY) {
    return child.relative === 'dist/build/templates/app-page-runtime.js' &&
      reviewedFrameworkSource(child.relative) === sha256
      ? 'app-page'
      : undefined;
  }
  return reviewedRouteConstructorSource(child.relative, sha256)?.kind;
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js client manifest ${reason}; refusing native publication`);
}
function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function sourceOf(graph: ManifestModuleGraph, id: string): ManifestGraphFile {
  const source = graph.sources.get(id);
  if (source === undefined) refuse('consumer source identity');
  return source;
}
async function checkedCode(source: ManifestGraphFile): Promise<string> {
  const info = await stat(source.file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) refuse('consumer source bounds');
  const bytes = await readFile(source.file);
  if (bytes.length !== info.size || digest(bytes) !== source.sha256)
    refuse('consumer source changed');
  return bytes.toString('utf8');
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
async function normalizationOf(input: ManifestGraphInput): Promise<NodeManifestNormalization> {
  if (input.entries === undefined || input.entries.length === 0)
    refuse('missing sealed entry inventory');
  const entries: NodeManifestNormalization['entries'][number][] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const entry of input.entries) {
    const canonicalFilePath = await realpath(entry.filePath);
    if (ids.has(entry.id) || paths.has(canonicalFilePath)) refuse('duplicate sealed route');
    ids.add(entry.id);
    paths.add(canonicalFilePath);
    entries.push(Object.freeze({ id: entry.id, filePath: entry.filePath, canonicalFilePath }));
  }
  const distDir = path.resolve(input.distDir);
  return Object.freeze({
    entries: Object.freeze(entries),
    distDir,
    canonicalDistDir: await realpath(distDir),
  });
}
function sealedRoutes(
  input: ManifestGraphInput,
  normalization: NodeManifestNormalization,
): ReadonlyMap<string, SealedRoute> {
  const metadata = metadataById(input);
  const app = path.join(normalization.canonicalDistDir, 'server', 'app');
  const pages = path.join(normalization.canonicalDistDir, 'server', 'pages');
  const routes = new Map<string, SealedRoute>();
  for (const entry of normalization.entries) {
    const location = routeLocation(entry.canonicalFilePath, app, pages);
    if (location === undefined) continue;
    const route = sealedRoute(entry, metadata.get(entry.id), location);
    if (route !== undefined) routes.set(entry.canonicalFilePath, route);
  }
  return routes;
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
  if (!relative?.endsWith('.js')) return undefined;
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
  return {
    kind,
    file: entry.canonicalFilePath,
    page: `/${location.relative.slice(0, -'.js'.length).split(path.sep).join('/')}`,
    pathname: entry.id,
  };
}
function generatedEntry(input: ManifestGraphInput): string {
  if (input.entries === undefined) return refuse('missing generated entry inputs');
  return [
    appEntrySource(input.entries, {
      external: true,
      runtimeDistDir: input.distDir,
      nodeRequestMeta: true,
    }),
    ...(input.instrumentation === undefined
      ? []
      : [`module.exports.instrumentation=()=>require(${jsLiteral(input.instrumentation)});`]),
  ].join('\n');
}
function incoming(graph: ManifestModuleGraph, id: string): readonly string[] {
  const importers = graph.importers.get(id);
  if (importers === undefined) return refuse('missing resolved consumer graph');
  const retained = importers.filter((importer) => graph.retained.has(importer));
  if (retained.length === 0) refuse('unclosed consumer chain');
  return retained;
}
function edgesTo(
  graph: ManifestModuleGraph,
  from: string,
  to: string,
): readonly ManifestGraphEdge[] {
  const edges = graph.imports?.get(from)?.filter((edge) => edge.target === to);
  if (edges === undefined || edges.length === 0) return refuse('missing resolved import identity');
  return edges;
}

class ConsumerGraph {
  private readonly input: ManifestGraphInput;
  private readonly graph: ManifestModuleGraph;
  private readonly root: string;
  private readonly routes: ReadonlyMap<string, SealedRoute>;
  private readonly files = new Map<string, ManifestGraphFile>();
  private readonly complete = new Set<string>();
  private readonly visiting = new Set<string>();
  private readonly pages = new Set<string>();
  private readonly compilerSources = new Map<string, ManifestGraphFile>();
  private readonly turbopackProducers = new Set<string>();
  private runtimeRoot: string | undefined;

  constructor(
    input: ManifestGraphInput,
    graph: ManifestModuleGraph,
    root: string,
    routes: ReadonlyMap<string, SealedRoute>,
  ) {
    this.input = input;
    this.graph = graph;
    this.root = root;
    this.routes = routes;
  }

  private terminal(parent: string, child: ProtectedModule, code: string): boolean {
    if (parent !== this.input.analysisEntry) return false;
    if (
      child.kind !== ROUTE_EXPORTS ||
      this.graph.roots?.has(parent) !== true ||
      code !== generatedEntry(this.input)
    )
      return refuse('unproved SDK entry terminal');
    const route = this.routes.get(sourceOf(this.graph, child.id).file);
    if (route === undefined) refuse('unsealed SDK route terminal');
    return true;
  }

  private async parent(
    parent: string,
    child: ProtectedModule,
  ): Promise<ProtectedModule | undefined> {
    edgesTo(this.graph, parent, child.id);
    const source = sourceOf(this.graph, parent);
    const code = await checkedCode(source);
    if (this.terminal(parent, child, code)) return undefined;
    const relative = path.relative(this.root, source.file).split(path.sep).join('/');
    const kind = frameworkParent(relative, child.relative);
    if (kind !== undefined) {
      if (reviewedFrameworkSource(relative) !== source.sha256) refuse('unknown or changed caller');
      this.files.set(source.file, source);
      return { id: parent, relative, kind };
    }
    if (child.kind === ROUTE_EXPORTS) return refuse('unknown consumer or export escape');
    const route = this.routes.get(source.file);
    if (route === undefined) {
      if (turbopackKind(child, sourceOf(this.graph, child.id).sha256) === undefined) {
        const caller = JSON.stringify(relative.slice(0, MAX_CALLER_LABEL_CHARACTERS));
        return refuse(
          `consumer is not a sealed route entry (${child.kind} ${child.relative} through ${caller})`,
        );
      }
      await this.turbopack(child);
      return undefined;
    }
    if (child.kind === APP_PAGE_FACTORY && route.kind === 'app-page') {
      this.appPage(parent, child, { source, code, route });
    } else if (
      route.kind !== 'app-page' &&
      turbopackKind(child, sourceOf(this.graph, child.id).sha256) === route.kind
    ) {
      await this.template(parent, { source, code, route });
    } else return refuse('unknown consumer or export escape');
    this.files.set(source.file, source);
    return { id: parent, relative: '', kind: ROUTE_EXPORTS };
  }

  private async turbopackSources(): Promise<readonly NodeManifestTurbopackGraphFile[]> {
    const sources: NodeManifestTurbopackGraphFile[] = [];
    for (const [id, source] of this.graph.sources) {
      const imports = this.graph.imports?.get(id);
      if (imports === undefined) refuse('missing original graph resolutions');
      const code = await checkedCode(source);
      sources.push({ id, file: source.file, source: { code, sha256: source.sha256 }, imports });
    }
    return sources;
  }

  private async turbopack(child: ProtectedModule): Promise<void> {
    if (this.turbopackProducers.has(child.id)) return;
    if (this.input.rootDir === undefined || !path.isAbsolute(this.input.rootDir))
      refuse('missing trusted compiler root');
    const rootDir = await realpath(this.input.rootDir);
    const distDir = await realpath(this.input.distDir);
    const sources = await this.turbopackSources();
    const producer = sourceOf(this.graph, child.id);
    const kind = turbopackKind(child, producer.sha256);
    if (kind === undefined) refuse('unknown projected route constructor');
    const entries = [...this.routes.values()].filter((route) => route.kind === kind);
    const producerKind = TURBOPACK_PRODUCER_KINDS[kind];
    const proof = await proveNodeManifestTurbopackConsumers({
      rootDir,
      distDir,
      sources,
      entries,
      producer: { id: child.id, file: producer.file, sha256: producer.sha256, kind: producerKind },
    });
    // The source helper's boot terminals are not proof terminals: every actual physical
    // importer must still reach the exact generated SDK entry's normalization contract.
    for (const terminal of proof.terminals) {
      await this.visit({ id: terminal.id, relative: '', kind: ROUTE_EXPORTS });
      if (kind === 'app-page') this.pages.add(terminal.page);
    }
    for (const source of proof.files) this.files.set(source.file, source);
    for (const entry of entries) {
      const own = sources.find((source) => source.file === entry.file);
      if (own === undefined) refuse('missing certified boot source');
      const boot = inspectNodeManifestTurbopackEntry(own.source);
      const targets = new Set(
        own.imports
          .filter((edge) => edge.specifier === boot.runtimeSpecifier)
          .map((edge) => edge.target),
      );
      if (targets.size !== 1) refuse('ambiguous certified runtime source');
      const target = targets.values().next().value;
      const runtime = sources.find((source) => source.id === target);
      if (runtime === undefined) refuse('missing certified runtime source');
      this.compilerSources.set(runtime.file, { file: runtime.file, sha256: runtime.source.sha256 });
    }
    this.runtimeRoot = rootDir;
    this.turbopackProducers.add(child.id);
  }

  private appPage(
    parent: string,
    child: ProtectedModule,
    context: {
      readonly source: ManifestGraphFile;
      readonly code: string;
      readonly route: SealedRoute;
    },
  ): void {
    const imported = sourceOf(this.graph, child.id);
    const imports: NodeManifestConsumerImport[] = edgesTo(this.graph, parent, child.id).map(
      (edge) => {
        return {
          specifier: edge.specifier,
          file: imported.file,
          sha256: imported.sha256,
          kind: APP_PAGE_FACTORY,
          exportName: 'createAppPageEntrypoint',
        };
      },
    );
    assertNodeManifestConsumer({
      source: { code: context.code, sha256: context.source.sha256 },
      imports,
      route: context.route,
    });
    this.pages.add(context.route.page);
  }

  private async template(
    parent: string,
    context: {
      readonly source: ManifestGraphFile;
      readonly code: string;
      readonly route: SealedRoute;
    },
  ): Promise<void> {
    const imports: NodeManifestTemplateImport[] = [];
    const edges = this.graph.imports?.get(parent);
    if (edges !== undefined) {
      for (const edge of edges) {
        const source = this.graph.sources.get(edge.target);
        if (source !== undefined) {
          await checkedCode(source);
          imports.push({ specifier: edge.specifier, file: source.file, sha256: source.sha256 });
        }
      }
    }
    const kind = context.route.kind;
    if (kind !== 'pages' && kind !== 'app-route' && kind !== 'pages-api')
      return refuse('unsealed template kind');
    await assertNodeManifestTemplateConsumer({
      source: { code: context.code, sha256: context.source.sha256 },
      imports,
      route: { kind, page: context.route.page, pathname: context.route.pathname },
    });
  }

  async visit(child: ProtectedModule): Promise<void> {
    if (this.complete.has(child.id)) return;
    if (this.visiting.has(child.id)) refuse('cyclic protected consumer chain');
    this.visiting.add(child.id);
    for (const parent of incoming(this.graph, child.id)) {
      const next = await this.parent(parent, child);
      if (next !== undefined) await this.visit(next);
    }
    this.visiting.delete(child.id);
    this.complete.add(child.id);
  }

  certifiedPages(): readonly string[] {
    return [...this.pages];
  }

  sources(): readonly ManifestGraphFile[] {
    return [...this.files.values()];
  }

  approvedCompilerSources(): readonly ManifestGraphFile[] {
    return [...this.compilerSources.values()];
  }

  runtimeRootDir(): string | undefined {
    return this.runtimeRoot;
  }
}

/** Every protected export must terminate at the exact generated, normalizing SDK route entry. */
export async function proveManifestConsumerGraph(
  input: ManifestGraphInput,
  graph: ManifestModuleGraph,
  evaluator: { readonly id: string; readonly root: string },
): Promise<{
  readonly files: readonly ManifestGraphFile[];
  readonly normalization: NodeManifestNormalization;
  readonly pages: readonly string[];
  readonly approvedCompilerSources: readonly ManifestGraphFile[];
}> {
  const normalization = await normalizationOf(input);
  const routes = sealedRoutes(input, normalization);
  const consumers = new ConsumerGraph(input, graph, evaluator.root, routes);
  await consumers.visit({ id: evaluator.id, relative: EVALUATOR, kind: 'evaluator' });
  const runtimeRootDir = consumers.runtimeRootDir();
  const sealedNormalization =
    runtimeRootDir === undefined
      ? normalization
      : Object.freeze({
          ...normalization,
          entries: Object.freeze(normalization.entries.map((entry) => Object.freeze({ ...entry }))),
          runtimeRootDir,
        });
  return {
    files: consumers.sources(),
    normalization: sealedNormalization,
    pages: consumers.certifiedPages(),
    approvedCompilerSources: consumers.approvedCompilerSources(),
  };
}
