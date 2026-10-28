/** Shared lexical declarations for the adapter’s build-time JavaScript rewrites. */
const FUNCTIONS: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** A list a node holds under `key`: its params, its elements, its properties. */
export function listOf(node: Node, key: string): readonly unknown[] {
  const value = node[key];
  return Array.isArray(value) ? value : [];
}

export function childrenOf(node: Node): unknown[] {
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
export interface Scope {
  readonly declared: Set<string>;
  readonly constants: Set<string>;
  readonly bindings: Map<string, Node>;
}

function emptyScope(): Scope {
  return { declared: new Set(), constants: new Set(), bindings: new Map() };
}

/** What a `let`, `const` or `var` declares: into `scope`, its constants marked. */
function declareVariables(scope: Scope, declaration: Node): void {
  const names = new Set<string>();
  for (const declarator of listOf(declaration, 'declarations')) {
    boundNames(isNode(declarator) ? declarator['id'] : undefined, names);
    if (isNode(declarator) && isNode(declarator['id']) && declarator['id'].type === 'Identifier') {
      scope.bindings.set(declarator['id']['name'] as string, declarator);
    }
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
      const name = declaration['id']['name'] as string;
      scope.declared.add(name);
      scope.bindings.set(name, declaration);
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
export function scopeOpenedBy(node: Node): Scope | undefined {
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
    case 'ClassExpression': {
      // The self-name is local even in the heritage expression's temporal dead zone.
      const name = node['id'];
      if (!isNode(name) || name.type !== 'Identifier' || typeof name['name'] !== 'string') {
        return undefined;
      }
      return {
        declared: new Set([name['name']]),
        constants: new Set(),
        bindings: new Map([[name['name'], node]]),
      };
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
