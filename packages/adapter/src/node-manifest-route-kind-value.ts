import { isNode, listOf, type Node } from './lexical-scope.ts';
import { declaration, identifier, reference, type Visit } from './node-manifest-consumer-ast.ts';

const MEMBERS = ['PAGES', 'PAGES_API', 'APP_PAGE', 'APP_ROUTE', 'IMAGE'] as const;

function emptyObject(value: unknown): boolean {
  return (
    isNode(value) && value.type === 'ObjectExpression' && listOf(value, 'properties').length === 0
  );
}

function commaValues(value: Node): readonly Node[] {
  const values: Node[] = [];
  const pending = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.type === 'SequenceExpression') {
      const expressions = listOf(next, 'expressions');
      if (expressions.some((expression) => !isNode(expression))) return [];
      for (const expression of expressions.toReversed())
        if (isNode(expression)) pending.push(expression);
    } else values.push(next);
  }
  return values;
}

function fieldAssignment(value: Node, name: string, key: string): boolean {
  const member = value['left'];
  const right = value['right'];
  if (
    value.type !== 'AssignmentExpression' ||
    value['operator'] !== '=' ||
    !isNode(member) ||
    member.type !== 'MemberExpression' ||
    member['optional'] === true ||
    !identifier(member['object']) ||
    member['object'].name !== name ||
    !isNode(right) ||
    right.type !== 'Literal' ||
    right['value'] !== key
  )
    return false;
  const property = member['property'];
  return member['computed'] === true
    ? isNode(property) && property.type === 'Literal' && property['value'] === key
    : identifier(property) && property.name === key;
}

function returnedObject(values: readonly Node[], name: string): boolean {
  const last = values.at(-1);
  return (
    values.length === MEMBERS.length + 1 &&
    identifier(last) &&
    last.name === name &&
    MEMBERS.every((key, index) => {
      const value = values[index];
      return value !== undefined && fieldAssignment(value, name, key);
    })
  );
}

function bodyValues(body: Node): readonly Node[] | undefined {
  if (body.type !== 'BlockStatement') return commaValues(body);
  const statements = listOf(body, 'body');
  const values: Node[] = [];
  for (const [index, statement] of statements.entries()) {
    if (!isNode(statement)) return undefined;
    const last = index === statements.length - 1;
    if (
      (last && statement.type !== 'ReturnStatement') ||
      (!last && statement.type !== 'ExpressionStatement')
    )
      return undefined;
    const expression = statement[last ? 'argument' : 'expression'];
    if (!isNode(expression)) return undefined;
    values.push(...commaValues(expression));
  }
  return values;
}

function localObject(body: Node): { readonly name: string; readonly body: Node } | undefined {
  if (body.type !== 'BlockStatement') return undefined;
  const statements = listOf(body, 'body');
  const first = statements[0];
  const declarations = isNode(first) ? listOf(first, 'declarations') : [];
  const variable = declarations[0];
  if (
    !isNode(first) ||
    first.type !== 'VariableDeclaration' ||
    !['const', 'let', 'var'].includes(String(first['kind'])) ||
    declarations.length !== 1 ||
    !isNode(variable) ||
    !identifier(variable['id']) ||
    !emptyObject(variable['init'])
  )
    return undefined;
  return { name: variable['id'].name, body: { ...body, body: statements.slice(1) } };
}

interface OriginalContext {
  readonly body: Node;
  readonly visits: ReadonlyMap<Node, Visit>;
}

function priorTemporary(node: Node, value: Node, context: OriginalContext): Node | undefined {
  if (!identifier(node)) return undefined;
  const visit = context.visits.get(node);
  const bound = visit === undefined ? undefined : declaration(node.name, visit.scopes)?.node;
  const statement = bound === undefined ? undefined : context.visits.get(bound)?.parent;
  return bound?.type === 'VariableDeclarator' &&
    identifier(bound['id']) &&
    bound['init'] === null &&
    bound.end < value.start &&
    statement?.type === 'VariableDeclaration' &&
    ['let', 'var'].includes(String(statement['kind'])) &&
    context.visits.get(statement)?.parent === context.body
    ? bound
    : undefined;
}

