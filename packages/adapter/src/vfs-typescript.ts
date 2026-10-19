import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { type Plugin, RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { beneath, BUNDLE_ROOT } from './build-paths.ts';
import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import {
  childrenOf,
  isNode,
  listOf,
  type Node,
  type Scope,
  scopeOpenedBy,
} from './lexical-scope.ts';
import type { TracedFile } from './traced-files.ts';

const DECLARATION = /\.d\.[cm]?ts$/u;
const PATH_CHAR_CODES = Array.from('path', (character) => character.codePointAt(0));
const VFS_PACKAGE = '@typescript/vfs';

/** A named static property, never a computed or optional loader. */
function memberOf(value: unknown, name: string): value is Node {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['computed'] === false &&
    value['optional'] !== true &&
    isNode(value['property']) &&
    value['property'].type === 'Identifier' &&
    value['property']['name'] === name
  );
}

/** Only the VFS's literal TypeScript peer lookup can become a build-resolved library directory. */
function peerLookup(node: Node): boolean {
  if (node.type !== 'CallExpression' || !isNode(node['callee'])) return false;
  const callee = node['callee'];
  if (callee.type !== 'MemberExpression' || !isNode(callee['property'])) return false;
  const property = callee['property'];
  if (property['name'] !== 'resolve' && property['value'] !== 'resolve') return false;
  const object = callee['object'];
  const args = listOf(node, 'arguments');
  const first = args[0];
  return (
    isNode(object) &&
    object.type === 'Identifier' &&
    object['name'] === 'require' &&
    isNode(first) &&
    first.type === 'Literal' &&
    first['value'] === 'typescript'
  );
}

interface Binding {
  readonly declaration: Node | undefined;
}

function bindingOf(scopes: readonly Scope[], name: string): Binding | undefined {
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true) return { declaration: scope.bindings.get(name) };
  }
  return undefined;
}

/** Path loading in the published VFS: a literal, or its fixed `String.fromCharCode` spelling. */
function pathArgument(node: unknown, scopes: readonly Scope[]): boolean {
  if (!isNode(node)) return false;
  if (node.type === 'Literal') return node['value'] === 'node:path' || node['value'] === 'path';
  if (
    node.type !== 'CallExpression' ||
    node['optional'] === true ||
    !memberOf(node['callee'], 'fromCharCode') ||
    !isNode(node['callee']['object']) ||
    node['callee']['object'].type !== 'Identifier' ||
    node['callee']['object']['name'] !== 'String' ||
    bindingOf(scopes, 'String') !== undefined
  )
    return false;
  const codes = listOf(node, 'arguments');
  return (
    codes.length === PATH_CHAR_CODES.length &&
    codes.every(
      (code, index) =>
        isNode(code) && code.type === 'Literal' && code['value'] === PATH_CHAR_CODES[index],
    )
  );
}

function pathRequire(node: unknown, scopes: readonly Scope[]): boolean {
  if (!isNode(node) || node.type !== 'CallExpression' || node['optional'] === true) return false;
  const callee = node['callee'];
  const args = listOf(node, 'arguments');
  return (
    isNode(callee) &&
    callee.type === 'Identifier' &&
    callee['name'] === 'require' &&
    bindingOf(scopes, 'require') === undefined &&
    args.length === 1 &&
    pathArgument(args[0], scopes)
  );
}

function pathImport(declaration: Node, name: string): boolean {
  const source = declaration['source'];
  return (
    isNode(source) &&
    ['node:path', 'path'].includes(source['value'] as string) &&
    listOf(declaration, 'specifiers').some((specifier) => {
      return (
        isNode(specifier) &&
        ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type) &&
        isNode(specifier['local']) &&
        specifier['local']['name'] === name
      );
    })
  );
}

