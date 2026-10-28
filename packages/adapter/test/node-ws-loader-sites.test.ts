import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { isNode } from '../src/lexical-scope.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import type { ManifestModuleGraph } from '../src/node-manifest-graph.ts';
import {
  nodeWsGuardRecord,
  nodeWsLoaderMetadata,
  nodeWsLoaderSites,
  qualifyNodeWsLoaders,
  type NodeWsLoaderInput,
  type NodeWsLoaderProof,
} from '../src/node-ws-loader-proof.ts';
import { nodeWsStaticLoaderSites } from '../src/node-ws-loader-sites.ts';

const BUFFER = 'module.exports=eval("require")("bufferutil");';
const UTF8 = 'module.exports=eval("require")("utf-8-validate");';

function source({
  first = BUFFER,
  second = UTF8,
  parameters = 'module',
  prefix = '',
  suffix = '',
} = {}) {
  return `${prefix}(()=>{const table={1:(${parameters})=>{${first}},2:module=>{${second}}};})();${suffix}`;
}

function program(code: string) {
  const original: unknown = parseAst(code, { sourceType: 'commonjs' });
  if (!isNode(original)) throw new Error('missing authored program');
  return original;
}

function inspect(options: Parameters<typeof source>[0]) {
  return nodeWsStaticLoaderSites(program(source(options)));
}

function candidateGraph(retained: boolean): ManifestModuleGraph {
  const file = '/authored/unavailable/node_modules/next/dist/compiled/ws/index.js';
  return {
    sources: new Map([[file, { file, sha256: 'unqualified authored source' }]]),
    importers: new Map([[file, []]]),
    imports: new Map([[file, []]]),
    retained: new Set(retained ? [file] : []),
    rendered: new Map([[file, source()]]),
  };
}

