import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf } from './lexical-scope.ts';
import { identifier } from './node-manifest-consumer-ast.ts';
import {
  nodeManifestRuntimeCallerSources,
  type NodeManifestRuntimeCallers,
} from './node-manifest-runtime-callers.ts';
import {
  inspectNodeManifestTurbopackEntry,
  nodeManifestTurbopackBootGraph,
  nodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFile,
  type NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';
import { assertNodeManifestTurbopackRuntime } from './node-manifest-turbopack-runtime.ts';

export interface NodeManifestRuntimeProfile {
  readonly file: string;
  readonly pathname: string;
  readonly kind: 'app-page' | 'pages' | 'app-route' | 'pages-api';
  readonly assetPrefix?: string | undefined;
}
interface RuntimeIdentity {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly assetPrefix: string;
  readonly imports: string;
}
interface BootIdentity {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly runtimeId: string;
  readonly imports: string;
}
interface LookupEdge {
  readonly source: string;
  readonly target: string;
  readonly specifier: string;
}
export interface NodeManifestRuntimeCohort {
  readonly runtimes: readonly RuntimeIdentity[];
  /** Owned callers only; these are not protected route or normalization terminals. */
  readonly boots: readonly BootIdentity[];
  readonly lookupEdges: readonly LookupEdge[];
}
const CERTIFIED = new WeakSet<NodeManifestRuntimeCohort>();
const PROFILE_KINDS = new Set(['app-page', 'app-route', 'pages', 'pages-api']);

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js runtime cohort ${reason}; refusing native publication`);
}
function checkedSource(source: NodeManifestTurbopackGraphFile): void {
  if (createHash('sha256').update(source.source.code).digest('hex') !== source.source.sha256)
    refuse('source identity');
}
function sourcesById(sources: readonly NodeManifestTurbopackGraphFile[]) {
  const result = new Map<string, NodeManifestTurbopackGraphFile>();
  const files = new Set<string>();
  for (const source of sources) {
    checkedSource(source);
    if (!path.isAbsolute(source.file) || result.has(source.id) || files.has(source.file))
      refuse('ambiguous physical source');
    result.set(source.id, source);
    files.add(source.file);
  }
  return result;
}
function strictBootDirective(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'ExpressionStatement') return false;
  const expression = value['expression'];
  return (
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === value.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
  );
}

/** Recognize only an inventory-owned candidate; full boot grammar is checked separately. */
function bootCandidate(source: NodeManifestTurbopackGraphFile): boolean {
  const program: unknown = parseAst(source.source.code);
  if (!isNode(program)) return false;
  const statements = listOf(program, 'body');
  const first = statements[strictBootDirective(statements[0]) ? 1 : 0];
  if (!isNode(first) || first.type !== 'VariableDeclaration') return false;
  const declaration = listOf(first, 'declarations')[0];
  if (!isNode(declaration)) return false;
  const init = declaration['init'];
  if (!isNode(init) || init.type !== 'CallExpression') return false;
  const required = init['callee'];
  return (
    isNode(required) &&
    required.type === 'CallExpression' &&
    identifier(required['callee']) &&
    required['callee'].name === 'require'
  );
}
function profileFor(
  caller: NodeManifestRuntimeCallers['callers'][number],
  profiles: readonly NodeManifestRuntimeProfile[],
): NodeManifestRuntimeProfile {
  const matching = profiles.filter((profile) => {
    return (
      (caller.role === 'input-entry' ? profile.file === caller.file : profile.kind === 'pages') &&
      caller.ownerIds.includes(profile.pathname)
    );
  });
  const profile = matching[0];
  if (profile === undefined) return refuse('unsealed boot producer profile');
  if (!PROFILE_KINDS.has(profile.kind)) refuse('unknown boot producer profile');
  if (
    matching.some(
      (other) => other.kind !== profile.kind || other.assetPrefix !== profile.assetPrefix,
    )
  )
    refuse('ambiguous boot producer profile');
  return profile;
}
function runtimeFor(
  source: NodeManifestTurbopackGraphFile,
  specifier: string,
  sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): NodeManifestTurbopackGraphFile {
  const edges = source.imports.filter((edge) => edge.specifier === specifier);
  const only = edges[0];
  if (only === undefined || edges.length !== 1) return refuse('actual runtime edge');
  const runtime = sources.get(only.target);
  return runtime ?? refuse('missing runtime source');
}
function lookupEdges(
  runtimes: ReadonlyMap<string, RuntimeIdentity>,
  sources: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): readonly LookupEdge[] {
  const edges: LookupEdge[] = [];
  for (const runtime of runtimes.values()) {
    const source = sources.get(runtime.id);
    if (source === undefined) refuse('missing reviewed runtime');
    for (const edge of source.imports) {
      if (edge.target === runtime.id || !runtimes.has(edge.target) || isBuiltin(edge.target))
        continue;
      const target = sources.get(edge.target);
      // The fixed graph linker writes absolute literal requires in its chunk switch. The
      // original body is fully sealed above; no arbitrary source gains this lookup role.
      if (
        target === undefined ||
        !path.isAbsolute(edge.specifier) ||
        edge.specifier !== target.file
      )
        refuse('unproved cross-runtime lookup edge');
      edges.push(
        Object.freeze({ source: runtime.id, target: edge.target, specifier: edge.specifier }),
      );
    }
  }
  return Object.freeze(edges);
}

/** Sealed owned runtime identities must be known before any factory-table interpretation. */
export function certifyNodeManifestRuntimeCohort(input: {
  readonly inventory: NodeManifestRuntimeCallers;
  readonly profiles: readonly NodeManifestRuntimeProfile[];
  readonly requiredBoots: readonly string[];
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly rootDir: string;
  readonly distDir: string;
}): NodeManifestRuntimeCohort {
  const callers = nodeManifestRuntimeCallerSources(input.inventory, input.sources);
  const sources = sourcesById(input.sources);
  const boots: BootIdentity[] = [];
  const runtimes = new Map<string, RuntimeIdentity>();
  for (const caller of callers) {
    const source = sources.get(caller.id);
    if (source === undefined) refuse('missing caller source');
    if (!input.requiredBoots.includes(source.file) && !bootCandidate(source)) continue;
    const boot = inspectNodeManifestTurbopackEntry(source.source);
    if (path.resolve(input.distDir, boot.publicPath) !== source.file) refuse('boot public path');
    const profile = profileFor(caller, input.profiles);
    const runtime = runtimeFor(source, boot.runtimeSpecifier, sources);
    const proof = assertNodeManifestTurbopackRuntime({
      source: runtime.source,
      file: runtime.file,
      rootDir: input.rootDir,
      distDir: input.distDir,
      ...(profile.assetPrefix !== undefined && { assetPrefix: profile.assetPrefix }),
    });
    const identity = {
      id: runtime.id,
      file: runtime.file,
      sha256: runtime.source.sha256,
      assetPrefix: proof.assetPrefix,
      imports: JSON.stringify(runtime.imports),
    };
    const previous = runtimes.get(runtime.id);
    if (previous !== undefined && previous.assetPrefix !== identity.assetPrefix)
      refuse('conflicting runtime producer profiles');
    runtimes.set(runtime.id, Object.freeze(identity));
    boots.push(
      Object.freeze({
        id: source.id,
        file: source.file,
        sha256: source.source.sha256,
        runtimeId: runtime.id,
        imports: JSON.stringify(source.imports),
      }),
    );
  }
  if (input.requiredBoots.some((file) => boots.every((boot) => boot.file !== file)))
    refuse('unowned required route boot');
  const cohort = Object.freeze({
    runtimes: Object.freeze([...runtimes.values()]),
    boots: Object.freeze(boots),
    lookupEdges: lookupEdges(runtimes, sources),
  });
  CERTIFIED.add(cohort);
  return cohort;
}

export function nodeManifestRuntimeCohortSources(
  cohort: NodeManifestRuntimeCohort,
  sources: readonly NodeManifestTurbopackGraphFile[],
): readonly RuntimeIdentity[] {
  if (!CERTIFIED.has(cohort)) refuse('uncertified cohort');
  for (const identities of [cohort.runtimes, cohort.boots]) {
    for (const identity of identities) {
      const source = sources.find((candidate) => candidate.id === identity.id);
      if (
        source?.file !== identity.file ||
        source.source.sha256 !== identity.sha256 ||
        JSON.stringify(source.imports) !== identity.imports
      )
        refuse('cohort source binding');
      checkedSource(source);
    }
  }
  return cohort.runtimes;
}

function assertProtectedProfiles(
  entries: readonly NodeManifestTurbopackSealedEntry[],
  profiles: readonly NodeManifestRuntimeProfile[],
  assetPrefix = '/',
): void {
  for (const entry of entries) {
    const matching = profiles.filter(
      (profile) => profile.file === entry.file && profile.pathname === entry.pathname,
    );
    const profile = matching[0];
    if (
      profile === undefined ||
      matching.length !== 1 ||
      profile.kind !== (entry.kind ?? 'app-page') ||
      (profile.assetPrefix ?? '/') !== assetPrefix
    )
      refuse('protected runtime producer profile');
  }
}

export function nodeManifestRuntimeCohortLookup(
  cohort: NodeManifestRuntimeCohort,
  source: string,
  edge: NodeManifestTurbopackGraphFile['imports'][number],
): boolean {
  if (!CERTIFIED.has(cohort)) refuse('uncertified cohort');
  return cohort.lookupEdges.some(
    (known) =>
      known.source === source && known.target === edge.target && known.specifier === edge.specifier,
  );
}

/** Generic owned boot graphs carry no route/normalization terminal authority. */
export function prepareNodeManifestRuntimeGraphs(input: {
  readonly inventory?: NodeManifestRuntimeCallers | undefined;
  readonly profiles?: readonly NodeManifestRuntimeProfile[] | undefined;
  readonly entries: readonly NodeManifestTurbopackSealedEntry[];
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly rootDir: string;
  readonly distDir: string;
  readonly assetPrefix?: string | undefined;
}): {
  readonly cohort: NodeManifestRuntimeCohort | undefined;
  readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  readonly allGraphs: readonly NodeManifestTurbopackBootGraph[];
} {
  let cohort: NodeManifestRuntimeCohort | undefined;
  if (input.profiles !== undefined) {
    if (input.inventory === undefined) refuse('missing owned caller inventory');
    assertProtectedProfiles(input.entries, input.profiles, input.assetPrefix);
    cohort = certifyNodeManifestRuntimeCohort({
      ...input,
      inventory: input.inventory,
      profiles: input.profiles,
      requiredBoots: input.entries.map((entry) => entry.file),
    });
  }
  const graphs = input.entries.map((entry) =>
    nodeManifestTurbopackEntryGraph({ ...input, entry, runtimeCohort: cohort }),
  );
  const protectedFiles = new Set(graphs.map((graph) => graph.entry.file));
  const other =
    cohort?.boots
      .filter((boot) => !protectedFiles.has(boot.file))
      .map((boot) =>
        nodeManifestTurbopackBootGraph({ ...input, file: boot.file, runtimeCohort: cohort }),
      ) ?? [];
  if (cohort === undefined) {
    for (const graph of graphs)
      assertNodeManifestTurbopackRuntime({
        source: graph.runtime.source,
        file: graph.runtime.file,
        distDir: input.distDir,
        rootDir: input.rootDir,
        ...(input.assetPrefix !== undefined && { assetPrefix: input.assetPrefix }),
      });
  }
  return { cohort, graphs, allGraphs: [...graphs, ...other] };
}