function closedTemporary(
  variable: Node,
  nodes: ReadonlySet<Node>,
  context: OriginalContext,
): boolean {
  const local = variable['id'];
  const own = isNode(local) ? context.visits.get(local) : undefined;
  if (own === undefined || !identifier(local)) return false;
  const scope = own.scopes.findLast((candidate) => candidate.declared.has(local.name));
  for (const visit of context.visits.values()) {
    const node = visit.node;
    if (
      node === local ||
      !identifier(node) ||
      node.name !== local.name ||
      visit.scopes.findLast((candidate) => candidate.declared.has(node.name)) !== scope
    )
      continue;
    if (reference(visit) && !nodes.has(node)) return false;
    if (
      visit.key === 'id' &&
      ['ClassDeclaration', 'FunctionDeclaration', 'VariableDeclarator'].includes(
        visit.parent?.type ?? '',
      )
    )
      return false;
  }
  return true;
}

interface OuterObject {
  readonly local: Node & { readonly name: string };
  readonly fields: readonly Node[];
}

function freshObject(value: unknown): (Node & { readonly name: string }) | undefined {
  if (
    !isNode(value) ||
    value.type !== 'AssignmentExpression' ||
    value['operator'] !== '=' ||
    !identifier(value['left']) ||
    !emptyObject(value['right'])
  )
    return undefined;
  return value['left'];
}

function outerObject(values: readonly Node[]): OuterObject | undefined {
  const first = values[0];
  const local = freshObject(first);
  if (local !== undefined) return { local, fields: values.slice(1) };
  const member = first?.['left'];
  const allocated = isNode(member) ? freshObject(member['object']) : undefined;
  if (
    allocated === undefined ||
    first?.type !== 'AssignmentExpression' ||
    first['operator'] !== '=' ||
    !isNode(member) ||
    member.type !== 'MemberExpression'
  )
    return undefined;
  // This comparison-only view binds the original allocation identifier; raw source is unchanged.
  const field = { ...first, left: { ...member, object: allocated } };
  return { local: allocated, fields: [field, ...values.slice(1)] };
}

function outerTemporary(value: Node, context: OriginalContext): boolean {
  if (value.type !== 'SequenceExpression') return false;
  const object = outerObject(commaValues(value));
  if (object === undefined || !returnedObject(object.fields, object.local.name)) return false;
  const { local } = object;
  const variable = priorTemporary(local, value, context);
  if (variable === undefined) return false;
  const allowed = new Set<Node>([local]);
  for (const entry of object.fields) {
    if (identifier(entry)) allowed.add(entry);
    else {
      const member = entry['left'];
      if (isNode(member) && isNode(member['object'])) allowed.add(member['object']);
    }
  }
  return closedTemporary(variable, allowed, context);
}

/** Only one closed enum object, its five ordered literal writes, and that same return. */
export function reviewedRouteKindInitializer(value: Node, context?: OriginalContext): boolean {
  if (context !== undefined && outerTemporary(value, context)) return true;
  const callee = value['callee'];
  if (
    value.type !== 'CallExpression' ||
    value['optional'] === true ||
    !isNode(callee) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(callee.type) ||
    callee['async'] === true ||
    callee['generator'] === true ||
    (callee['id'] !== undefined && callee['id'] !== null) ||
    !isNode(callee['body'])
  )
    return false;
  const params = listOf(callee, 'params');
  const args = listOf(value, 'arguments');
  const param = params[0];
  let selected: { readonly name: string; readonly body: Node } | undefined;
  if (params.length === 1 && args.length === 1 && identifier(param) && emptyObject(args[0]))
    selected = { name: param.name, body: callee['body'] };
  else if (params.length === 0 && args.length === 0) selected = localObject(callee['body']);
  if (selected === undefined) return false;
  const values = bodyValues(selected.body);
  return values !== undefined && returnedObject(values, selected.name);
}
