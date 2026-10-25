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
  assertNodeManifestTemplateConsumer,
  type NodeManifestTemplateImport,
} from './node-manifest-templates.ts';

const MAX_SOURCE_MEBIBYTES = 128;
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
const ROUTE_CLASS = 'route-class';
const APP_PAGE_FACTORY = 'app-page-factory';
const ENTRYPOINTS = 'entrypoints';
const OPAQUE_ROUTE_METADATA = 'opaque route metadata';
const APP_PAGE_RUNTIME = 'dist/build/templates/app-page-runtime.js';
const APP_PAGE_MODULE = 'dist/server/route-modules/app-page/module.compiled.js';
const APP_PAGE_SOURCE = 'dist/server/route-modules/app-page/module.js';
const ROUTE_MODULE = 'dist/server/route-modules/route-module.js';
const PAGES_MODULE = 'dist/server/route-modules/pages/module.compiled.js';
const PAGES_SOURCE = 'dist/server/route-modules/pages/module.js';
const APP_ROUTE_MODULE = 'dist/server/route-modules/app-route/module.compiled.js';
const APP_ROUTE_SOURCE = 'dist/server/route-modules/app-route/module.js';
const PAGES_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/pages-turbo.runtime.prod.js',
    '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1',
  ],
  [
    'dist/compiled/next-server/pages.runtime.prod.js',
    '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
  ],
]);
const ROUTE_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/app-route-experimental.runtime.prod.js',
    '356d9c9be870fac47a341221841c76341c37a17eb038d6151e22a0788f87a906',
  ],
  [
    'dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js',
    '4755bc19f3115dc66c2e818cf7cee5c0979a6821a5fec9513beb808cebe8a0bc',
  ],
  [
    'dist/compiled/next-server/app-route-turbo.runtime.prod.js',
    '4010a14b45b58154eaf01034845c5003de0f7c3945657e9d84290fe66ea3d41c',
  ],
  [
    'dist/compiled/next-server/app-route.runtime.prod.js',
    'ff6aea920fbe3a9a4cf4179b0bc80bf20127136754cd9225586edb77f96dc254',
  ],
]);
const EVALUATOR = 'dist/server/load-manifest.external.js';
const LOAD_COMPONENTS = 'dist/server/load-components.js';
const APP_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/app-page-experimental.runtime.prod.js',
    '2974a9e688b53a8b9bf61ea8535f1b70f4fb4154fc60c64a231d337f556d99c7',
  ],
  [
    'dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js',
    'd0d80c2b545d96bfdebb2a3d5100c368a18a0757db211eba55abf977e37ee23f',
  ],
  [
    'dist/compiled/next-server/app-page-turbo.runtime.prod.js',
    '914353e0cf478e617e8a3b408fa74d9f526e9c338c8bda817cc05f05bfcce7a5',
  ],
  [
    'dist/compiled/next-server/app-page.runtime.prod.js',
    '9f24cd66e38f57c3144cbc456fe0f52853836d6218f449f54abba8e8c17c3921',
  ],
]);
// Exact published next@16.4.3 sources, from its integrity-verified registry package.
const REVIEWED: ReadonlyMap<string, string> = new Map([
  ...APP_RUNTIMES,
  ...PAGES_RUNTIMES,
  ...ROUTE_RUNTIMES,
  [APP_PAGE_MODULE, '3b55f56f8c70bbadffdacea23a1c19689c3889bab7e78da6c8121ada787bfe99'],
  [APP_PAGE_RUNTIME, '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b'],
  [APP_PAGE_SOURCE, '0d658c55994938d4ffe32bbddb4e6009513248e1659e90e248d33bf3a98e0eed'],
  [APP_ROUTE_MODULE, 'aeab4882c08e62a742aa67daa0d4a434b3330f389c38ffdf4262b6143c80b5ed'],
  [APP_ROUTE_SOURCE, '9f9ae9defd45e773888c948e844d7a401ca79ff5c09f14211c4abd9b725e3b1b'],
  [LOAD_COMPONENTS, '47e1446da77172ba77d6f3e6f68ae00ca7bebda206b26c0ba8625d41915dcaed'],
  [PAGES_MODULE, 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f'],
  [PAGES_SOURCE, 'fc0ccc89c288c9426a39ae38af43e96bd14958e8a37ab79de2bca31a893dd29a'],
  [ROUTE_MODULE, '2f1de319c06e89b9adda0365a655e8fc6b23ec0fa424a0ea9d513b6d814a1865'],
]);

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
}
export interface ManifestGraphInput {
  readonly distDir: string;
  readonly entries?: readonly EntryModule[] | undefined;
  readonly runtimeManifest?: string | undefined;
  readonly instrumentation?: string | undefined;
  readonly analysisEntry?: string | undefined;
}
interface ProtectedModule {
  readonly id: string;
  readonly relative: string;
  readonly kind: 'evaluator' | typeof ROUTE_CLASS | typeof APP_PAGE_FACTORY | 'route-exports';
}
interface SealedRoute {
  readonly kind: 'app-page' | 'app-route' | 'pages';
  readonly file: string;
  readonly page: string;
  readonly pathname: string;
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
  const metadata = metadataEntries(input);
  const ids = new Set<unknown>();
  for (const entry of metadata) {
    if (typeof entry['id'] !== 'string' || ids.has(entry['id'])) refuse('ambiguous route metadata');
    ids.add(entry['id']);
  }
  const app = path.join(normalization.canonicalDistDir, 'server', 'app');
  const pages = path.join(normalization.canonicalDistDir, 'server', 'pages');
  const routes = new Map<string, SealedRoute>();
  for (const entry of normalization.entries) {
    const appRelative = beneath(app, entry.canonicalFilePath);
    const pagesRelative = beneath(pages, entry.canonicalFilePath);
    const relative = appRelative ?? pagesRelative;
    if (relative === undefined || !relative.endsWith('.js')) continue;
    const metadataEntry = metadata.find((candidate) => candidate['id'] === entry.id);
    // Shared Pages _app/_document inputs still belong to the normalization seal, but are not
    // route constructors. They can never terminate a protected route export chain.
    if (
      metadataEntry === undefined &&
      pagesRelative !== undefined &&
      ['_app.js', '_document.js'].includes(pagesRelative)
    )
      continue;
    if (
      metadataEntry === undefined ||
      metadataEntry['pathname'] !== entry.id ||
      metadataEntry['runtime'] !== undefined
    )
      refuse('unsealed app route metadata');
    const kind = metadataEntry['kind'];
    const appKind = kind === 'app-page' || kind === 'app-route';
    if (
      (appRelative !== undefined && !appKind) ||
      (pagesRelative !== undefined && kind !== 'pages' && kind !== 'pages-api')
    )
      refuse('unsealed route kind');
    // The fixed PagesAPI template has no routeModule export, so the SDK cannot normalize it.
    if (kind === 'pages-api') continue;
    if (kind !== 'app-page' && kind !== 'app-route' && kind !== 'pages')
      refuse('unsealed route kind');
    routes.set(entry.canonicalFilePath, {
      kind,
      file: entry.canonicalFilePath,
      page: `/${relative.slice(0, -'.js'.length).split(path.sep).join('/')}`,
      pathname: entry.id,
    });
  }
  return routes;
}
function generatedEntry(input: ManifestGraphInput): string {
  if (input.entries === undefined) return refuse('missing generated entry inputs');
  return [
    appEntrySource(input.entries, { external: false, runtimeDistDir: input.distDir }),
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
function frameworkParent(parent: string, child: string): ProtectedModule['kind'] | undefined {
  if (
    child === EVALUATOR &&
    (parent === ROUTE_MODULE ||
      APP_RUNTIMES.has(parent) ||
      PAGES_RUNTIMES.has(parent) ||
      ROUTE_RUNTIMES.has(parent))
  )
    return ROUTE_CLASS;
  if (child === EVALUATOR && parent === LOAD_COMPONENTS) return 'evaluator';
  if (parent === APP_PAGE_MODULE && APP_RUNTIMES.has(child)) return ROUTE_CLASS;
  if (child === ROUTE_MODULE && parent === APP_PAGE_SOURCE) return ROUTE_CLASS;
  if (child === APP_PAGE_SOURCE && parent === APP_PAGE_MODULE) return ROUTE_CLASS;
  if (child === APP_PAGE_MODULE && parent === APP_PAGE_RUNTIME) return APP_PAGE_FACTORY;
  if (parent === PAGES_MODULE && PAGES_RUNTIMES.has(child)) return ROUTE_CLASS;
  if (parent === APP_ROUTE_MODULE && ROUTE_RUNTIMES.has(child)) return ROUTE_CLASS;
  if (child === ROUTE_MODULE && (parent === PAGES_SOURCE || parent === APP_ROUTE_SOURCE))
    return ROUTE_CLASS;
  if (
    (child === PAGES_SOURCE && parent === PAGES_MODULE) ||
    (child === APP_ROUTE_SOURCE && parent === APP_ROUTE_MODULE)
  )
    return ROUTE_CLASS;
  return undefined;
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
      child.kind !== 'route-exports' ||
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
      if (REVIEWED.get(relative) !== source.sha256) refuse('unknown or changed caller');
      this.files.set(source.file, source);
      return { id: parent, relative, kind };
    }
    if (child.kind === 'route-exports') return refuse('unknown consumer or export escape');
    const route = this.routes.get(source.file);
    if (route === undefined) return refuse('consumer is not a sealed route entry');
    if (child.kind === APP_PAGE_FACTORY && route.kind === 'app-page') {
      this.appPage(parent, child, { source, code, route });
    } else if (child.relative === PAGES_MODULE && route.kind === 'pages') {
      await this.template(parent, { source, code, route });
    } else if (child.relative === APP_ROUTE_MODULE && route.kind === 'app-route') {
      await this.template(parent, { source, code, route });
    } else return refuse('unknown consumer or export escape');
    this.files.set(source.file, source);
    return { id: parent, relative: '', kind: 'route-exports' };
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
    for (const edge of this.graph.imports?.get(parent) ?? []) {
      const source = this.graph.sources.get(edge.target);
      if (source !== undefined) {
        await checkedCode(source);
        imports.push({ specifier: edge.specifier, file: source.file, sha256: source.sha256 });
      }
    }
    const kind = context.route.kind;
    if (kind !== 'pages' && kind !== 'app-route') return refuse('unsealed template kind');
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
}> {
  const normalization = await normalizationOf(input);
  const routes = sealedRoutes(input, normalization);
  const consumers = new ConsumerGraph(input, graph, evaluator.root, routes);
  await consumers.visit({ id: evaluator.id, relative: EVALUATOR, kind: 'evaluator' });
  return { files: consumers.sources(), normalization, pages: consumers.certifiedPages() };
}
