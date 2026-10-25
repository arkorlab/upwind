import { realpath } from 'node:fs/promises';

import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';

import { AuditError } from './dependencies.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { nativeBindings } from './native-ast.ts';
import { ownedNativeFiles } from './native-ownership.ts';
import { renderedWorkerRequires } from './native-worker-requires.ts';
import { hasRetainedWorkerCapability } from './native-worker.ts';

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
  traces: readonly NativeAddonEntryTrace[],
): Promise<void> {
  const bindings = nativeBindings(program);
  if (
    hasRetainedWorkerCapability(tree, bindings, renderedWorkerRequires(chunk, tree, bindings)) &&
    (await retainedNativeSource(chunk, traces))
  )
    throw new AuditError('A retained Node Worker has unclassified owned native child dependencies');
}
