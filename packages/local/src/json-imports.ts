import type { Expression, Node, PropertyKey } from '@oxc-project/types';
import { parseSync } from 'rolldown/utils';

/** Constant string specifiers, including templates and concatenations the old bundler folded. */
function stringOf(expression: Expression | undefined | null): string | undefined {
  const parts: string[] = [];
  const pending: (Expression | string | undefined | null)[] = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === 'string') {
      parts.push(node);
    } else if (node?.type === 'Literal' && typeof node.value === 'string') {
      parts.push(node.value);
    } else if (node?.type === 'BinaryExpression' && node.operator === '+') {
      pending.push(node.right, node.left);
    } else if (node?.type === 'TemplateLiteral') {
      for (let index = node.quasis.length - 1; index >= 0; index -= 1) {
        pending.push(node.quasis[index]?.value.cooked);
        if (index > 0) {
          pending.push(node.expressions[index - 1]);
        }
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
    const pending: unknown[] = [parsed.program];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!isNode(node)) {
        continue;
      }
      if (
        node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
      ) {
        const json = node.attributes.some(
          (attribute) =>
            nameOf(attribute.key, false) === 'type' && attribute.value.value === 'json',
        );
        if (json && node.source !== null) {
          imports.push(node.source.value);
        }
      } else if (node.type === 'ImportExpression') {
        const specifier = stringOf(node.source);
        const attributes = propertyOf(node.options, 'with') ?? propertyOf(node.options, 'assert');
        if (specifier !== undefined && stringOf(propertyOf(attributes, 'type')) === 'json') {
          imports.push(specifier);
        }
      }
      for (const [key, child] of Object.entries(node)) {
        if (key !== 'parent') {
          if (Array.isArray(child)) {
            for (let index = child.length - 1; index >= 0; index -= 1) {
              pending.push(child[index]);
            }
          } else if (isNode(child)) {
            pending.push(child);
          }
        }
      }
    }
    return imports;
  } catch {
    return [];
  }
}
