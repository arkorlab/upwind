import { realpath } from 'node:fs/promises';

import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';

import { AuditError } from './dependencies.ts';
import { nativeOperationGuards } from './dynamic-loads.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { nativeBindings } from './native-ast.ts';
import { ownedNativeFiles } from './native-ownership.ts';
import { renderedWorkerRequires } from './native-worker-requires.ts';
import { retainedWorkerCapabilityNodes } from './native-worker.ts';

function nativeTraceFiles(trace: NativeAddonEntryTrace): ReadonlySet<string> {
  const files = new Set(trace.importers);
  for (const file of Object.values(trace.assets)) files.add(file);
  return files;
}

async function retainedNativeSource(
  chunk: OutputChunk,
  traces: readonly NativeAddonEntryTrace[],
): Promise<boolean> {
  for (const trace of traces) {
    if (Object.values(trace.assets).every((file) => !file.endsWith('.node'))) continue;
    const files = nativeTraceFiles(trace);
    for (const file of files) {
      if (file.endsWith('.node')) continue;
      const canonical = await realpath(file);
      const retained = chunk.modules[canonical] ?? chunk.modules[file];
      if (retained === undefined || retained.code === null) continue;
      if ((await ownedNativeFiles(canonical, [trace])).length > 0) return true;
    }
  }
  return false;
}

/** A native asset alone is insufficient: an owning physical source must still be retained. */
export async function assertRetainedNativeWorkerCapability(
  chunk: OutputChunk,
  program: Node,
  tree: readonly Node[],
  options: { readonly traces: readonly NativeAddonEntryTrace[]; readonly nodeTarget: boolean },
): Promise<void> {
  if (!(await retainedNativeSource(chunk, options.traces))) return;
  if (program.type !== 'Program') throw new AuditError('Invalid retained native Worker program');
  const bindings = nativeBindings(program);
  const guards = options.nodeTarget ? undefined : nativeOperationGuards(program);
  if (
    retainedWorkerCapabilityNodes(
      tree,
      bindings,
      renderedWorkerRequires(chunk, tree, bindings),
      guards,
    ).length > 0
  )
    throw new AuditError('A retained Node Worker has unclassified owned native child dependencies');
}
