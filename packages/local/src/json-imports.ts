import type { Expression, Node, PropertyKey, TemplateLiteral } from '@oxc-project/types';
import { parseSync } from 'rolldown/utils';

type StringPart = Expression | string | undefined | null;
type ModuleRequestKind =
  | 'ImportDeclaration'
  | 'ExportNamedDeclaration'
  | 'ExportAllDeclaration'
  | 'ImportExpression';
type ModuleRequest = Extract<Node, { type: ModuleRequestKind }>;

/** Push a template's pieces in reverse so the next piece is read in source order. */
function templateParts(node: TemplateLiteral): StringPart[] {
  const parts: StringPart[] = [];
  for (let index = node.quasis.length - 1; index >= 0; index -= 1) {
    parts.push(node.quasis[index]?.value.cooked);
    if (index > 0) {
      parts.push(node.expressions[index - 1]);
    }
  }
  return parts;
}

/** Constant string specifiers, including templates and concatenations the old bundler folded. */
function stringOf(expression: Expression | undefined | null): string | undefined {
  const parts: string[] = [];
  const pending: StringPart[] = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === 'string') {
      parts.push(node);
    } else if (node?.type === 'Literal' && typeof node.value === 'string') {
      parts.push(node.value);
    } else if (node?.type === 'BinaryExpression' && node.operator === '+') {
      pending.push(node.right, node.left);
    } else if (node?.type === 'TemplateLiteral') {
      for (const part of templateParts(node)) {
        pending.push(part);
      }
    } else {
      return undefined;
    }
  }
  return parts.join('');
}

function nameOf(key: PropertyKey, computed: boolean): string | undefined {
  if (!computed && key.type === 'Identifier') {
    return key.name;
  }
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

/** A statically named, ordinary data property; later properties can replace an earlier one. */
function propertyOf(object: Expression | null | undefined, name: string): Expression | undefined {
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  let value: Expression | undefined;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      value = undefined;
      continue;
    }
    const key = nameOf(property.key, property.computed);
    if (key === undefined) {
      value = undefined;
    } else if (key === name) {
      value = property.kind === 'init' && !property.method ? property.value : undefined;
    }
  }
  return value;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  );
}

function isModuleRequest(node: Node): node is ModuleRequest {
  return [
    'ExportAllDeclaration',
    'ExportNamedDeclaration',
    'ImportDeclaration',
    'ImportExpression',
  ].includes(node.type);
}

/** One module request, where this syntax node carries the JSON type. */
function jsonImportOf(node: Node): string | undefined {
  if (!isModuleRequest(node)) {
    return undefined;
  }
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration': {
      const json = node.attributes.some(
        (attribute) => nameOf(attribute.key, false) === 'type' && attribute.value.value === 'json',
      );
      return json ? node.source?.value : undefined;
    }
    case 'ImportExpression': {
      const attributes = propertyOf(node.options, 'with') ?? propertyOf(node.options, 'assert');
      return stringOf(propertyOf(attributes, 'type')) === 'json'
        ? stringOf(node.source)
        : undefined;
    }
  }
}

function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') {
      continue;
    }
    const candidates: unknown[] = Array.isArray(child) ? child : [child];
    for (const candidate of candidates) {
      if (isNode(candidate)) {
        children.push(candidate);
      }
    }
  }
  return children;
}

/**
 * Only real imports and re-exports carrying the JSON type, including the older `assert` spelling.
 * Invalid JavaScript is left to the runtime to judge, as it was by the previous bundler.
 */
export function jsonImportsOf(name: string, source: string): string[] {
  try {
    const parsed = parseSync(name, source, {
      lang: 'js',
      sourceType: 'unambiguous',
      preserveParens: false,
    });
    if (parsed.errors.some((error) => error.severity === 'Error')) {
      return [];
    }
    const imports: string[] = [];
    const pending: Node[] = [parsed.program];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) {
        break;
      }
      const specifier = jsonImportOf(node);
      if (specifier !== undefined) {
        imports.push(specifier);
      }
      for (const child of childrenOf(node).toReversed()) {
        pending.push(child);
      }
    }
    return imports;
  } catch {
    return [];
  }
}