/** Published zero-argument helper: one return, with no intervening bindings or side effects. */
function pathReturn(fn: unknown): Node | undefined {
  if (
    !isNode(fn) ||
    !['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(fn.type) ||
    listOf(fn, 'params').length > 0 ||
    !isNode(fn['body'])
  )
    return undefined;
  const body = fn['body'];
  if (body.type !== 'BlockStatement') return body;
  const statements = listOf(body, 'body');
  const returned = statements[0];
  return statements.length === 1 &&
    isNode(returned) &&
    returned.type === 'ReturnStatement' &&
    isNode(returned['argument'])
    ? returned['argument']
    : undefined;
}

function pathFactory(
  initial: unknown,
  context: readonly Scope[],
  contexts: ReadonlyMap<Node, readonly Scope[]>,
  mutated: ReadonlySet<Node>,
): boolean {
  if (
    !isNode(initial) ||
    initial.type !== 'CallExpression' ||
    initial['optional'] === true ||
    listOf(initial, 'arguments').length > 0 ||
    !isNode(initial['callee']) ||
    initial['callee'].type !== 'Identifier'
  )
    return false;
  const helper = bindingOf(context, initial['callee']['name'] as string)?.declaration;
  if (helper === undefined || mutated.has(helper)) return false;
  const helperContext = contexts.get(helper);
  const fn = helper.type === 'FunctionDeclaration' ? helper : helper['init'];
  const returned = pathReturn(fn);
  if (helperContext === undefined || returned === undefined || !isNode(fn)) return false;
  const local = scopeOpenedBy(fn);
  const atReturn = local === undefined ? helperContext : [...helperContext, local];
  return pathRequire(returned, atReturn);
}

/** The path namespace must resolve to the checked Node builtin, never just an object named path. */
function pathReceiver(
  receiver: unknown,
  contexts: ReadonlyMap<Node, readonly Scope[]>,
  scopes: readonly Scope[],
  mutated: ReadonlySet<Node>,
): boolean {
  if (pathRequire(receiver, scopes)) return true;
  if (!isNode(receiver) || receiver.type !== 'Identifier') return false;
  const name = receiver['name'] as string;
  const declaration = bindingOf(scopes, name)?.declaration;
  if (declaration === undefined || mutated.has(declaration)) return false;
  const context = contexts.get(declaration);
  if (context === undefined) return false;
  if (declaration.type === 'ImportDeclaration') return pathImport(declaration, name);
  const id = declaration['id'];
  if (
    declaration.type !== 'VariableDeclarator' ||
    !isNode(id) ||
    id.type !== 'Identifier' ||
    id['name'] !== name
  )
    return false;
  const initial = declaration['init'];
  return pathRequire(initial, context) || pathFactory(initial, context, contexts, mutated);
}

function declareImports(node: Node, scope: Scope): void {
  for (const statement of listOf(node, 'body')) {
    if (!isNode(statement) || statement.type !== 'ImportDeclaration') continue;
    for (const specifier of listOf(statement, 'specifiers')) {
      if (!isNode(specifier) || !isNode(specifier['local'])) continue;
      const name = specifier['local']['name'] as string;
      scope.declared.add(name);
      scope.bindings.set(name, statement);
    }
  }
}

/** The same scope model as const setters, with module bindings needed by this ESM/CJS package. */
function resolverScope(node: Node): Scope | undefined {
  if (node.type === 'ClassExpression' && isNode(node['id'])) {
    return {
      declared: new Set([node['id']['name'] as string]),
      constants: new Set(),
      bindings: new Map(),
    };
  }
  const opened = scopeOpenedBy(node);
  if (opened !== undefined && node.type === 'Program') declareImports(node, opened);
  return opened;
}

/** Writes to a namespace or its properties make that binding unsupported. */
function assignmentTarget(node: Node): Node | undefined {
  let target: unknown;
  switch (node.type) {
    case 'AssignmentExpression': {
      target = node['left'];
      break;
    }
    case 'UpdateExpression': {
      target = node['argument'];
      break;
    }
    case 'ForInStatement':
    case 'ForOfStatement': {
      target = node['left'];
      break;
    }
    default: {
      return undefined;
    }
  }
  while (isNode(target) && target.type === 'MemberExpression') target = target['object'];
  return isNode(target) && target.type === 'Identifier' ? target : undefined;
}

/** Only supported free peer lookups through the real, unmodified Node path binding are rewritten. */
function directoryCalls(code: string): Node[] {
  const candidates: { call: Node; parent: Node | undefined; scopes: readonly Scope[] }[] = [];
  const contexts = new Map<Node, readonly Scope[]>();
  const mutated = new Set<Node>();
  const scopes: Scope[] = [];
  const walk = (value: unknown, parent?: Node): void => {
    if (Array.isArray(value)) {
      for (const element of value) walk(element, parent);
      return;
    }
    if (!isNode(value)) return;
    if (['FunctionDeclaration', 'ImportDeclaration', 'VariableDeclarator'].includes(value.type))
      contexts.set(value, [...scopes]);
    const opened = resolverScope(value);
    if (opened !== undefined) scopes.push(opened);
    const assigned = assignmentTarget(value);
    if (assigned !== undefined) {
      const declaration = bindingOf(scopes, assigned['name'] as string)?.declaration;
      if (declaration !== undefined) mutated.add(declaration);
    }
    if (peerLookup(value) && bindingOf(scopes, 'require') === undefined) {
      candidates.push({ call: value, parent, scopes: [...scopes] });
    }
    for (const child of childrenOf(value)) walk(child, value);
    if (opened !== undefined) scopes.pop();
  };
  walk(parseAst(code));
  return candidates.map(({ call, parent, scopes: atCall }) => {
    const args = parent === undefined ? [] : listOf(parent, 'arguments');
    if (
      parent?.type !== 'CallExpression' ||
      !memberOf(parent['callee'], 'dirname') ||
      !memberOf(call['callee'], 'resolve') ||
      call['callee']['optional'] === true ||
      parent['callee']['optional'] === true ||
      listOf(call, 'arguments').length !== 1 ||
      args.length !== 1 ||
      args[0] !== call ||
      call['optional'] === true ||
      parent['optional'] === true ||
      !pathReceiver(parent['callee']['object'], contexts, atCall, mutated)
    )
      throw new AuditError(
        '@stayingupwind/adapter: unsupported free TypeScript resolver shape or path binding in @typescript/vfs',
      );
    return parent;
  });
}

/** The checked package that owns a real importer, never a directory name masquerading as one. */
async function packageOf(file: string): Promise<{ root: string; name: unknown } | undefined> {
  let directory = path.dirname(file);
  for (;;) {
    try {
      const manifest = path.join(directory, 'package.json');
      if ((await realpath(manifest)) !== manifest) {
        throw new AuditError(
          '@stayingupwind/adapter: package identity escapes its actual directory',
        );
      }
      const value: unknown = JSON.parse(await readFile(manifest, 'utf8'));
      if (typeof value !== 'object' || value === null || !('name' in value)) return undefined;
      return { root: await realpath(directory), name: value.name };
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('code' in error) ||
        error.code !== 'ENOENT'
      )
        throw error;
    }
    const next = path.dirname(directory);
    if (next === directory) return undefined;
    directory = next;
  }
}

