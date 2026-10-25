import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { exportBindings, singleDirectExportValue } from '../src/node-manifest-turbopack-values.ts';

function table(value: string) {
  const statement = parseAst(`["selected",0,${value}];`).body[0];
  assert(statement?.type === 'ExpressionStatement');
  return statement.expression;
}

describe('inspection of a single direct export value', () => {
  it.each(['function(){}', '()=>42', '42', 'effect()'])(
    'retains the original %s node without granting a static export profile',
    (value) => {
      const input = table(value);
      const selected = singleDirectExportValue(input, 'selected');

      expect(selected).toBe(input.type === 'ArrayExpression' ? input.elements[2] : undefined);
      expect(singleDirectExportValue(input, 'other')).toBeUndefined();
      expect(() => exportBindings(input)).toThrow('export value expression');
    },
  );
});
