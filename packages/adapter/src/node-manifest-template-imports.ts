import { isBuiltin } from 'node:module';

import { AuditError } from './dependencies.ts';
import type { NodeManifestCoalescedImport } from './node-manifest-coalesced-pages.ts';
import {
  certifyNodeManifestTemplateHelperImport,
  type NodeManifestTemplateHelperOwner,
} from './node-manifest-template-helpers.ts';
import type { NodeManifestTemplateImport } from './node-manifest-templates.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';

interface ImportInput {
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly target: (id: string) => string;
  readonly helper?:
    | {
        readonly owner: NodeManifestTemplateHelperOwner;
        readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
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
      });
}
function resolved(input: ImportInput): readonly NodeManifestCoalescedImport[] {
  const imports = new Map<string, NodeManifestCoalescedImport>();
  for (const edge of input.factory.imports) {
    const target = input.target(edge.target);
    const source = input.sources.find((candidate) => candidate.id === target);
    let imported: NodeManifestCoalescedImport;
    if (isBuiltin(target)) imported = { specifier: edge.specifier, builtin: target };
    else {
      if (source === undefined) return refuse('unproved route template import identity');
      imported = { specifier: edge.specifier, file: source.file, sha256: source.source.sha256 };
      const helper = helperImport(input, edge, source);
      if (helper !== undefined) imported = { ...imported, helper };
    }
    const previous = imports.get(edge.specifier);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(imported))
      refuse('ambiguous route template import');
    imports.set(edge.specifier, imported);
  }
  return [...imports.values()];
}

export function nodeManifestTemplateImports(
  input: ImportInput,
): readonly NodeManifestTemplateImport[] {
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
