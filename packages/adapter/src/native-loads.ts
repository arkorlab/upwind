import { realpath } from 'node:fs/promises';

import type { Node } from '@oxc-project/types';
import type { OutputChunk, Plugin } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { nativeOperationGuards } from './dynamic-loads.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { binds, identifier, stringOf, unassignedIdentifier, walk } from './native-ast.ts';
import type { NativeLoaderSource } from './native-loaders.ts';
import {
  isNativeOperation,
  nativeOperationEdit,
  type NativeEdit,
  type NativeOperationContext,
} from './native-operations.ts';
import { nativeWorkerEdit } from './native-worker.ts';

const MARKER = '__UPWIND_NATIVE_CAPABILITY__';
const CHILD_MARKER = '__UPWIND_NATIVE_WORKER_CHILD__';
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_SOURCE_BYTES = 32 * MIB;

export interface NativeLoad {
  readonly kind: 'direct' | 'dlopen' | 'bindings' | 'node-gyp-build';
  readonly importer: string;
  readonly binary: string;
  readonly owners: readonly string[];
  readonly esm?: true;
  readonly loaderSources?: readonly NativeLoaderSource[] | undefined;
}

export class NativeFunctionRequiredError extends Error {
  readonly loads: readonly NativeLoad[];

  constructor(loads: readonly NativeLoad[]) {
    super('This Function requires a native Node.js runtime');
    this.name = 'NativeFunctionRequiredError';
    this.loads = loads;
  }
}

function markerId(node: Extract<Node, { type: 'CallExpression' }>): string {
  const id = node.arguments.length === 1 ? stringOf(node.arguments[0]) : undefined;
  if (id === undefined) throw new AuditError('Malformed native capability marker');
  return id;
}

function canAnalyze(candidates: boolean, source: string, importer: string): boolean {
  return (
    candidates &&
    /\.(?:c|m)?js$/u.test(importer) &&
    ['bindings', 'node-gyp-build', 'dlopen', '.node', 'worker_threads'].some((word) =>
      source.includes(word),
    )
  );
}

function applyEdits(source: string, edits: readonly NativeEdit[]): string {
  let code = source;
  const ordered = edits.toSorted((a, b) => b.start - a.start);
  for (const edit of ordered) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

async function collectEdits(
  tree: readonly Node[],
  context: NativeOperationContext,
  worker: Parameters<typeof nativeWorkerEdit>[1],
  local: () => string,
): Promise<NativeEdit[]> {
  const edits: NativeEdit[] = [];
  for (const node of tree) {
    if (node.type === 'NewExpression') {
      const child = await nativeWorkerEdit(node, worker);
      if (child !== undefined) edits.push(child);
      continue;
    }
    if (!isNativeOperation(node)) continue;
    const edit = await nativeOperationEdit(node, context, local);
    if (edit !== undefined) edits.push(edit);
  }
  return edits;
}

/** Analysis-only markers never enter a published Worker or the physical Node artifact. */
export function nativeLoadsPlugin(
  traces: readonly NativeAddonEntryTrace[],
  options: { readonly nodeTarget?: boolean } = {},
): {
  readonly plugin: Plugin;
  retained(chunk: OutputChunk): Promise<readonly NativeLoad[]>;
} {
  const candidates = traces.some((trace) =>
    Object.values(trace.assets).some((file) => file.endsWith('.node')),
  );
  const loads = new Map<string, NativeLoad | Error>();
  const children = new Map<string, readonly string[]>();
  let ordinal = 0;
  function nextId(): string {
    const id = String(ordinal);
    ordinal += 1;
    return id;
  }
  function mark(load: NativeLoad | Error): string {
    const id = nextId();
    loads.set(id, load);
    return `${MARKER}(${JSON.stringify(id)})`;
  }
  function markChild(binaries: readonly string[]): string {
    const id = nextId();
    children.set(id, binaries);
    return `${CHILD_MARKER}(${JSON.stringify(id)})`;
  }
  return {
    plugin: {
      name: 'upwind-native-capabilities',
      async transform(source, importer) {
        if (!canAnalyze(candidates, source, importer)) return null;
        if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
          throw new AuditError('native analysis source exceeds its limit');
        if (source.includes(MARKER) || source.includes(CHILD_MARKER))
          throw new AuditError('reserved native analysis marker appears in application source');
        const program = parseAst(source);
        const tree = walk(program);
        if (binds(tree, 'require') || !unassignedIdentifier(tree, 'require')) return null;
        const context: NativeOperationContext = {
          importer,
          traces,
          tree,
          guards: nativeOperationGuards(program),
          nodeTarget: options.nodeTarget === true,
          mark,
        };
        const worker = { source, importer, traces, tree, markChild };
        const edits = await collectEdits(
          tree,
          context,
          worker,
          () => `__upwindNativeImport${ordinal}`,
        );
        return edits.length === 0 ? null : { code: applyEdits(source, edits), moduleType: 'js' };
      },
    },
    async retained(chunk) {
      const tree = walk(parseAst(chunk.code));
      const ids = new Set(
        tree.flatMap((node) => {
          if (node.type !== 'CallExpression' || !identifier(node.callee, MARKER)) return [];
          return [markerId(node)];
        }),
      );
      const retained = await Promise.all(
        [...ids].map(async (id) => {
          const load = loads.get(id);
          if (load === undefined) throw new AuditError('unrecognized native capability marker');
          if (load instanceof Error) throw load;
          return { ...load, binary: await realpath(load.binary) };
        }),
      );
      for (const node of tree) {
        if (node.type !== 'CallExpression' || !identifier(node.callee, CHILD_MARKER)) continue;
        if (children.get(markerId(node)) === undefined)
          throw new AuditError('Unrecognized native child marker');
        throw new AuditError(
          'A retained Node Worker has unclassified owned native child dependencies',
        );
      }
      return retained;
    },
  };
}