function canonicalName(name: string): boolean {
  return (
    name !== '' &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !path.posix.isAbsolute(name) &&
    path.posix.normalize(name) === name &&
    name.split('/').every((part) => !['', '.', '..'].includes(part))
  );
}

/** This Function's explicitly traced declarations must identify one logical mount of the actual peer. */
export async function typescriptLibDirectory(
  importer: string,
  projectDir: string,
  files: readonly TracedFile[],
): Promise<string> {
  let physical: string;
  try {
    physical = await realpath(createRequire(importer).resolve('typescript'));
  } catch {
    throw new AuditError(
      '@stayingupwind/adapter: cannot resolve the actual TypeScript peer of @typescript/vfs',
    );
  }
  const peer = await packageOf(physical);
  if (peer?.name !== 'typescript' || beneath(peer.root, physical) === undefined) {
    throw new AuditError(
      '@stayingupwind/adapter: @typescript/vfs resolved an unverified TypeScript peer',
    );
  }
  const lib = path.dirname(physical);
  const project = await realpath(projectDir);
  const directories = new Set<string>();
  for (const file of files) {
    if (!DECLARATION.test(file.name)) continue;
    const source = await realpath(file.filePath);
    if (path.dirname(source) !== lib) continue;
    const segments = file.name.split('/');
    const packageAt = segments.lastIndexOf('node_modules');
    const logicalPackage = segments.slice(0, packageAt + 2).join('/');
    const logicalLib = path.posix.join(
      logicalPackage,
      path.relative(peer.root, lib).split(path.sep).join('/'),
    );
    if (
      packageAt === -1 ||
      !canonicalName(file.name) ||
      segments[packageAt + 1] !== 'typescript' ||
      path.posix.dirname(file.name) !== logicalLib ||
      path.posix.basename(file.name) !== path.basename(source) ||
      beneath(project, source) === undefined ||
      (await realpath(path.join(projectDir, file.name))) !== source
    ) {
      throw new AuditError(
        '@stayingupwind/adapter: TypeScript declaration has an invalid logical trace identity',
      );
    }
    directories.add(path.posix.dirname(file.name));
  }
  if (directories.size !== 1) {
    throw new AuditError(
      '@stayingupwind/adapter: @typescript/vfs needs one unambiguous explicitly traced TypeScript library directory',
    );
  }
  const [directory] = directories;
  if (directory === undefined)
    throw new AuditError('@stayingupwind/adapter: missing TypeScript library directory');
  return path.posix.join(BUNDLE_ROOT, directory);
}

/** No runtime resolver: the three known dirname calls become the verified, traced peer directory. */
export function replaceTypescriptLibDirectory(
  code: string,
  directory: string,
): { code: RolldownMagicString; edits: number } | undefined {
  const calls = directoryCalls(code);
  if (calls.length === 0) return undefined;
  const rewritten = new RolldownMagicString(code);
  for (const call of calls) rewritten.overwrite(call.start, call.end, jsLiteral(directory));
  return { code: rewritten, edits: calls.length };
}

/** Only real VFS package modules in this linked Function's graph are eligible. */
export function typescriptVfsPlugin(input: {
  projectDir: string;
  files: readonly TracedFile[];
}): Plugin {
  return {
    name: 'upwind-typescript-vfs-library',
    transform: {
      filter: { code: /resolve/u },
      async handler(code, id) {
        if (id.startsWith('\0') || !code.includes('typescript')) return null;
        const importer = await realpath(id);
        const owner = await packageOf(importer);
        if (owner?.name !== VFS_PACKAGE || beneath(owner.root, importer) === undefined) return null;
        if (directoryCalls(code).length === 0) return null;
        const directory = await typescriptLibDirectory(importer, input.projectDir, input.files);
        const rewritten = replaceTypescriptLibDirectory(code, directory);
        return rewritten === undefined ? null : { code: rewritten.code };
      },
    },
  };
}
