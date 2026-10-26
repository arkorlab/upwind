import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { NativeLoad } from './native-loads.ts';
import { assertNodeRelativeTopology } from './node-module-aliases.ts';
import type { NodePhysicalLayout } from './node-physical-layout.ts';

interface NativeAliasSources {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly originals: ReadonlyMap<string, string>;
}

function refuse(reason: string): never {
  throw new AuditError(`Node native binary alias ${reason}; refusing publication`);
}

function assertAvailableAlias(
  alias: string,
  target: string,
  sources: NativeAliasSources,
  links: ReadonlyMap<string, string>,
): void {
  for (const file of sources.files.keys())
    if (file === alias || file.startsWith(`${alias}/`) || alias.startsWith(`${file}/`))
      refuse('conflicts with a physical input');
  for (const [existing, destination] of links) {
    if (existing === alias && destination !== target) refuse('conflicts with an existing link');
    if (existing.startsWith(`${alias}/`)) refuse('conflicts with a descendant link');
    if (alias.startsWith(`${existing}/`)) {
      const relative = path.posix.relative(existing, alias);
      if (path.posix.join(destination, relative) !== target)
        refuse('conflicts with an ancestor link');
    }
  }
}

async function recordNativeAlias(
  load: NativeLoad,
  sources: NativeAliasSources,
  layout: NodePhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  if (load.kind !== 'dlopen') {
    if (load.binaryAlias !== undefined) refuse('is not a proved dlopen lookup');
    return;
  }
  const logical = load.binaryAlias ?? load.binary;
  if (!path.isAbsolute(logical)) refuse('requires an absolute proved filename');
  const target = await realpath(load.binary);
  if (load.binaryAlias !== undefined && target !== load.binary)
    refuse('has a changed canonical binary');
  if ((await realpath(logical)) !== target) refuse('has a changed physical target');
  if (logical === target) return;
  const importer = await realpath(load.importer);
  if (!sources.originals.has(target) || !sources.originals.has(importer))
    refuse('has no closed physical target or importer');
  assertNodeRelativeTopology(importer, logical, layout.nameOf);
  const alias = layout.nameOf(logical);
  const canonical = layout.nameOf(target);
  if (alias === canonical) return;
  assertAvailableAlias(alias, canonical, sources, links);
  links.set(alias, canonical);
}

/** Preserve only a proved dlopen's original lookup; no binary is added to the closed input set. */
export async function nodeNativeAliases(
  loads: readonly NativeLoad[],
  sources: NativeAliasSources,
  layout: NodePhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  for (const load of loads) await recordNativeAlias(load, sources, layout, links);
}