describe('fixed ws loader site DATA', () => {
  it('returns only the two actual original eval identifiers and literal targets', () => {
    const code = source();
    const original = program(code);
    const nodes = new Set(visitTree(original).map(({ node }) => node));
    const sites = nodeWsStaticLoaderSites(original);

    expect(
      sites?.map(({ specifier }) => specifier).toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['bufferutil', 'utf-8-validate']);
    expect(sites).toHaveLength(2);

    assert.isDefined(sites);

    for (const site of sites) {
      expect(nodes.has(site.node)).toBe(true);
      expect(site.node.type).toBe('Identifier');
      expect(code.slice(site.node.start, site.node.end)).toBe('eval');
    }

    // Shape recognition alone never authorizes this original source's compiler operations.
    expect(dynamicNodeClosureRefusal('/authored/ws-mini.cjs', code)).toContain('compiler');
  });

  it('keeps unconnected local eval and require shadows outside the actual loader sites', () => {
    const code = source({
      suffix: 'function local(eval,require){return [eval("ordinary"),require("ordinary")]}',
    });

    expect(nodeWsStaticLoaderSites(program(code))).toHaveLength(2);
  });

  it('recognizes both package roles independently of source ordering', () => {
    const code = source({ first: UTF8, second: BUFFER });

    expect(
      nodeWsStaticLoaderSites(program(code))
        ?.map(({ specifier }) => specifier)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(['bufferutil', 'utf-8-validate']);
  });

  it.each([
    'module.exports=eval("require");',
    'const loader=eval("require");module.exports=loader("bufferutil");',
    'module.exports=(0,eval)("require")("bufferutil");',
    'module.exports=globalThis.eval("require")("bufferutil");',
    'module.exports=globalThis["eval"]("require")("bufferutil");',
    'module.exports=eval?.("require")("bufferutil");',
    'module.exports=eval("require")?.("bufferutil");',
    'module.exports=new (eval("require"))("bufferutil");',
    'module.exports=eval(`require`)("bufferutil");',
    'module.exports=eval("requ"+"ire")("bufferutil");',
    'module.exports=eval(code)("bufferutil");',
    'module.exports=eval("require",other)("bufferutil");',
    'module.exports=eval(...["require"])("bufferutil");',
    'module.exports=eval("require")(`bufferutil`);',
    'module.exports=eval("require")(name);',
    'module.exports=eval("require")("buffer"+"util");',
    'module.exports=eval("require")("bufferutil",other);',
    'module.exports=eval("require")(...["bufferutil"]);',
    'module.exports=eval("require")("unknown");',
    'module.exports=eval("require")("bufferutil/subpath");',
    'module.exports=eval("require")("node:bufferutil");',
    'module.exports=eval("require").call(null,"bufferutil");',
    'module.exports=eval("require").bind(null)("bufferutil");',
    'module.exports=Function("return require")()("bufferutil");',
    'module.exports=eval("require(name)")("bufferutil");',
  ])('declines a different evaluation or loader operation: %s', (first) => {
    expect(inspect({ first })).toBeUndefined();
  });

  it.each([
    { first: '', second: UTF8 },
    { first: BUFFER, second: '' },
    { first: BUFFER, second: BUFFER },
    { first: UTF8, second: UTF8 },
    { first: `${BUFFER}${BUFFER}`, second: UTF8 },
    { first: BUFFER, second: `${UTF8}${UTF8}` },
  ])('requires exactly one original site for each fixed package role %#', (options) => {
    expect(inspect(options)).toBeUndefined();
  });

  it.each([
    'eval("ordinary");',
    'const evaluate=eval;',
    'Function("return 1");',
    'const Compiler=Function;',
    'const bind=Function.prototype.bind;',
    'globalThis.eval("ordinary");',
  ])('does not grant a whole-program compiler exception: %s', (suffix) => {
    expect(inspect({ suffix })).toBeUndefined();
  });

  it.each(['module,eval', 'module,require'])(
    'declines a shadowed lexical loader: %s',
    (parameters) => {
      expect(inspect({ parameters })).toBeUndefined();
    },
  );

  it.each(['var require=custom;', 'const require=custom;', 'require=custom;', 'eval=custom;'])(
    'declines changed surrounding loader bindings: %s',
    (prefix) => {
      expect(inspect({ prefix })).toBeUndefined();
    },
  );

  it('does not assume a with environment preserves the Node loader lookup', () => {
    const code = `with(environment){${source()}}`;

    expect(nodeWsStaticLoaderSites(program(code))).toBeUndefined();
  });

  it.each([undefined, null, {}, 0, 'program text'])('declines non-AST input %s', (original) => {
    expect(nodeWsStaticLoaderSites(original)).toBeUndefined();
  });
});

describe('ws site DATA is not a private loader proof', () => {
  it('has no authorized sites without an opaque proof despite valid authored DATA', () => {
    const code = source();
    const original = program(code);

    expect(nodeWsStaticLoaderSites(original)).toHaveLength(2);
    expect(nodeWsLoaderSites(undefined, '/authored/vendor.cjs', code, original).size).toBe(0);
  });

  it('rejects an unrecognized proof before sites, metadata or archive records are used', async () => {
    const code = source();
    const original = program(code);
    const forged = {} as NodeWsLoaderProof;

    expect(() => nodeWsLoaderSites(forged, '/authored/vendor.cjs', code, original)).toThrow(
      'copied compiler proof',
    );
    await expect(nodeWsLoaderMetadata(forged)).rejects.toThrow('copied compiler proof');
    await expect(nodeWsGuardRecord(forged, () => 'vendor.cjs')).rejects.toThrow(
      'copied compiler proof',
    );
  });

  it('leaves graphs without a retained ws source outside qualification', async () => {
    const graph: ManifestModuleGraph = {
      sources: new Map(),
      importers: new Map(),
      imports: new Map(),
      retained: new Set(),
      rendered: new Map(),
    };

    // No mode/SDK proof is invented, and no actual resolver is reached by this branch.
    await expect(qualifyNodeWsLoaders({ graph } as NodeWsLoaderInput)).resolves.toBeUndefined();
  });

  it('does not qualify a pruned source row or attempt optional target resolution', async () => {
    const graph = candidateGraph(false);

    await expect(qualifyNodeWsLoaders({ graph } as NodeWsLoaderInput)).resolves.toBeUndefined();
  });

  it('requires real source/SDK mode proof for retained candidates before any resolver call', async () => {
    const graph = candidateGraph(true);

    // The private mode check fails first; no valid mode/route token or package fixture exists.
    await expect(qualifyNodeWsLoaders({ graph } as NodeWsLoaderInput)).rejects.toThrow(
      'copied or missing scope',
    );
  });
});
