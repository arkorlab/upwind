import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { declaration, identifier, propertyName, type Visit } from './node-manifest-consumer-ast.ts';
import {
  defaultExportTarget,
  turbopackModuleId,
  turbopackModuleSpecifier,
} from './node-manifest-turbopack-values.ts';
import type {
  NodeManifestTurbopackModuleId,
  NodeManifestTurbopackAsyncLoader,
  NodeManifestTurbopackImport,
  NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

interface AsyncProjectionInput {
  readonly body: Node;
  readonly visits: readonly Visit[];
  readonly context: { readonly name: string; readonly scope: Scope };
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly factoryIds: readonly NodeManifestTurbopackModuleId[];
}
interface NodeManifestAsyncProjection {
  readonly loader?: NodeManifestTurbopackAsyncLoader;
  readonly targetId: NodeManifestTurbopackModuleId;
  readonly targetCall: Node;
  readonly members: readonly Node[];
  readonly references: readonly Node[];
}
const MAX_CHUNK_PATH_BYTES = 16_384;
const MIN_PATH_CODE_POINT = 32;
const DELETE_CODE_POINT = 127;
const CHUNK_FIELDS = new Set(['excluded', 'included', 'moduleChunks', 'path']);

function ownBinding(
  value: unknown,
  visit: Visit,
  binding: { readonly name: string; readonly scope: Scope },
): value is Node {
  if (!identifier(value) || value.name !== binding.name) return false;
  const scope = visit.scopes.findLast((candidate) => candidate.declared.has(binding.name));
  return scope === binding.scope && !scope.bindings.has(binding.name);
}

function member(value: unknown, name: string): value is Node {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['optional'] !== true &&
    value['computed'] !== true &&
    propertyName(value) === name
  );
}

function call(value: unknown, arity: number): value is Node {
  return (
    isNode(value) &&
    value.type === 'CallExpression' &&
    value['optional'] !== true &&
    listOf(value, 'arguments').length === arity
  );
}

function returned(
  fn: unknown,
  arity: number,
): { readonly node: Node; readonly value: Node } | undefined {
  if (
    !isNode(fn) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(fn.type) ||
    fn['async'] === true ||
    fn['generator'] === true ||
    (fn['id'] !== null && fn['id'] !== undefined) ||
    listOf(fn, 'params').length !== arity ||
    listOf(fn, 'params').some((param) => !identifier(param))
  )
    return undefined;
  let value = fn['body'];
  if (isNode(value) && value.type === 'BlockStatement') {
    const statements = listOf(value, 'body');
    const only = statements[0];
    if (statements.length !== 1 || !isNode(only) || only.type !== 'ReturnStatement')
      return undefined;
    value = only['argument'];
  }
  return isNode(value) ? { node: fn, value } : undefined;
}

