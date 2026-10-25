import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';

function unchanged(loop: string, members: boolean): boolean {
  const program = parseAst(`let capability=source;${loop};consume(capability);`);
  const uses = walk(program).filter(
    (node) => node.type === 'Identifier' && node.name === 'capability',
  );
  let last = uses[0];
  for (const use of uses) if (last === undefined || use.start > last.start) last = use;
  if (last === undefined) throw new Error('Expected the authored capability reference');
  return nativeBindings(program).unmodified(last, 'capability', members);
}

describe('native binding loop assignment targets', () => {
  it.each([
    'for(capability of values){}',
    'for(capability in values){}',
    'for(var capability of values){}',
    'for({value:capability} of values){}',
    'for([capability] of values){}',
    'for({value:capability=fallback} of values){}',
  ])('refuses a loop write to the original binding: %s', (loop) => {
    expect(unchanged(loop, false)).toBe(false);
    expect(unchanged(loop, true)).toBe(false);
  });

  it.each([
    'for(capability.value of values){}',
    'for(capability.value in values){}',
    'for({value:capability.value} of values){}',
    'for([capability.value] of values){}',
  ])('distinguishes member writes from binding replacement: %s', (loop) => {
    expect(unchanged(loop, false)).toBe(true);
    expect(unchanged(loop, true)).toBe(false);
  });

  it.each([
    'for(let capability of values){}',
    'for(const capability of values){}',
    'for(let capability in values){}',
    'for(const row of values){row.capability=1;}',
  ])('keeps a distinct lexical loop binding independent: %s', (loop) => {
    expect(unchanged(loop, false)).toBe(true);
    expect(unchanged(loop, true)).toBe(true);
  });
});
