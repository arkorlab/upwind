import { type Plugin, RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

/**
 * The setters Turbopack gives an export whose binding is a `const`, made the throw they would be.
 *
 * Turbopack registers a module's exports as name, getter and, for a binding that may change, a
 * setter: `e.s(["k",()=>b,e=>b=e])`. With `experimental.turbopackModuleFragments` (Next.js 16.4),
 * which splits a module into parts that write one another's bindings through those setters, it
 * gives every export one — a `const` export's among them, which no part ever calls. Node.js runs
 * such a chunk: the assignment is only an error if it is made. Rolldown refuses to bundle it, every
 * such setter an `ILLEGAL_REASSIGNMENT`, and the Function did not build (Next.js's `treeshake-mw`,
 * `turbopack-tree-shaking-chunkgroup`, `turbopack-tree-shaking-pages`).
 *
 * So the body of such a setter becomes what running it would do — `throw new TypeError(…)`, as
 * assigning a constant throws — and nothing else changes: the getter, every setter of a binding
 * that is not a `const`, and the chunk around them. A setter is recognized by its shape, an arrow
 * of one parameter that is an element of an array and whose whole body assigns that parameter to a
 * name; the name by the declaration it resolves to, scope by scope, as the language resolves it. A
 * name this cannot resolve to a `const` is left as it is, and Rolldown says what it says of it.
 */

/** What may be such a setter, before a chunk is parsed to be sure: `e=>b=e` followed by `,` or `]`. */
const SETTER_SHAPE = /(?<![\w$])([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)=\1(?=[,\]])/u;
const THROW = '{throw new TypeError("Assignment to constant variable.")}';
const FUNCTIONS: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** A list a node holds under `key`: its params, its elements, its properties. */
function listOf(node: Node, key: string): readonly unknown[] {
  const value = node[key];
  return Array.isArray(value) ? value : [];
}

function childrenOf(node: Node): unknown[] {
  return Object.entries(node).flatMap(([key, child]) =>
    key === 'type' || key === 'start' || key === 'end' || typeof child !== 'object' ? [] : [child],
  );
}

/** The names a declaration's pattern binds: `b`, and those inside `{ b, c: [d] }`. */
function boundNames(pattern: unknown, into: Set<string>): void {
  if (!isNode(pattern)) {
    return;
  }
  switch (pattern.type) {
    case 'Identifier': {
      into.add(pattern['name'] as string);
      break;
    }
    case 'ObjectPattern': {
      for (const property of listOf(pattern, 'properties')) {
        boundNames(
          isNode(property) && property.type === 'Property' ? property['value'] : property,
          into,
        );
      }
      break;
    }
    case 'ArrayPattern': {
      for (const element of listOf(pattern, 'elements')) {
        boundNames(element, into);
      }
      break;
    }
    case 'RestElement': {
      boundNames(pattern['argument'], into);
      break;
    }
    case 'AssignmentPattern': {
      boundNames(pattern['left'], into);
      break;
    }
    default:
  }
}

/** The names one scope declares, and which of them are `const`. */
interface Scope {
  readonly declared: Set<string>;
  readonly constants: Set<string>;
}

function emptyScope(): Scope {
  return { declared: new Set(), constants: new Set() };
}

/** What a `let`, `const` or `var` declares: into `scope`, its constants marked. */
function declareVariables(scope: Scope, declaration: Node): void {
  const names = new Set<string>();
  for (const declarator of listOf(declaration, 'declarations')) {
    boundNames(isNode(declarator) ? declarator['id'] : undefined, names);
  }
  for (const name of names) {
    scope.declared.add(name);
    if (declaration['kind'] === 'const') {
      scope.constants.add(name);
    }
  }
}

/** What a list of statements declares in the block they make up: `let`, `const`, functions, classes. */
function lexicalScope(statements: readonly unknown[]): Scope {
  const scope = emptyScope();
  for (const statement of statements) {
    const declaration =
      isNode(statement) && statement.type === 'ExportNamedDeclaration'
        ? statement['declaration']
        : statement;
    if (!isNode(declaration)) {
      continue;
    }
    if (declaration.type === 'VariableDeclaration' && declaration['kind'] !== 'var') {
      declareVariables(scope, declaration);
    } else if (
      (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') &&
      isNode(declaration['id'])
    ) {
      scope.declared.add(declaration['id']['name'] as string);
    }
  }
  return scope;
}

/**
 * The `var`s a function, a class's static block or the chunk hoists: made anywhere in it, outside
 * the functions and static blocks it holds, each of which keeps its own.
 */
function hoistVariables(scope: Scope, value: unknown): void {
  if (Array.isArray(value)) {
    for (const element of value) {
      hoistVariables(scope, element);
    }
    return;
  }
  if (!isNode(value) || FUNCTIONS.has(value.type) || value.type === 'StaticBlock') {
    return;
  }
  if (value.type === 'VariableDeclaration' && value['kind'] === 'var') {
    declareVariables(scope, value);
  }
  for (const child of childrenOf(value)) {
    hoistVariables(scope, child);
  }
}

/** The scope a function makes: its parameters, its own name where it is an expression's, its `var`s. */
function functionScope(fn: Node): Scope {
  const scope = emptyScope();
  for (const param of listOf(fn, 'params')) {
    boundNames(param, scope.declared);
  }
  if (fn.type === 'FunctionExpression' && isNode(fn['id'])) {
    scope.declared.add(fn['id']['name'] as string);
  }
  hoistVariables(scope, fn['body']);
  return scope;
}

/** The scope a loop's head makes: the `let` or `const` it declares. */
function loopScope(loop: Node): Scope | undefined {
  const head = loop.type === 'ForStatement' ? loop['init'] : loop['left'];
  if (!isNode(head) || head.type !== 'VariableDeclaration' || head['kind'] === 'var') {
    return undefined;
  }
  const scope = emptyScope();
  declareVariables(scope, head);
  return scope;
}

/** The scope a node opens for what is inside it, where it opens one. */
function scopeOpenedBy(node: Node): Scope | undefined {
  switch (node.type) {
    case 'Program': {
      const scope = lexicalScope(listOf(node, 'body'));
      hoistVariables(scope, node['body']);
      return scope;
    }
    case 'ArrowFunctionExpression':
    case 'FunctionDeclaration':
    case 'FunctionExpression': {
      return functionScope(node);
    }
    case 'BlockStatement': {
      return lexicalScope(listOf(node, 'body'));
    }
    case 'StaticBlock': {
      const scope = lexicalScope(listOf(node, 'body'));
      hoistVariables(scope, listOf(node, 'body'));
      return scope;
    }
    case 'SwitchStatement': {
      return lexicalScope(
        listOf(node, 'cases').flatMap((each) => (isNode(each) ? listOf(each, 'consequent') : [])),
      );
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      return loopScope(node);
    }
    case 'CatchClause': {
      const scope = emptyScope();
      boundNames(node['param'], scope.declared);
      return scope;
    }
    default: {
      return undefined;
    }
  }
}

/** Whether `name`, read where `scopes` (innermost last) are open, is a `const`. */
function isConstant(scopes: readonly Scope[], name: string): boolean {
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true) {
      return scope.constants.has(name);
    }
  }
  return false;
}

