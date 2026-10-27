import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import { nodeNextCacheWriteData } from '../src/node-next-cache-write-data.ts';

function program(code: string, sourceType: 'commonjs' | 'module' = 'commonjs'): Node {
  const parsed: unknown = parseAst(code, { sourceType });
  if (!isNode(parsed)) throw new Error('Authored parser result is not a program');
  return parsed;
}

function rootOf(parsed: Node): Node {
  const write = visitTree(parsed).find((visit) => visit.node.type === 'AssignmentExpression');
  const left = write?.node['left'];
  const root = isNode(left) ? left['object'] : undefined;
  if (!isNode(root)) throw new Error('Authored cache write has no root');
  return root;
}

function optionalMember(parsed: Node): Node {
  const assignment = visitTree(parsed).find((visit) => visit.node.type === 'AssignmentExpression');
  const write = assignment?.node;
  const left = write?.['left'];
  if (write === undefined || !isNode(left)) throw new Error('Authored cache write has no member');
  return {
    ...parsed,
    body: listOf(parsed, 'body').map((statement) => {
      return isNode(statement) && statement.type === 'ExpressionStatement'
        ? { ...statement, expression: { ...write, left: { ...left, optional: true } } }
        : statement;
    }),
  };
}

const DIRECT = 'const cache=new Cache();globalThis.__incrementalCache=cache;';

describe('fixed Next cache write syntax DATA only', () => {
  it.each([
    DIRECT,
    'let cache=new cacheModule.Cache({ready:true});globalThis.__incrementalCache=cache;',
    'function setup(){var cache=new Cache;globalThis.__incrementalCache=cache;return cache;}',
    '(()=>{const cache=new Cache();globalThis.__incrementalCache=cache;})();',
    'globalThis.process;const cache=new Cache();globalThis.__incrementalCache=cache;globalThis.__incrementalCache;',
  ])('records the one original root without executing the constructor: %s', (code) => {
    const parsed = program(code);
    const before = JSON.stringify(parsed);
    const root = rootOf(parsed);
    const data = nodeNextCacheWriteData(parsed);

    expect(data?.qualification).toBe('UNQUALIFIED DATA');
    expect(data?.roots.size).toBe(1);
    expect(data?.roots.has(root)).toBe(true);
    expect(data?.roots.has({ ...root })).toBe(false);
    expect(Object.isFrozen(data)).toBe(true);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  it.each([
    'globalThis.__incrementalCache=process;',
    'const cache=module;globalThis.__incrementalCache=cache;',
    'const cache=makeCache();globalThis.__incrementalCache=cache;',
    'function setup(cache){globalThis.__incrementalCache=cache;}',
    'function setup(cache){var cache=new Cache();globalThis.__incrementalCache=cache;}',
    'const cache=new Cache();function nested(){globalThis.__incrementalCache=cache;}',
    'let cache;cache=new Cache();globalThis.__incrementalCache=cache;',
    'var cache;var cache=new Cache();globalThis.__incrementalCache=cache;',
    'var cache=new Cache();var cache;globalThis.__incrementalCache=cache;',
    'function setup(){var cache=new Cache();function cache(){}globalThis.__incrementalCache=cache;}',
    'const original=new Cache();const cache=original;globalThis.__incrementalCache=cache;',
    'let cache=new Cache();cache=other;globalThis.__incrementalCache=cache;',
    'let cache=new Cache();cache++;globalThis.__incrementalCache=cache;',
    'const cache=new Cache();cache.field=other;globalThis.__incrementalCache=cache;',
    'let cache=new Cache();({cache}=other);globalThis.__incrementalCache=cache;',
    'globalThis.__incrementalCache=cache;var cache=new Cache();',
    'const cache=new Cache();globalThis["__incrementalCache"]=cache;',
    'const cache=new Cache();globalThis[key]=cache;',
    'const cache=new Cache();globalThis.__incrementalCache+=cache;',
    'const cache=new Cache();globalThis.other=cache;',
    'globalThis.__incrementalCache=new Cache();',
    'const globalThis={};const cache=new Cache();globalThis.__incrementalCache=cache;',
    'function setup(globalThis){const cache=new Cache();globalThis.__incrementalCache=cache;}',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis.__incrementalCache=cache;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis=other;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis.Function=other;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis[key]=other;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis.deep.value=other;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;delete globalThis.other;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;globalThis.other++;',
    'const cache=new Cache();globalThis.__incrementalCache=cache;for(globalThis.other of values){}',
    'const cache=new Cache();globalThis.__incrementalCache=cache;({x:globalThis.other}=other);',
    'const cache=new Cache();with(unknown){globalThis.__incrementalCache=cache;}',
  ])('declines an ambiguous or different original shape: %s', (code) => {
    expect(nodeNextCacheWriteData(program(code))).toBeUndefined();
  });

  it('declines an imported right-hand binding', () => {
    const parsed = program(
      'import cache from "authored";globalThis.__incrementalCache=cache;',
      'module',
    );

    expect(nodeNextCacheWriteData(parsed)).toBeUndefined();
  });

  it('declines optional member DATA without rewriting the original parser tree', () => {
    const parsed = program(DIRECT);
    const altered = optionalMember(parsed);

    expect(nodeNextCacheWriteData(altered)).toBeUndefined();
    expect(nodeNextCacheWriteData(parsed)?.roots.has(rootOf(parsed))).toBe(true);
  });

  it('does not authenticate copied roots or caller-supplied shape flags', () => {
    const first = program(DIRECT);
    const second = program(DIRECT);
    const data = nodeNextCacheWriteData(first);

    expect(data?.roots.has(rootOf(second))).toBe(false);
    expect(
      nodeNextCacheWriteData({ qualification: 'UNQUALIFIED DATA', roots: data?.roots }),
    ).toBeUndefined();
    expect(nodeNextCacheWriteData(undefined)).toBeUndefined();
  });
});
