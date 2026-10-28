import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { isNode, listOf } from '../src/lexical-scope.ts';
import { inspectExportBindings } from '../src/node-manifest-export-probe.ts';
import { exportBindings } from '../src/node-manifest-turbopack-values.ts';

function table(code: string): unknown {
  const program: unknown = parseAst(`${code};`);
  if (!isNode(program)) throw new Error('Expected authored export program');
  const statement = listOf(program, 'body')[0];
  if (!isNode(statement)) throw new Error('Expected authored export expression');
  return statement['expression'];
}

describe('non-authoritative helper export inspection', () => {
  it.each([
    '[]',
    '({})',
    '[1,()=>value]',
    '["f",function(argument){return argument;}]',
    '["f",()=>{effect();return value;}]',
    '["f",()=>effect()]',
    '["f",0,()=>42]',
    '["f",()=>value,()=>{}]',
  ])('declines unsupported helper exports while keeping the original parser strict: %s', (code) => {
    const value = table(code);

    expect(inspectExportBindings(value)).toBeUndefined();
    expect(() => exportBindings(value)).toThrow('Turbopack manifest');
  });

  it.each(['["f",()=>value]', '["f",0,value]', '["f",()=>namespace.member]'])(
    'keeps the exact supported lexical selectors: %s',
    (code) => {
      const value = table(code);
      const strict = exportBindings(value);
      const probed = inspectExportBindings(value);

      expect(probed).toStrictEqual(strict);
      expect(probed?.[0]?.value).toBe(strict[0]?.value);
    },
  );

  it.each([
    new Error('unexpected parser operation'),
    new AuditError(
      'Unproved Next.js Turbopack manifest context escape; refusing native publication',
    ),
  ])('propagates errors outside the finite export-shape refusals', (error) => {
    const value = new Proxy(
      {},
      {
        get() {
          throw error;
        },
      },
    );

    expect(() => inspectExportBindings(value)).toThrow(error);
  });
});