function pathLiteral(value: unknown): string | undefined {
  if (!isNode(value) || value.type !== 'Literal' || typeof value['value'] !== 'string')
    return undefined;
  const text = value['value'];
  return text.length > 0 &&
    Buffer.byteLength(text) <= MAX_CHUNK_PATH_BYTES &&
    !/[\\?#]/u.test(text) &&
    [...text].every((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= MIN_PATH_CODE_POINT && point !== DELETE_CODE_POINT;
    }) &&
    text.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
    ? text
    : undefined;
}

function literalArray(value: unknown, kind: 'path' | 'id'): boolean {
  return (
    isNode(value) &&
    value.type === 'ArrayExpression' &&
    listOf(value, 'elements').length > 0 &&
    listOf(value, 'elements').every(
      (item) => (kind === 'path' ? pathLiteral(item) : turbopackModuleId(item)) !== undefined,
    )
  );
}

function chunkProperty(
  property: unknown,
): { readonly name: string; readonly value: unknown } | undefined {
  if (
    !isNode(property) ||
    property.type !== 'Property' ||
    property['kind'] !== 'init' ||
    property['method'] === true ||
    property['shorthand'] === true ||
    property['computed'] === true
  )
    return undefined;
  const name = propertyName(property);
  return name === undefined || !CHUNK_FIELDS.has(name)
    ? undefined
    : { name, value: property['value'] };
}

function javascriptPath(value: unknown): string | undefined {
  const file = pathLiteral(value);
  return file?.endsWith('.js') === true ? file : undefined;
}

function chunkPath(value: unknown): string | undefined {
  const simple = pathLiteral(value);
  if (simple !== undefined) return simple.endsWith('.js') ? simple : undefined;
  if (!isNode(value) || value.type !== 'ObjectExpression') return undefined;
  const properties = listOf(value, 'properties');
  if (properties.length < 2) return undefined;
  const names = new Set<string>();
  let file: string | undefined;
  for (const property of properties) {
    const parsed = chunkProperty(property);
    if (parsed === undefined || names.has(parsed.name)) return undefined;
    const { name, value: data } = parsed;
    names.add(name);
    if (name === 'path') {
      file = javascriptPath(data);
    } else if (!literalArray(data, name === 'moduleChunks' ? 'path' : 'id')) return undefined;
  }
  return file;
}

function fnBinding(
  fn: Node,
  visits: readonly Visit[],
): { readonly name: string; readonly scope: Scope } | undefined {
  const param = listOf(fn, 'params')[0];
  const scope = visits.find((visit) => visit.node === fn)?.scopes.at(-1);
  return scope !== undefined && identifier(param) && !scope.bindings.has(param.name)
    ? { name: param.name, scope }
    : undefined;
}

interface LiteralLoads {
  readonly chunks: readonly string[];
  readonly members: readonly Node[];
  readonly references: readonly Node[];
}

function mappedLoads(value: unknown, input: AsyncProjectionInput): LiteralLoads | undefined {
  if (!call(value, 1) || !member(value['callee'], 'map')) return undefined;
  const values = value['callee']['object'];
  if (!isNode(values) || values.type !== 'ArrayExpression') return undefined;
  const chunks = listOf(values, 'elements').map((item) => chunkPath(item));
  if (chunks.includes(undefined)) return undefined;
  const mapper = returned(listOf(value, 'arguments')[0], 1);
  if (mapper === undefined || !call(mapper.value, 1) || !member(mapper.value['callee'], 'l'))
    return undefined;
  const bound = fnBinding(mapper.node, input.visits);
  const visit = input.visits.find((item) => item.node === mapper.value);
  const required = mapper.value['callee'];
  if (
    bound === undefined ||
    visit === undefined ||
    !ownBinding(required['object'], visit, input.context) ||
    !ownBinding(listOf(mapper.value, 'arguments')[0], visit, bound)
  )
    return undefined;
  return {
    chunks: Object.freeze(chunks.filter((item) => item !== undefined)),
    members: Object.freeze([required]),
    references: Object.freeze([required['object']]),
  };
}

function promiseLoads(value: unknown, input: AsyncProjectionInput): LiteralLoads | undefined {
  if (!isNode(value) || value.type !== 'CallExpression') return undefined;
  const callee = value['callee'];
  const visit = input.visits.find((item) => item.node === value);
  if (
    visit === undefined ||
    !isNode(callee) ||
    !identifier(callee['object']) ||
    callee['object'].name !== 'Promise' ||
    declaration('Promise', visit.scopes) !== undefined
  )
    return undefined;
  if (member(callee, 'resolve') && call(value, 0))
    return { chunks: Object.freeze([]), members: Object.freeze([]), references: Object.freeze([]) };
  return member(callee, 'all') && call(value, 1)
    ? mappedLoads(listOf(value, 'arguments')[0], input)
    : undefined;
}

function terminalImport(
  loader: Node,
  value: Node,
  input: AsyncProjectionInput,
): { readonly targetId: NodeManifestTurbopackModuleId; readonly targetCall: Node } | undefined {
  const continuation = returned(listOf(value, 'arguments')[0], 0);
  const bound = fnBinding(loader, input.visits);
  const target = continuation?.value;
  const visit =
    target === undefined ? undefined : input.visits.find((item) => item.node === target);
  if (
    continuation === undefined ||
    bound === undefined ||
    visit === undefined ||
    !call(target, 1) ||
    !ownBinding(target['callee'], visit, bound)
  )
    return undefined;
  const targetId = turbopackModuleId(listOf(target, 'arguments')[0]);
  return targetId === undefined ? undefined : { targetId, targetCall: target };
}

function exportCall(body: Node): Node | undefined {
  const statements = listOf(body, 'body');
  const first = statements[0];
  const code =
    isNode(first) && first.type === 'ExpressionStatement' && isNode(first['expression'])
      ? first['expression']
      : undefined;
  const strict =
    isNode(first) &&
    code?.type === 'Literal' &&
    code.start === first.start &&
    (code['raw'] === '"use strict"' || code['raw'] === "'use strict'");
  const only = strict ? statements[1] : first;
  const expected = strict ? 2 : 1;
  if (statements.length !== expected || !isNode(only) || only.type !== 'ExpressionStatement')
    return undefined;
  const expression = only['expression'];
  return isNode(expression) ? expression : undefined;
}

function inspectLoader(input: AsyncProjectionInput): NodeManifestAsyncProjection | undefined {
  const exported = exportCall(input.body);
  const visit =
    exported === undefined ? undefined : input.visits.find((item) => item.node === exported);
  if (
    visit === undefined ||
    !isNode(exported) ||
    !member(exported['callee'], 'v') ||
    !ownBinding(exported['callee']['object'], visit, input.context) ||
    (!call(exported, 1) && !call(exported, 2))
  )
    return undefined;
  const args = listOf(exported, 'arguments');
  const exportId = defaultExportTarget(args[1], visit)
    ? input.moduleId
    : turbopackModuleId(args[1]);
  if (exportId === undefined || !input.factoryIds.includes(exportId)) return undefined;
  const loader = returned(args[0], 1);
  if (loader === undefined || !call(loader.value, 1) || !member(loader.value['callee'], 'then'))
    return undefined;
  const loads = promiseLoads(loader.value['callee']['object'], input);
  const target = terminalImport(loader.node, loader.value, input);
  if (loads === undefined || target === undefined) return undefined;
  return Object.freeze({
    ...loads,
    ...target,
    ...(exportId === input.moduleId && {
      loader: Object.freeze({ targetId: target.targetId, chunks: loads.chunks }),
    }),
  });
}

/** Exact fixed AsyncLoaderModule producer; callback bytes remain unchanged and the graph must seal every path/ID. */
function nodeManifestAsyncProjection(
  input: AsyncProjectionInput,
): NodeManifestAsyncProjection | undefined {
  const result = inspectLoader(input);
  if (result !== undefined) return result;
  for (const visit of input.visits) {
    if (member(visit.node, 'l') && ownBinding(visit.node['object'], visit, input.context)) {
      const parent = visit.parent;
      if (parent?.type === 'CallExpression' && parent['callee'] === visit.node)
        throw new AuditError(
          'Unproved Next.js Turbopack async-loader producer; refusing native publication',
        );
    }
  }
  return undefined;
}

/** The graph must discharge these source-derived paths/IDs before allowing any runtime capability. */
export class TurbopackAsyncProjection {
  private readonly input: AsyncProjectionInput;
  private readonly proof: NodeManifestAsyncProjection | undefined;
  private readonly calls: NodeManifestTurbopackModuleId[] = [];
  private readonly edges: NodeManifestTurbopackImport[] = [];

  constructor(input: AsyncProjectionInput) {
    this.input = input;
    this.proof = nodeManifestAsyncProjection(input);
    if (this.proof !== undefined) this.addEdge(this.proof.targetId);
  }

  private addEdge(id: NodeManifestTurbopackModuleId): void {
    this.edges.push({ kind: 'import', specifier: turbopackModuleSpecifier(id), targetId: id });
  }

  operation(node: Node, visit: Visit): boolean {
    if (this.proof?.members.includes(node) === true) return true;
    if (!member(node, 'A') || !ownBinding(node['object'], visit, this.input.context)) return false;
    const parent = visit.parent;
    const id = isNode(parent) ? turbopackModuleId(listOf(parent, 'arguments')[0]) : undefined;
    if (id === undefined || !call(parent, 1) || parent['callee'] !== node)
      throw new AuditError(
        'Unproved Next.js Turbopack async-loader call; refusing native publication',
      );
    this.calls.push(id);
    this.addEdge(id);
    return true;
  }

  references(): readonly Node[] {
    return this.proof?.references ?? [];
  }
  imports(): readonly NodeManifestTurbopackImport[] {
    return Object.freeze([...this.edges]);
  }
  loads(): readonly NodeManifestTurbopackModuleId[] {
    return Object.freeze([...this.calls]);
  }
  get loader(): NodeManifestTurbopackAsyncLoader | undefined {
    return this.proof?.loader;
  }
}

export function nodeManifestAsyncMetadata(
  proof: TurbopackAsyncProjection | undefined,
): Pick<NodeManifestTurbopackProjection, 'asyncLoads' | 'asyncLoader'> {
  const loader = proof?.loader;
  return {
    asyncLoads: proof?.loads() ?? Object.freeze([]),
    ...(loader !== undefined && { asyncLoader: loader }),
  };
}
