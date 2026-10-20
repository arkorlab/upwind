import { type Plugin, RolldownMagicString } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope, scopeOpenedBy } from './lexical-scope.ts';

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
