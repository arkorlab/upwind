import { realpath } from 'node:fs/promises';

import type { Node } from '@oxc-project/types';
import type { OutputChunk, Plugin } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { nativeOperationGuards } from './dynamic-loads.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { identifier, nativeBindings, stringOf, walk } from './native-ast.ts';
import type { NativeLoaderSource } from './native-loaders.ts';
import {
  isNativeOperation,
  nativeOperationEdit,
  type NativeEdit,
  type NativeOperationContext,
} from './native-operations.ts';
import { nativeSourceAnalysis } from './native-source-parser.ts';
import { nativeWorkerEdit } from './native-worker.ts';

const MARKER = '__UPWIND_NATIVE_CAPABILITY__';
const CHILD_MARKER = '__UPWIND_NATIVE_WORKER_CHILD__';
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_SOURCE_MIB = 32;
const MAX_SOURCE_BYTES = MAX_SOURCE_MIB * MIB;
const SOURCE_WORDS = ['bindings', 'node-gyp-build', 'process', 'dlopen', '.node', 'worker_threads'];
const RESERVED_MARKER = 'reserved native analysis marker appears in application source';

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

  constructor(loads: readonly NativeLoad[], options: ErrorOptions = {}) {
    super('This Function requires a native Node.js runtime', options);
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
    /\.[cm]?[jt]sx?$/u.test(importer) &&
    SOURCE_WORDS.some((word) => source.includes(word))
  );
}

function applyEdits(source: string, edits: readonly NativeEdit[]): string {
  let code = source;
  const ordered = edits.toSorted((a, b) => b.start - a.start);
  for (const edit of ordered) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

function assertMarkerIdentifiers(tree: readonly Node[]): void {
  if (
    tree.some((node) => {
      return (
        node.type === 'Identifier' &&
        (node.name.includes(MARKER) || node.name.includes(CHILD_MARKER))
      );
    })
  )
    throw new AuditError(RESERVED_MARKER);
}

async function collectEdits(
  tree: readonly Node[],
  context: NativeOperationContext,
  worker: Parameters<typeof nativeWorkerEdit>[1],
  local: () => string,
): Promise<NativeEdit[]> {
  const edits: NativeEdit[] = [];
  for (const node of tree) {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const child = await nativeWorkerEdit(node, worker);
      if (child !== undefined) {
        edits.push(child);
        continue;
      }
    }
    if (!isNativeOperation(node, context.bindings)) continue;
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
          throw new AuditError(RESERVED_MARKER);
        const analysis = nativeSourceAnalysis(source, importer, {
          target: options.nodeTarget === true ? 'node' : 'worker',
        });
        const program = analysis.program;
        const tree = walk(program);
        assertMarkerIdentifiers(tree);
        const bindings = nativeBindings(program);
        const context: NativeOperationContext = {
          importer,
          traces,
          bindings,
          guards: nativeOperationGuards(program),
          nodeTarget: options.nodeTarget === true,
          mark,
        };
        const worker = { source: analysis.code, importer, traces, tree, bindings, markChild };
        const edits = await collectEdits(
          tree,
          context,
          worker,
          () => `__upwindNativeImport${ordinal}`,
        );
        if (edits.length === 0) return null;
        return { code: applyEdits(analysis.code, edits), moduleType: 'js' };
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
        if (!children.has(markerId(node))) throw new AuditError('Unrecognized native child marker');
        throw new AuditError(
          'A retained Node Worker has unclassified owned native child dependencies',
        );
      }
      return retained;
    },
  };
}
