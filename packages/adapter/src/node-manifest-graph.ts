import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { EntryModule } from './function.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { manifestRuntimeAssetPrefix } from './node-asset-prefix.ts';
import {
  assertNodeManifestBoundBatch,
  commitNodeManifestBoundStage,
  createNodeManifestBoundBatch,
} from './node-manifest-bound-batch.ts';
import type { NodeManifestCompilerRootBinding } from './node-manifest-compiler-root.ts';
import {
  assertNodeManifestConsumer,
  type NodeManifestConsumerImport,
} from './node-manifest-consumers.ts';
import {
  APP_PAGE_FACTORY,
  APP_PAGE_CLASS,
  EVALUATOR,
  frameworkParent,
  reviewedFrameworkSource,
  reviewedRouteConstructorSource,
  ROUTE_CLASS,
  ROUTE_EXPORTS,
  type ManifestProtectedKind,
} from './node-manifest-framework.ts';
import { commitNodeManifestHandlerMetadata } from './node-manifest-handler-metadata.ts';
import { type NodeManifestNormalization } from './node-manifest-normalization.ts';
import type { SealedRoute } from './node-manifest-routes.ts';
import { certifyNodeManifestRuntimeCallers } from './node-manifest-runtime-callers.ts';
import type { NodeManifestRuntimeProfile } from './node-manifest-runtime-cohort.ts';
import {
  prepareNodeManifestSdkTerminalScope,
  certifyNodeManifestSdkTerminal,
  type NodeManifestSdkTerminalProof,
  type NodeManifestSdkTerminalScope,
} from './node-manifest-sdk-terminal.ts';
import {
  completedNodeRouteRewriteApproval,
  type NodeRouteRewriteApproval,
} from './node-route-rewrite-approval.ts';
export type { NodeManifestNormalization } from './node-manifest-normalization.ts';
import { commitNodeManifestPagesConjunctionStage } from './node-manifest-pages-conjunction-walk.ts';
import {
  assertNodeManifestTemplateConsumer,
  type NodeManifestTemplateImport,
} from './node-manifest-templates.ts';
import { proveNodeManifestTurbopackConsumers } from './node-manifest-turbopack-consumers.ts';
import { type NodeManifestTurbopackGraphFile } from './node-manifest-turbopack-graph.ts';

