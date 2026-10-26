import { createRequire } from 'node:module';
import path from 'node:path';

import type { Node as AstNode } from '@oxc-project/types';

import { beneath } from './build-paths.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { nativeBindings } from './native-ast.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  stringOf,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import {
  currentNodeManifestTemplateHelperImport,
  nodeManifestTemplateHelperMember,
  type NodeManifestTemplateHelperMember,
  type NodeManifestTemplateHelperOwner,
} from './node-manifest-template-helpers.ts';
import type { NodeManifestTemplateImport } from './node-manifest-templates.ts';
import type { NodeManifestTurbopackTemplateImport } from './node-manifest-turbopack-template-import.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

interface TokenInput {
  readonly program: Node;
  readonly visits: ReadonlyMap<Node, Visit>;
  readonly imports: readonly NodeManifestTurbopackTemplateImport[];
  readonly templateFile: string;
  readonly nextRoot: string;
  readonly expected: boolean;
  readonly owner?: NodeManifestTemplateHelperOwner | undefined;
  readonly projection?: NodeManifestTurbopackProjection | undefined;
}
interface Namespace {
  readonly variable: Node;
  readonly name: string;
  readonly imported: NodeManifestTemplateImport;
}
const MODULES = {
  RouteKind: {
    module: 'dist/server/route-kind.js',
    sha256: '4dc92760c2e4925613034896faa04c52daaf7a4420d7bcbd6de5214b55d84fea',
  },
  hoist: {
    module: 'dist/build/templates/helpers.js',
    sha256: 'b9dd74a9ba684af8c21a7204d79c63f08683e22cf5e49d4e133ab5e2d9149b03',
  },
} as const;

function required(node: Node, input: TokenInput): string | undefined {
  if (
    node.type !== 'CallExpression' ||
    node['optional'] === true ||
    !identifier(node['callee']) ||
    node['callee'].name !== 'require'
  )
    return undefined;
  const visit = input.visits.get(node);
  const args = listOf(node, 'arguments');
  return visit !== undefined &&
    declaration('require', visit.scopes) === undefined &&
    args.length === 1
    ? stringOf(args[0])
    : undefined;
}

function imported(call: Node, input: TokenInput): NodeManifestTemplateImport | undefined {
  const specifier = required(call, input);
  if (specifier === undefined || specifier.startsWith('VAR_')) return undefined;
  if (input.expected)
    return { specifier, file: createRequire(input.templateFile).resolve(specifier), sha256: '' };
  const entries = input.imports.filter((entry) => entry.specifier === specifier);
  const entry = entries[0];
  return entry !== undefined && entries.length === 1 && 'file' in entry ? entry : undefined;
}

function namespace(value: Node, input: TokenInput): Namespace | undefined {
  if (!identifier(value)) return undefined;
  const visit = input.visits.get(value);
  const variable = visit === undefined ? undefined : declaration(value.name, visit.scopes)?.node;
  const statement = variable === undefined ? undefined : input.visits.get(variable)?.parent;
  const call = variable?.['init'];
  if (
    variable?.type !== 'VariableDeclarator' ||
    !identifier(variable['id']) ||
    !isNode(call) ||
    statement?.type !== 'VariableDeclaration' ||
    input.visits.get(statement)?.parent !== input.program
  )
    return undefined;
  const descriptor = imported(call, input);
  return descriptor === undefined
    ? undefined
    : { variable, imported: descriptor, name: value.name };
}

function physicalMember(
  entry: NodeManifestTemplateImport,
  key: string,
  input: TokenInput,
): NodeManifestTemplateHelperMember | undefined {
  if (key !== 'RouteKind' && key !== 'hoist') return undefined;
  const profile = MODULES[key];
  const relative = beneath(input.nextRoot, entry.file)?.split(path.sep).join('/');
  return relative === profile.module && (input.expected || entry.sha256 === profile.sha256)
    ? { module: profile.module, name: key }
    : undefined;
}

function semantic(
  known: Namespace,
  key: string,
  input: TokenInput,
): NodeManifestTemplateHelperMember | undefined {
  const entry = known.imported;
  if (entry.helper === undefined) return physicalMember(entry, key, input);
  if (input.owner === undefined || input.projection === undefined) return undefined;
  return nodeManifestTemplateHelperMember(entry.helper, {
    owner: input.owner,
    projection: input.projection,
    exportName: key,
    specifier: entry.specifier,
    file: entry.file,
    sha256: entry.sha256,
  });
}

function member(node: Node, input: TokenInput): NodeManifestTemplateHelperMember | undefined {
  if (node.type !== 'MemberExpression' || node['optional'] === true || !identifier(node['object']))
    return undefined;
  const key = propertyName(node);
  const known = namespace(node['object'], input);
  if (
    key === undefined ||
    known === undefined ||
    !nativeBindings(input.program as unknown as AstNode).unmodified(
      node['object'],
      known.name,
      true,
    )
  )
    return undefined;
  return semantic(known, key, input);
}

function namespaceModule(known: Namespace, input: TokenInput): string | undefined {
  const modules = new Set<string>();
  for (const visit of input.visits.values()) {
    const node = visit.node;
    if (
      !identifier(node) ||
      node.name !== known.name ||
      !reference(visit) ||
      declaration(node.name, visit.scopes)?.node !== known.variable
    )
      continue;
    if (visit.parent?.type !== 'MemberExpression' || visit.key !== 'object') return undefined;
    const role = member(visit.parent, input);
    if (role === undefined) return undefined;
    modules.add(role.module);
  }
  return modules.size === 1 ? modules.values().next().value : undefined;
}

/** Inspection tokens keep real imports and declarations; only certified static members normalize. */
export function nodeManifestTemplateHelperToken(node: Node, input: TokenInput): string | undefined {
  const role = member(node, input);
  if (role !== undefined) return `next-helper:${role.module}#${role.name}`;
  const descriptor = imported(node, input);
  if (descriptor?.helper === undefined) return undefined;
  const parent = input.visits.get(node)?.parent;
  const local = parent?.type === 'VariableDeclarator' ? parent['id'] : undefined;
  if (!identifier(local)) return undefined;
  const known = namespace(local, input);
  const module = known === undefined ? undefined : namespaceModule(known, input);
  return module === undefined ? undefined : `next:${module}`;
}

/** Keep unrecognized but valid ordinary userland imports on the existing slot path. */
export function currentTemplateHelperImport(
  entry: NodeManifestTemplateImport,
  input: Pick<TokenInput, 'owner' | 'projection'>,
): boolean {
  return (
    entry.helper === undefined ||
    (input.owner !== undefined &&
      input.projection !== undefined &&
      currentNodeManifestTemplateHelperImport(entry.helper, {
        ...entry,
        owner: input.owner,
        projection: input.projection,
      }))
  );
}
