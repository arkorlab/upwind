import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { isNode } from '../src/lexical-scope.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import { nodeNextStaticRequireHookSites } from '../src/node-next-require-hook-sites.ts';

function source() {
  return (
    'const path=require("path"),mod=require("module");const originalRequire=mod.prototype.require;const resolveFilename=mod._resolveFilename;const map=new Map();' +
    'mod._resolveFilename=(function(resolve,requestMap,request,parent,isMain,options){const target=requestMap.get(request);if(target)request=target;return resolve.call(mod,request,parent,isMain,options);}).bind(null,resolveFilename,map);' +
    `mod.prototype.require=function(request){if(request.endsWith(".shared-runtime")){return originalRequire.call(this,\`next/dist/server/route-modules/pages/vendored/contexts/\${path.basename(request,".shared-runtime")}\`);}return originalRequire.call(this,request);};`
  );
}
function program(code: string) {
  const parsed: unknown = parseAst(code, { sourceType: 'commonjs' });
  if (!isNode(parsed)) throw new Error('missing authored program');
  return parsed;
}

describe('fixed original require-hook operation DATA', () => {
  it('returns only actual operation and namespace operand nodes without changing the AST', () => {
    const code = source();
    const original = program(code);
    const before = JSON.stringify(original);
    const sites = nodeNextStaticRequireHookSites(original);
    const nodes = new Set(visitTree(original).map(({ node }) => node));
    assert.isDefined(sites);

    expect(sites.operations.size).toBe(8);
    expect(sites.namespaceOperands.size).toBe(1);

    for (const node of sites.operations) {
      expect({ actual: nodes.has(node), type: node.type }).toStrictEqual({
        actual: true,
        type: 'MemberExpression',
      });
    }
    for (const node of sites.namespaceOperands) {
      expect(nodes.has(node)).toBe(true);
      expect(code.slice(node.start, node.end)).toBe('mod');
    }

    expect(JSON.stringify(original)).toBe(before);
    expect(
      [...sites.operations].filter(
        (node) => code.slice(node.start, node.end) === 'originalRequire.call',
      ),
    ).toHaveLength(2);
    expect(dynamicNodeClosureRefusal('/authored/require-hook.cjs', code)).toBeTypeOf('string');
  });

  it('tracks lexical identities under local shadowing and renamed roles', () => {
    const code = `${source()
      .replaceAll('originalRequire', 'captured')
      .replaceAll(/\bresolveFilename\b/gu, 'saved')
      .replaceAll(
        /\bmod\b/gu,
        'moduleValue',
      )}function local(moduleValue){return moduleValue._load("ordinary")}`;

    expect(nodeNextStaticRequireHookSites(program(code))?.operations.size).toBe(8);
  });

  it.each([
    ['computed capture', 'mod._resolveFilename', 'mod["_resolveFilename"]'],
    ['optional capture', 'mod.prototype.require', 'mod?.prototype.require'],
    ['different map lookup', 'requestMap.get(request)', 'requestMap.get(other)'],
    [
      'additional resolver effect',
      'if(target)request=target;',
      'if(target)request=target;sideEffect();',
    ],
    ['wrong resolver receiver', 'resolve.call(mod,', 'resolve.call(other,'],
    ['different shared-runtime target', 'pages/vendored/contexts/', 'app-page/vendored/contexts/'],
    [
      'different basename suffix',
      'path.basename(request,".shared-runtime")',
      'path.basename(request,".other")',
    ],
    [
      'changed fallback receiver',
      'originalRequire.call(this,request)',
      'originalRequire.call(other,request)',
    ],
    [
      'extra require effect',
      'return originalRequire.call(this,request);',
      'sideEffect();return originalRequire.call(this,request);',
    ],
    [
      'different bind receiver',
      '.bind(null,resolveFilename,map)',
      '.bind(other,resolveFilename,map)',
    ],
    ['different resolver binding', '.bind(null,resolveFilename,map)', '.bind(null,other,map)'],
    [
      'shadowed Module namespace',
      'function(resolve,requestMap,request,parent,isMain,options)',
      'function(resolve,requestMap,mod,parent,isMain,options)',
    ],
  ])('declines %s', (_title, before, after) => {
    const changed = source().replace(before, () => after);
    const sites = nodeNextStaticRequireHookSites(program(changed));

    expect(sites).toBeUndefined();
  });

  it.each([
    'exports.module=mod;',
    'mod._load("unknown");',
    'mod=other;',
    'exports.require=originalRequire;',
    'exports.resolve=resolveFilename;',
    'originalRequire("unknown");',
    'originalRequire.call(this,"unknown");',
    'resolveFilename=other;',
    'map=other;',
    'path=other;',
  ])('does not admit another namespace or captured loader use: %s', (suffix) => {
    const sites = nodeNextStaticRequireHookSites(program(source() + suffix));

    expect(sites).toBeUndefined();
  });

  it.each([undefined, null, {}, 0, 'source'])('declines non-AST input %s', (input) => {
    expect(nodeNextStaticRequireHookSites(input)).toBeUndefined();
  });
});