const MAX_SOURCE_MEBIBYTES = 128;
const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_CALLER_LABEL_CHARACTERS = 240;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
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
/** Exact class sources whose entire consumer chain reached the controlled Node entry. */
export interface ManifestRouteSource extends ManifestGraphFile {
  readonly root: string;
  readonly relative: string;
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
export interface ManifestGraphInput {
  readonly distDir: string;
  readonly rootDir?: string;
  readonly clientAssetPrefix?: string | undefined;
  readonly entries?: readonly EntryModule[] | undefined;
  readonly entryTraces?: readonly NativeAddonEntryTrace[] | undefined;
  readonly runtimeManifest?: string | undefined;
  readonly instrumentation?: string | undefined;
  readonly analysisEntry?: string | undefined;
  readonly compilerRootBinding?: NodeManifestCompilerRootBinding | undefined;
}
interface ProtectedModule {
  readonly id: string;
  readonly relative: string;
  readonly kind: ManifestProtectedKind;
}
function turbopackKind(child: ProtectedModule, sha256: string): SealedRoute['kind'] | undefined {
  // Class authority remains a distinct role until a whole fixed producer body is certified.
  if (child.kind === APP_PAGE_CLASS)
    return reviewedFrameworkSource(child.relative) === sha256 ? 'app-page' : undefined;
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
  private readonly normalization: NodeManifestNormalization;
  private readonly files = new Map<string, ManifestGraphFile>();
  private readonly complete = new Set<string>();
  private readonly visiting = new Set<string>();
  private readonly pages = new Set<string>();
  private readonly compilerSources = new Map<string, ManifestGraphFile>();
  private readonly routeSources = new Map<string, ManifestRouteSource>();
  private readonly turbopackProducers = new Set<string>();
  private readonly boundBatch = createNodeManifestBoundBatch();
  private readonly sdkScope: NodeManifestSdkTerminalScope;
  private readonly sdkTerminals = new Map<string, NodeManifestSdkTerminalProof>();
  private runtimeRoot: string | undefined;
  readonly helperMetadata = new Map<string, ManifestGraphFile>();

  constructor(
    input: ManifestGraphInput,
    graph: ManifestModuleGraph,
    root: string,
    sealed: {
      readonly routes: ReadonlyMap<string, SealedRoute>;
      readonly normalization: NodeManifestNormalization;
      readonly sdkScope: NodeManifestSdkTerminalScope;
    },
  ) {
    this.input = input;
    this.graph = graph;
    this.root = root;
    this.routes = sealed.routes;
    this.normalization = sealed.normalization;
    this.sdkScope = sealed.sdkScope;
  }

  private async parent(
    parent: string,
    child: ProtectedModule,
  ): Promise<ProtectedModule | undefined> {
    edgesTo(this.graph, parent, child.id);
    const source = sourceOf(this.graph, parent);
    const terminal = await certifyNodeManifestSdkTerminal(this.sdkScope, parent, child);
    if (terminal !== undefined) {
      this.sdkTerminals.set(child.id, terminal);
      return undefined;
    }
    const code = await checkedCode(source);
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

  private runtimeProfiles(): readonly NodeManifestRuntimeProfile[] {
    const profiles = new Map<string, NodeManifestRuntimeProfile>();
    const logical = this.normalization.entries.flatMap((entry) => {
      const route = this.routes.get(entry.canonicalFilePath);
      return route === undefined ? [] : [{ ...route, pathname: entry.id }];
    });
    const routes = [...this.routes.values()];
    for (const route of logical) routes.push(route);
    for (const route of routes) {
      const key = JSON.stringify([route.file, route.pathname]);
      profiles.set(key, {
        file: route.file,
        pathname: route.pathname,
        kind: route.kind,
        assetPrefix: manifestRuntimeAssetPrefix(this.input.clientAssetPrefix, route.kind),
      });
    }
    return [...profiles.values()];
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
    const producerKind =
      child.kind === APP_PAGE_CLASS ? APP_PAGE_CLASS : TURBOPACK_PRODUCER_KINDS[kind];
    const runtimeCallers = await certifyNodeManifestRuntimeCallers({
      rootDir: this.input.rootDir,
      distDir,
      entries: this.normalization.entries,
      routes: this.normalization.entries.flatMap((entry) => {
        const route = this.routes.get(entry.canonicalFilePath);
        return route === undefined
          ? []
          : [{ kind: route.kind, file: route.file, pathname: entry.id }];
      }),
      entryTraces: this.input.entryTraces ?? [],
      sources,
      retained: this.graph.retained,
    });
    const proof = await proveNodeManifestTurbopackConsumers({
      rootDir,
      distDir,
      assetPrefix: manifestRuntimeAssetPrefix(this.input.clientAssetPrefix, kind),
      sources,
      entries,
      runtimeCallers,
      boundBatch: this.boundBatch,
      runtimeProfiles: this.runtimeProfiles(),
      sdkTerminalScope: this.sdkScope,
      compilerRootBinding: this.input.compilerRootBinding,
      producer: { id: child.id, file: producer.file, sha256: producer.sha256, kind: producerKind },
    });
    // The source helper's boot terminals are not proof terminals: every actual physical
    // importer must still reach the exact generated SDK entry's normalization contract.
    for (const terminal of proof.terminals) {
      await this.visit({ id: terminal.id, relative: '', kind: ROUTE_EXPORTS });
      if (kind === 'app-page') this.pages.add(terminal.page);
    }
    if (proof.boundStage === undefined) refuse('missing bound proof stage');
    commitNodeManifestBoundStage(this.boundBatch, proof.boundStage);
    const terminalCertificates = proof.terminals.map((terminal) => {
      const certificate = this.sdkTerminals.get(terminal.id);
      return certificate ?? refuse('missing actual SDK terminal certificate');
    });
    await commitNodeManifestPagesConjunctionStage(proof, terminalCertificates);
    const helperMetadata = await commitNodeManifestHandlerMetadata(proof, terminalCertificates);
    for (const source of proof.files) this.files.set(source.file, source);
    for (const source of helperMetadata) this.helperMetadata.set(source.file, source);
    for (const runtime of proof.compilerSources) this.compilerSources.set(runtime.file, runtime);
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
      route: {
        kind,
        page: context.route.page,
        pathname: context.route.pathname,
        definition: context.route.definition,
      },
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
    if (child.kind === ROUTE_CLASS || child.kind === APP_PAGE_CLASS) {
      const source = sourceOf(this.graph, child.id);
      if (reviewedFrameworkSource(child.relative) !== source.sha256)
        refuse('changed completed route source');
      this.routeSources.set(
        source.file,
        Object.freeze({ ...source, root: this.root, relative: child.relative }),
      );
    }
  }

  certifiedPages(): readonly string[] {
    return [...this.pages];
  }

  assertBoundProofs(): void {
    assertNodeManifestBoundBatch(this.boundBatch);
  }

  sources(): readonly ManifestGraphFile[] {
    return [...this.files.values()];
  }

  approvedCompilerSources(): readonly ManifestGraphFile[] {
    return [...this.compilerSources.values()];
  }

  approvedRouteSources(): readonly ManifestRouteSource[] {
    return Object.freeze([...this.routeSources.values()]);
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
  readonly approvedRouteSources: readonly ManifestRouteSource[];
  readonly routeRewriteApproval: NodeRouteRewriteApproval;
  readonly metadataFiles: readonly ManifestGraphFile[];
}> {
  const {
    scope: sdkScope,
    normalization,
    sealed,
  } = await prepareNodeManifestSdkTerminalScope(input, graph);
  const routes = sealed.routes;
  const consumers = new ConsumerGraph(input, graph, evaluator.root, {
    routes,
    normalization,
    sdkScope,
  });
  await consumers.visit({ id: evaluator.id, relative: EVALUATOR, kind: 'evaluator' });
  consumers.assertBoundProofs();
  const runtimeRootDir = consumers.runtimeRootDir();
  const sealedNormalization =
    runtimeRootDir === undefined
      ? normalization
      : Object.freeze({
          ...normalization,
          entries: Object.freeze(normalization.entries.map((entry) => Object.freeze({ ...entry }))),
          runtimeRootDir,
        });
  const finalNormalization =
    sealed.files.length === 0 && consumers.helperMetadata.size === 0
      ? sealedNormalization
      : Object.freeze({
          ...sealedNormalization,
          metadataFiles: Object.freeze([...sealed.files, ...consumers.helperMetadata.values()]),
        });
  return {
    files: consumers.sources(),
    metadataFiles: finalNormalization.metadataFiles ?? [],
    normalization: finalNormalization,
    pages: consumers.certifiedPages(),
    approvedCompilerSources: consumers.approvedCompilerSources(),
    approvedRouteSources: consumers.approvedRouteSources(),
    routeRewriteApproval: completedNodeRouteRewriteApproval({
      graph,
      context: input,
      normalization: finalNormalization,
      routes: consumers.approvedRouteSources(),
    }),
  };
}
