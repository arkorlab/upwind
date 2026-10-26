import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import { dynamicNodeClosureRefusal } from './node-closure-proof.ts';
import { COALESCED_NAMESPACE, coalescedPagesSource } from './node-manifest-coalesced-source.ts';
import {
  EVALUATOR,
  manifestConstructorImport,
  reviewedFrameworkSource,
} from './node-manifest-framework.ts';
import {
  nodeManifestPagesConjunctionIdentity,
  type NodeManifestPagesConjunctionImport,
} from './node-manifest-pages-conjunction-walk.ts';
import type {
  NodeManifestTemplateHelperOwner,
  NodeManifestTemplateHelperImport,
} from './node-manifest-template-helpers.ts';
import { assertTurbopackCacheOwners } from './node-manifest-turbopack-cache.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

const PROFILE = Symbol('coalesced Pages inspection profile');
export interface NodeManifestCoalescedPagesProfile {
  readonly [PROFILE]: boolean;
}
export type NodeManifestCoalescedImport =
  | NodeManifestPagesConjunctionImport
  | {
      readonly specifier: string;
      readonly file: string;
      readonly sha256: string;
      readonly helper?: NodeManifestTemplateHelperImport | undefined;
    }
  | { readonly specifier: string; readonly builtin: string };
interface NodeManifestCoalescedPagesInput {
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graph: NodeManifestTurbopackBootGraph;
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly helperOwner?: NodeManifestTemplateHelperOwner | undefined;
  readonly imports: readonly NodeManifestCoalescedImport[];
  readonly route: { readonly kind: 'pages'; readonly page: string; readonly pathname: string };
}
interface StoredProfile {
  readonly input: NodeManifestCoalescedPagesInput;
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graphObject: NodeManifestTurbopackBootGraph;
  readonly factoryObject: NodeManifestTurbopackGraphFactory;
  readonly source: string;
  readonly graph: string;
  readonly imports: string;
  readonly route: string;
}
const PROFILES = new WeakMap<NodeManifestCoalescedPagesProfile, StoredProfile>();

