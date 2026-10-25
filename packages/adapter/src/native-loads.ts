import { realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { Node } from '@oxc-project/types';
import type { OutputChunk, Plugin } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { nativeOperationGuards } from './dynamic-loads.ts';
import { entryOwnsImporter } from './native-addon-entries.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import { nativeLoaderBinary, UnreviewedNativeLoader } from './native-loaders.ts';

const MARKER = '__UPWIND_NATIVE_CAPABILITY__';
const CHILD_MARKER = '__UPWIND_NATIVE_WORKER_CHILD__';
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
export interface NativeLoad {
  readonly kind: 'direct' | 'dlopen' | 'bindings' | 'node-gyp-build';
  readonly importer: string;
  readonly binary: string;
  readonly owners: readonly string[];
  readonly esm?: true;
}

export class NativeFunctionRequired extends Error {
  readonly loads: readonly NativeLoad[];

  constructor(loads: readonly NativeLoad[]) {
    super('This Function requires a native Node.js runtime');
    this.name = 'NativeFunctionRequired';
    this.loads = loads;
  }
}

function nodes(node: Node): Node[] {
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) found.push(value);
  }
  return found;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function walk(node: Node): Node[] {
  const found: Node[] = [];
  const pending: Node[] = [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    found.push(at);
    for (const child of nodes(at)) pending.push(child);
  }
  return found;
}

function stringOf(node: Node | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function markerId(node: Extract<Node, { type: 'CallExpression' }>): string {
  const id = node.arguments.length === 1 ? stringOf(node.arguments[0]) : undefined;
  if (id === undefined) throw new AuditError('Malformed native capability marker');
  return id;
}

function identifier(node: Node | undefined, name: string): boolean {
  return node?.type === 'Identifier' && node.name === name;
}

/** Deliberately narrow: shadowed loader/global bindings are not native proof. */
function binds(tree: readonly Node[], name: string): boolean {
  return tree.some((node) => {
    if (node.type === 'VariableDeclarator')
      return walk(node.id).some((part) => identifier(part, name));
    if (node.type === 'CatchClause' && node.param !== null)
      return walk(node.param).some((part) => identifier(part, name));
    if (
      (node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'ClassExpression') &&
      identifier(node.id ?? undefined, name)
    )
      return true;
    if (
      node.type === 'ImportSpecifier' ||
      node.type === 'ImportDefaultSpecifier' ||
      node.type === 'ImportNamespaceSpecifier'
    )
      return identifier(node.local, name);
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      return node.params.some((param) => walk(param).some((part) => identifier(part, name)));
    }
    return false;
  });
}

function required(node: Node): string | undefined {
  return node.type === 'CallExpression' &&
    identifier(node.callee, 'require') &&
    node.arguments.length === 1
    ? stringOf(node.arguments[0])
    : undefined;
}

function workerModule(node: Node): boolean {
  return ['node:worker_threads', 'worker_threads'].includes(required(node) ?? '');
}

function unchangedBinding(tree: readonly Node[], name: string): boolean {
  return !tree.some((node) => {
    if (
      (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
      identifier(node.id ?? undefined, name)
    )
      return true;
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const value = node.type === 'AssignmentExpression' ? node.left : node.argument;
      return walk(value).some((part) => identifier(part, name));
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      return node.params.some((param) => walk(param).some((part) => identifier(part, name)));
    }
    return false;
  });
}

function unassignedIdentifier(tree: readonly Node[], name: string): boolean {
  return !tree.some((node) => {
    if (node.type !== 'AssignmentExpression' && node.type !== 'UpdateExpression') return false;
    const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
    return (
      target.type !== 'MemberExpression' && walk(target).some((part) => identifier(part, name))
    );
  });
}

