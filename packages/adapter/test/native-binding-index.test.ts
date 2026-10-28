import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';
import { scalarWorkerBinding } from '../src/native-worker-branches.ts';

function activity(source: string): readonly boolean[] {
  const program = parseAst(`${source}; consume(capability);`);
  const uses = walk(program).filter(
    (node) => node.type === 'Identifier' && node.name === 'capability',
  );
  const use = uses.toSorted((a, b) => b.start - a.start)[0];
  if (use === undefined) throw new Error('Missing capability reference');
  const bindings = nativeBindings(program);
  return [
    bindings.unmodified(use, 'capability', false),
    bindings.unmodified(use, 'capability', true),
  ];
}

function firstVariableDeclaration(program: ReturnType<typeof parseAst>) {
  const tree = walk(program);
  const declaration = tree.find((node) => node.type === 'VariableDeclarator');
  if (declaration?.type !== 'VariableDeclarator') throw new Error('Missing declaration');
  return { tree, declaration };
}

describe('indexed native binding activity', () => {
  it.each([
    ['let capability = source', [true, true]],
    ['let capability = source; capability = other', [false, false]],
    ['let capability = source; capability.value = other', [true, false]],
    ['let capability = source; delete capability.value', [true, false]],
    ['let capability = source; ({ value: capability } = other)', [false, false]],
    ['let capability = source; (() => { let capability = other; capability++ })()', [true, true]],
    ['let capability = source; (() => { capability = other })()', [false, false]],
    ['var capability = source; var capability = other', [false, false]],
    ['var capability = source; var capability', [false, false]],
    ['let { capability } = source', [true, true]],
  ] as const)('preserves binding and member write distinctions: %s', (source, expected) => {
    expect(activity(source)).toStrictEqual(expected);
  });

  it.each([
    ['isMainThread: capability', true],
    ['isMainThread: capability, other: capability', false],
    ['other: capability, isMainThread: capability', true],
  ] as const)('keeps the last destructured assignment authoritative: %s', (fields, expected) => {
    const program = parseAst(`var {${fields}} = flag ? workers : {isMainThread: false};`);
    const { tree, declaration } = firstVariableDeclaration(program);
    const context = {
      tree,
      bindings: nativeBindings(program),
      origin: (node: (typeof tree)[number]) =>
        node.type === 'Identifier' && node.name === 'workers' ? 'namespace' : undefined,
    };

    expect(scalarWorkerBinding(declaration, 'capability', context)).toBe(expected);
  });

  it('does not revisit the whole syntax tree for each distinct binding query', () => {
    const count = 512;
    const names = Array.from({ length: count }, (_, i) => `capability${i}`);
    const declarations = names.map((name) => `const ${name} = source;`).join('');
    const program = parseAst(`${declarations}consume(${names.join(',')});`);
    const tree = walk(program);
    const bindings = nativeBindings(program);
    const references = tree.filter(
      (node) => node.type === 'Identifier' && names.includes(node.name),
    );
    const counter = { visited: 0 };
    for (const node of tree) {
      const type = node.type;
      Object.defineProperty(node, 'type', {
        get() {
          counter.visited += 1;
          return type;
        },
      });
    }
    for (const node of references) {
      if (node.type !== 'Identifier') throw new Error('Expected binding reference');

      expect(bindings.unmodified(node, node.name, false)).toBe(true);
      expect(bindings.unmodified(node, node.name, true)).toBe(true);
    }

    expect(counter.visited).toBeLessThan(tree.length * 4);
  });
});