function refuse(reason: string): never {
  throw new AuditError(`Unproved coalesced Pages profile ${reason}; refusing native publication`);
}
function graphIdentity(input: NodeManifestCoalescedPagesInput): string {
  const digests = new Map<string, string>();
  function digest(code: string): string {
    let hashed = digests.get(code);
    if (hashed === undefined) {
      hashed = createHash('sha256').update(code).digest('hex');
      digests.set(code, hashed);
    }
    return hashed;
  }
  return JSON.stringify({
    physicalId: input.graph.physicalId,
    runtime: {
      id: input.graph.runtimeId,
      sha256: input.graph.runtime.source.sha256,
      actual: digest(input.graph.runtime.source.code),
    },
    factories: input.graph.factories.map((factory) => {
      return {
        id: factory.id,
        physicalId: factory.physicalId,
        moduleId: factory.projection.moduleId,
        source: factory.projection.original.sha256,
        actual: digest(factory.projection.original.code),
        registration: factory.projection.factory,
        imports: factory.imports,
        cache: factory.projection.cacheInitializers,
        bound: factory.projection.boundRuntimeInputs,
      };
    }),
  });
}
function privilegedImports(input: NodeManifestCoalescedPagesInput): ReadonlySet<string> {
  const identities = input.imports.flatMap<{ readonly root: string; readonly module: string }>(
    (entry) => {
      if ('builtin' in entry) return [];
      if ('conjunction' in entry) {
        const identity = nodeManifestPagesConjunctionIdentity(entry, {
          owner: input.helperOwner,
          projection: input.factory.projection,
        });
        return [{ ...identity, kind: 'pages' as const }];
      }
      const identity = manifestConstructorImport(entry.file, entry.sha256);
      return identity?.kind === 'pages' ? [identity] : [];
    },
  );
  const primary = identities[0];
  if (primary === undefined || identities.length !== 1) return refuse('pinned constructor root');
  const result = new Set<string>();
  for (const imported of input.imports) {
    if ('builtin' in imported) continue;
    if ('conjunction' in imported) {
      nodeManifestPagesConjunctionIdentity(imported, {
        owner: input.helperOwner,
        projection: input.factory.projection,
      });
      result.add(imported.specifier);
      continue;
    }
    // Refusal only: another installed/copy root must not conceal a known privileged producer.
    const normalized = imported.file.replaceAll('\\', '/');
    const start = normalized.lastIndexOf('/dist/');
    const relative = start === -1 ? undefined : normalized.slice(start + 1);
    if (
      relative === EVALUATOR ||
      (relative !== undefined && reviewedFrameworkSource(relative) !== undefined)
    )
      result.add(imported.specifier);
  }
  return result;
}
function originalProjection(
  input: NodeManifestCoalescedPagesInput,
): NodeManifestTurbopackProjection {
  const supplied = input.factory.projection;
  const original = projectNodeManifestTurbopackFactory(
    supplied.original,
    supplied.moduleId,
    'dependencies',
  );
  if (JSON.stringify(original) !== JSON.stringify(supplied))
    return refuse('original dependency projection');
  if (original.boundRuntimeInputs.length > 0) return refuse('bound runtime input');
  const own = input.graph.factories.find((factory) => factory.id === input.factory.id);
  if (own !== input.factory) return refuse('actual graph factory identity');
  const registered = new Set(input.graph.factories.map((factory) => factory.projection.moduleId));
  assertTurbopackCacheOwners(
    input.graph.factories.map((factory) => {
      const physical = { id: factory.physicalId };
      return { physical, projection: factory.projection };
    }),
    registered,
  );
  for (const imported of original.imports) {
    if (input.imports.filter((entry) => entry.specifier === imported.specifier).length !== 1)
      return refuse('actual import inventory');
  }
  for (const imported of input.imports) {
    if (original.imports.every((entry) => entry.specifier !== imported.specifier))
      return refuse('extra import descriptor');
  }
  const failure = dynamicNodeClosureRefusal(
    'upwind-coalesced-original-inspection.js',
    `(()=>{\n${original.source.code}\n});`,
  );
  if (failure !== undefined) return refuse(`original inspection has ${failure}`);
  return original;
}
function derive(input: NodeManifestCoalescedPagesInput) {
  const original = originalProjection(input);
  const code = coalescedPagesSource(original, privilegedImports(input));
  // This source is explicitly an inert derived registration, never a physical file or its SHA.
  const source = { code, sha256: createHash('sha256').update(code).digest('hex') };
  const projection = projectNodeManifestTurbopackFactory(source, original.moduleId);
  return { raw: original, inspectionSource: source, projection, namespace: COALESCED_NAMESPACE };
}

/** A private profile is provisional inspection data; it grants no compiler or caller exemption. */
export function certifyNodeManifestCoalescedPages(
  input: NodeManifestCoalescedPagesInput,
): NodeManifestCoalescedPagesProfile {
  originalProjection(input);
  const profile = Object.freeze({ [PROFILE]: true });
  PROFILES.set(profile, {
    input,
    owner: input.owner,
    graphObject: input.graph,
    factoryObject: input.factory,
    source: JSON.stringify(input.factory.projection),
    graph: graphIdentity(input),
    imports: JSON.stringify(input.imports),
    route: JSON.stringify(input.route),
  });
  return profile;
}

export function nodeManifestCoalescedPagesInspection(
  profile: NodeManifestCoalescedPagesProfile,
  owner: NodeManifestTurbopackConsumerInput,
  raw: NodeManifestTurbopackProjection,
  route: NodeManifestCoalescedPagesInput['route'],
): ReturnType<typeof derive> {
  const stored = PROFILES.get(profile);
  if (
    stored?.owner !== owner ||
    stored.input.owner !== stored.owner ||
    stored.input.graph !== stored.graphObject ||
    stored.input.factory !== stored.factoryObject ||
    stored.source !== JSON.stringify(raw) ||
    stored.source !== JSON.stringify(stored.input.factory.projection) ||
    stored.graph !== graphIdentity(stored.input) ||
    stored.imports !== JSON.stringify(stored.input.imports) ||
    stored.route !== JSON.stringify(route) ||
    stored.route !== JSON.stringify(stored.input.route)
  )
    return refuse('copied, stale or cross-batch identity');
  return derive(stored.input);
}
