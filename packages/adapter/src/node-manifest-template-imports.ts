import { isBuiltin } from 'node:module';

import { AuditError } from './dependencies.ts';
import type { NodeManifestCoalescedImport } from './node-manifest-coalesced-pages.ts';
import type { NodeManifestHandlerContext } from './node-manifest-handler-context.ts';
import type { NodeManifestPagesConjunctionImport } from './node-manifest-pages-conjunction-walk.ts';
import {
  certifyNodeManifestTemplateHelperImport,
  type NodeManifestTemplateHelperOwner,
} from './node-manifest-template-helpers.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackTemplateImport } from './node-manifest-turbopack-template-import.ts';

interface ImportInput {
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly target: (
    id: string,
    edge: { readonly specifier: string; readonly target: string },
  ) => string | NodeManifestPagesConjunctionImport;
  readonly helper?:
    | {
        readonly owner: NodeManifestTemplateHelperOwner;
        readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
        readonly handlerContext?: NodeManifestHandlerContext | undefined;
      }
    | undefined;
}
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain ${reason}; refusing native publication`,
  );
}
function helperImport(
  input: ImportInput,
  edge: { readonly specifier: string; readonly target: string },
  source: NodeManifestTurbopackGraphFile,
) {
  if (input.helper === undefined) return;
  const selected = input.helper.factories.get(edge.target);
  return selected === undefined
    ? undefined
    : certifyNodeManifestTemplateHelperImport({
        owner: input.helper.owner,
        consumer: input.factory,
        target: selected,
        physical: source,
        specifier: edge.specifier,
        handlerContext: input.helper.handlerContext,
      });
}
function resolvedImport(
  input: ImportInput,
  edge: { readonly specifier: string; readonly target: string },
): NodeManifestCoalescedImport {
  const target = input.target(edge.target, edge);
  if (typeof target !== 'string') return target;
  if (isBuiltin(target)) return { specifier: edge.specifier, builtin: target };
  const source = input.sources.find((candidate) => candidate.id === target);
  if (source === undefined) return refuse('unproved route template import identity');
  const imported = { specifier: edge.specifier, file: source.file, sha256: source.source.sha256 };
  const helper = helperImport(input, edge, source);
  return helper === undefined ? imported : { ...imported, helper };
}
function resolved(input: ImportInput): readonly NodeManifestCoalescedImport[] {
  const imports = new Map<string, NodeManifestCoalescedImport>();
  for (const edge of input.factory.imports) {
    const imported = resolvedImport(input, edge);
    const previous = imports.get(edge.specifier);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(imported))
      refuse('ambiguous route template import');
    imports.set(edge.specifier, imported);
  }
  return [...imports.values()];
}

export function nodeManifestTemplateImports(
  input: ImportInput,
): readonly NodeManifestTurbopackTemplateImport[] {
  return resolved(input).map((entry) => {
    if ('builtin' in entry) return refuse('unproved route template import identity');
    return entry;
  });
}
export function nodeManifestCoalescedImports(
  input: ImportInput,
): readonly NodeManifestCoalescedImport[] {
  return resolved(input);
}