/** An arrow `p=>name=p`'s body and the name, or `undefined` for any other node. */
function setterOf(node: Node): { readonly body: Node; readonly name: string } | undefined {
  if (node.type !== 'ArrowFunctionExpression') {
    return undefined;
  }
  const params = listOf(node, 'params');
  const body = node['body'];
  const param = params[0];
  if (
    params.length !== 1 ||
    !isNode(param) ||
    param.type !== 'Identifier' ||
    !isNode(body) ||
    body.type !== 'AssignmentExpression' ||
    body['operator'] !== '='
  ) {
    return undefined;
  }
  const left = body['left'];
  const right = body['right'];
  return isNode(left) &&
    left.type === 'Identifier' &&
    left['name'] !== param['name'] &&
    isNode(right) &&
    right.type === 'Identifier' &&
    right['name'] === param['name']
    ? { body, name: left['name'] as string }
    : undefined;
}

/** The bodies of the setters in `code` that assign a `const`, by their position in it. */
export function constSetterBodies(
  code: string,
): { readonly start: number; readonly end: number }[] {
  const found: { start: number; end: number }[] = [];
  const scopes: Scope[] = [];
  const walk = (value: unknown, inArray: boolean): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        walk(element, inArray);
      }
      return;
    }
    if (!isNode(value)) {
      return;
    }
    const setter = inArray ? setterOf(value) : undefined;
    if (setter !== undefined && isConstant(scopes, setter.name)) {
      found.push({ start: setter.body.start, end: setter.body.end });
      return;
    }
    const opened = scopeOpenedBy(value);
    if (opened !== undefined) {
      scopes.push(opened);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'type' && key !== 'start' && key !== 'end' && typeof child === 'object') {
        walk(child, value.type === 'ArrayExpression' && key === 'elements');
      }
    }
    if (opened !== undefined) {
      scopes.pop();
    }
  };
  walk(parseAst(code), false);
  return found;
}

/** The plugin, for the Functions' bundles. */
export function constExportSettersPlugin(): Plugin {
  return {
    name: 'arkor-const-export-setters',
    transform: {
      filter: { code: SETTER_SHAPE },
      handler(code) {
        const bodies = constSetterBodies(code);
        if (bodies.length === 0) {
          return null;
        }
        const rewritten = new RolldownMagicString(code);
        for (const { start, end } of bodies) {
          rewritten.overwrite(start, end, THROW);
        }
        return { code: rewritten };
      },
    },
  };
}