/** Only the actual imported Node constructor, never a same-named application class. */
function nodeWorkerConstructor(callee: Node, tree: readonly Node[]): boolean {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const requireSafe = !binds(tree, 'require');
  for (const node of tree) {
    if (
      node.type === 'ImportDeclaration' &&
      ['node:worker_threads', 'worker_threads'].includes(String(node.source.value))
    ) {
      for (const specifier of node.specifiers) {
        if (
          specifier.type === 'ImportNamespaceSpecifier' ||
          specifier.type === 'ImportDefaultSpecifier'
        )
          namespaces.add(specifier.local.name);
        if (specifier.type === 'ImportSpecifier' && identifier(specifier.imported, 'Worker'))
          names.add(specifier.local.name);
      }
    }
    if (
      requireSafe &&
      node.type === 'VariableDeclarator' &&
      node.init !== null &&
      workerModule(node.init)
    ) {
      if (node.id.type === 'Identifier') namespaces.add(node.id.name);
      if (node.id.type === 'ObjectPattern') {
        for (const property of node.id.properties) {
          if (
            property.type === 'Property' &&
            identifier(property.key, 'Worker') &&
            property.value.type === 'Identifier'
          )
            names.add(property.value.name);
        }
      }
    }
  }
  if (callee.type === 'Identifier')
    return names.has(callee.name) && unchangedBinding(tree, callee.name);
  if (callee.type !== 'MemberExpression') return false;
  const property = callee.computed
    ? stringOf(callee.property)
    : callee.property.type === 'Identifier'
      ? callee.property.name
      : undefined;
  // An unknown computed constructor on the actual Node namespace could be Worker. It is not
  // native proof; the retained child marker refuses this unclassified graph before publication.
  if (property !== 'Worker' && !(callee.computed && property === undefined)) return false;
  if (callee.object.type === 'Identifier')
    return namespaces.has(callee.object.name) && unchangedBinding(tree, callee.object.name);
  return requireSafe && workerModule(callee.object);
}

async function ownedNativeFiles(
  importer: string,
  traces: readonly NativeAddonEntryTrace[],
): Promise<string[]> {
  const original = await realpath(importer);
  const files = new Set<string>();
  for (const trace of traces) {
    if (!(await entryOwnsImporter(trace, original))) continue;
    for (const file of Object.values(trace.assets))
      if (file.endsWith('.node')) files.add(await realpath(file));
  }
  return [...files];
}

function realPathBinding(tree: readonly Node[]): boolean {
  const bindings = tree.filter(
    (node) => node.type === 'VariableDeclarator' && identifier(node.id, 'path'),
  );
  if (bindings.length !== 1) return false;
  const binding = bindings[0];
  if (binding?.type !== 'VariableDeclarator' || binding.init === null) return false;
  if (!['path', 'node:path'].includes(required(binding.init) ?? '')) return false;
  return !tree.some((node) => {
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression') {
      const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
      return walk(target).some((part) => identifier(part, 'path'));
    }
    if (
      node.type === 'FunctionDeclaration' ||
      node.type === 'FunctionExpression' ||
      node.type === 'ArrowFunctionExpression'
    ) {
      return node.params.some((param) => walk(param).some((part) => identifier(part, 'path')));
    }
    return false;
  });
}

function nativePath(
  node: Node | undefined,
  importer: string,
  tree: readonly Node[],
): string | undefined {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  const { object, property, computed } = node.callee;
  if (
    !identifier(object, 'path') ||
    !realPathBinding(tree) ||
    computed ||
    property.type !== 'Identifier' ||
    !['join', 'resolve'].includes(property.name)
  )
    return undefined;
  if (!identifier(node.arguments[0], '__dirname')) return undefined;
  const parts = node.arguments.slice(1).map((part) => stringOf(part));
  if (parts.some((part) => part === undefined || path.isAbsolute(part))) return undefined;
  const tail = parts as string[];
  return property.name === 'join'
    ? path.join(path.dirname(importer), ...tail)
    : path.resolve(path.dirname(importer), ...tail);
}

async function ownedBinary(
  binary: string,
  importer: string,
  traces: readonly NativeAddonEntryTrace[],
): Promise<NativeLoad['owners']> {
  const actual = await realpath(binary);
  const original = await realpath(importer);
  const owners: string[] = [];
  for (const trace of traces) {
    const files = Object.values(trace.assets);
    if (!(await entryOwnsImporter(trace, original))) continue;
    for (const file of files) {
      if (file.endsWith('.node') && (await realpath(file)) === actual) {
        owners.push(trace.id);
        break;
      }
    }
  }
  if (owners.length === 0 || !(await stat(actual)).isFile()) {
    throw new AuditError(
      '@stayingupwind/adapter: a native load has no owned, regular-file binary in the route trace',
    );
  }
  return owners;
}

/**
 * An analysis-only marker survives exactly where the loader survives tree shaking. It never goes
 * into a published Worker or a Node artifact. Native modules remain real files in the latter.
 */
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
  function mark(load: NativeLoad | Error): string {
    const id = String(ordinal++);
    loads.set(id, load);
    return `${MARKER}(${JSON.stringify(id)})`;
  }
  return {
    plugin: {
      name: 'upwind-native-capabilities',
      async transform(source, importer) {
        if (
          !candidates ||
          !/\.(?:c|m)?js$/u.test(importer) ||
          !['bindings', 'node-gyp-build', 'dlopen', '.node', 'worker_threads'].some((word) =>
            source.includes(word),
          )
        )
          return null;
        if (Buffer.byteLength(source) > MAX_SOURCE_BYTES)
          throw new AuditError('native analysis source exceeds its limit');
        if (source.includes(MARKER) || source.includes(CHILD_MARKER))
          throw new AuditError('reserved native analysis marker appears in application source');
        const program = parseAst(source);
        const guards = nativeOperationGuards(program);
        const tree = walk(program);
        if (binds(tree, 'require') || !unassignedIdentifier(tree, 'require')) return null;
        const edits: { start: number; end: number; text: string }[] = [];
        for (const node of tree) {
          if (node.type === 'NewExpression' && nodeWorkerConstructor(node.callee, tree)) {
            const binaries = await ownedNativeFiles(importer, traces);
            if (binaries.length > 0) {
              const id = String(ordinal++);
              children.set(id, binaries);
              edits.push({
                start: node.callee.start,
                end: node.callee.end,
                text: `(${CHILD_MARKER}(${JSON.stringify(id)}),${source.slice(node.callee.start, node.callee.end)})`,
              });
            }
            continue;
          }
          if (
            node.type === 'ImportDeclaration' &&
            typeof node.source.value === 'string' &&
            node.source.value.endsWith('.node')
          ) {
            try {
              const binary = createRequire(importer).resolve(node.source.value);
              const owners = await ownedBinary(binary, importer, traces);
              const proof = mark({ kind: 'direct', importer, binary, owners, esm: true });
              const local = `__upwindNativeImport${ordinal}`;
              const declarations = node.specifiers.map((specifier) => {
                const member =
                  specifier.type === 'ImportSpecifier'
                    ? `[${JSON.stringify(specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value)}]`
                    : '';
                return `const ${specifier.local.name}=${local}${member};`;
              });
              edits.push({
                start: node.start,
                end: node.end,
                text: `const ${local}=${proof};${declarations.join('')}`,
              });
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              edits.push({ start: node.start, end: node.end, text: `${mark(error)};` });
            }
            continue;
          }
          if (node.type === 'ImportExpression' && stringOf(node.source)?.endsWith('.node')) {
            try {
              const binary = createRequire(importer).resolve(stringOf(node.source) ?? '');
              const owners = await ownedBinary(binary, importer, traces);
              edits.push({
                start: node.start,
                end: node.end,
                text: `Promise.resolve(${mark({ kind: 'direct', importer, binary, owners, esm: true })})`,
              });
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              edits.push({ start: node.start, end: node.end, text: mark(error) });
            }
            continue;
          }
          if (node.type !== 'CallExpression') continue;
          try {
            const direct = required(node);
            let kind: NativeLoad['kind'] | undefined;
            let binary: string | undefined;
            if (direct?.endsWith('.node')) {
              if (path.isAbsolute(direct))
                throw new AuditError('Absolute native imports are not relocatable');
              if (guards.has(node.start))
                throw new AuditError(
                  'A guarded native load has no proved Worker-safe representation',
                );
              kind = 'direct';
              binary = createRequire(importer).resolve(direct);
            } else if (node.callee.type === 'CallExpression') {
              const loader = required(node.callee);
              if (loader === 'bindings' || loader === 'node-gyp-build') {
                if (guards.has(node.start))
                  throw new AuditError(
                    'A guarded native loader is ambiguous; refusing automatic backend selection',
                  );
                kind = loader;
                const value = stringOf(node.arguments[0]);
                if (
                  node.arguments.length !== 1 ||
                  (loader === 'bindings' && value === undefined) ||
                  (loader === 'node-gyp-build' &&
                    (!identifier(node.arguments[0], '__dirname') || binds(tree, '__dirname')))
                )
                  throw new AuditError('Native loader requires a statically known argument');
                binary = await nativeLoaderBinary({
                  kind: loader,
                  value: value ?? '',
                  importer,
                  traces,
                });
              }
            } else if (
              node.callee.type === 'MemberExpression' &&
              identifier(node.callee.object, 'process') &&
              !node.callee.computed &&
              identifier(node.callee.property, 'dlopen') &&
              !binds(tree, 'process') &&
              unchangedBinding(tree, 'process')
            ) {
              // An unchanged operation whose failure is handled by the existing precise guard
              // remains on the old Worker path; its complete Worker graph still has to pass audit.
              if (guards.get(node.start) === 'plain') {
                if (options.nodeTarget === true)
                  throw new AuditError(
                    'A guarded process.dlopen is unclassified on the Node target',
                  );
                continue;
              }
              if (guards.has(node.start))
                throw new AuditError('A guarded process.dlopen has no proved Worker-safe fallback');
              if (
                node.arguments.length !== 2 ||
                !identifier(node.arguments[0], 'module') ||
                binds(tree, 'module') ||
                !unassignedIdentifier(tree, 'module') ||
                binds(tree, '__dirname') ||
                !unassignedIdentifier(tree, '__dirname')
              )
                throw new AuditError(
                  'custom process.dlopen flags, shadowed module objects or directories are unsupported',
                );
              kind = 'dlopen';
              binary = nativePath(node.arguments[1], importer, tree);
              if (binary === undefined || !binary.endsWith('.node'))
                throw new AuditError('process.dlopen has no statically known native binary');
            }
            if (kind === undefined || binary === undefined) continue;
            const owners = await ownedBinary(binary, importer, traces);
            edits.push({
              start: node.start,
              end: node.end,
              text: mark({ kind, importer, binary, owners }),
            });
          } catch (error) {
            // Do not rewrite an unknown loader. The unchanged strict audit still judges its
            // unresolved loads (including the existing, guarded optional-fallback rules).
            if (error instanceof UnreviewedNativeLoader) continue;
            if (!(error instanceof Error)) throw error;
            edits.push({ start: node.start, end: node.end, text: mark(error) });
          }
        }
        if (edits.length === 0) return null;
        let code = source;
        for (const edit of edits.toSorted((a, b) => b.start - a.start))
          code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
        return { code, moduleType: 'js' };
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
        const binaries = children.get(markerId(node));
        if (binaries === undefined) throw new AuditError('Unrecognized native child marker');
        throw new AuditError(
          'A retained Node Worker has unclassified owned native child dependencies',
        );
      }
      return retained;
    },
  };
}
