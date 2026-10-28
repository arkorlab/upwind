import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { nodeCachePolicyRemovedRanges } from '../src/node-cache-policy.ts';
import {
  certifyNodeJwtCallerPolicy,
  nodeJwtCallerPolicyInspection,
  nodeJwtUnusedCacheImport,
  type NodeJwtCallerPolicyProof,
} from '../src/node-jwt-unused-cache-import.ts';
import {
  previewCertifiedNodeCachePolicy,
  type NodeNextRewriteInput,
  type NodeNextRewriteProof,
} from '../src/node-next-rewrite-proof.ts';

const DECLARATION = 'const load=value=>import(value).then(result=>result.default||result);';
const FIRST = `interop(await load(format(\`\${root}/\${this.distDir}\`,handler)))`;
const SECOND = 'interop(await load(format(this.distDir,handler)))';
const FILE = '/authored/node_modules/next/dist/compiled/next-server/pages.runtime.prod.js';
interface Range {
  readonly start: number;
  readonly end: number;
}

function authored({ declaration = DECLARATION, prefix = '', suffix = '', parameter = '' } = {}) {
  const code = `${prefix}${declaration}async function run(${parameter}){return [${FIRST},${SECOND}]}${suffix}`;
  const original: unknown = parseAst(code, { sourceType: 'commonjs' });
  return { code, original, removed: nodeCachePolicyRemovedRanges(code) };
}

function rangeOf(code: string, expression: string): Range {
  const start = code.indexOf(expression);
  if (start === -1) throw new Error('missing authored expression');
  return { start, end: start + expression.length };
}

describe('unused custom-cache import helper DATA', () => {
  it('recognizes the exact helper without granting any publication authority', () => {
    const own = authored();
    const found = nodeJwtUnusedCacheImport(own);

    expect(found).toStrictEqual({
      status: 'UNQUALIFIED',
      declaration: { start: 0, end: DECLARATION.length },
    });
    expect(own.code.slice(found?.declaration.start ?? -1, found?.declaration.end ?? -1)).toBe(
      DECLARATION,
    );
    expect(own.removed.map(({ start, end }) => own.code.slice(start, end))).toStrictEqual([
      FIRST,
      SECOND,
    ]);
  });

  it.each(['let', 'var'])('keeps the standalone %s helper binding', (kind) => {
    const own = authored({ declaration: DECLARATION.replace('const', () => kind) });

    expect(nodeJwtUnusedCacheImport(own)?.status).toBe('UNQUALIFIED');
  });

  it('uses the actual enclosing scope rather than requiring a Program declaration', () => {
    const own = authored({ prefix: 'function owner(){', suffix: '}' });
    const found = nodeJwtUnusedCacheImport(own);

    expect(found?.status).toBe('UNQUALIFIED');
    expect(own.code.slice(found?.declaration.start ?? -1, found?.declaration.end ?? -1)).toBe(
      DECLARATION,
    );
  });

  it('requires a standalone declaration rather than a loop initializer', () => {
    const code = `async function owner(){for(${DECLARATION.slice(0, -1)};;){return [${FIRST},${SECOND}]}}`;
    const original: unknown = parseAst(code, { sourceType: 'commonjs' });

    expect(
      nodeJwtUnusedCacheImport({ code, original, removed: nodeCachePolicyRemovedRanges(code) }),
    ).toBeUndefined();
  });

  it('declines a var helper that also assigns a mapped owner parameter', () => {
    const own = authored({
      prefix: 'function owner(load){',
      declaration: DECLARATION.replace('const', 'var'),
      suffix: 'exports.saved=arguments[0]}',
    });

    expect(nodeJwtUnusedCacheImport(own)).toBeUndefined();
  });

  it('does not confuse an unrelated same-name shadow with the helper binding', () => {
    const own = authored({ suffix: 'function unrelated(load){return load("ordinary")}' });

    expect(nodeJwtUnusedCacheImport(own)?.status).toBe('UNQUALIFIED');
  });

  it('supports renamed helper and arrow parameters through lexical bindings', () => {
    const code = authored()
      .code.replaceAll('load', 'importModule')
      .replaceAll('value', 'specifier')
      .replaceAll('result', 'namespace');
    const original: unknown = parseAst(code, { sourceType: 'commonjs' });

    expect(
      nodeJwtUnusedCacheImport({ code, original, removed: nodeCachePolicyRemovedRanges(code) })
        ?.status,
    ).toBe('UNQUALIFIED');
  });

  it.each([
    'const load=value=>import(value);',
    'const load=async value=>import(value).then(result=>result.default||result);',
    'const load=value=>import(value).then(async result=>result.default||result);',
    'const load=value=>{return import(value).then(result=>result.default||result)};',
    'const load=function(value){return import(value).then(result=>result.default||result)};',
    'const load=(value=effect())=>import(value).then(result=>result.default||result);',
    'const load=(...value)=>import(value).then(result=>result.default||result);',
    'const load=(value,other)=>import(value).then(result=>result.default||result);',
    'const load=value=>import(other).then(result=>result.default||result);',
    'const load=value=>import(value).then(result=>result.other||result);',
    'const load=value=>import(value).then(result=>result.default||other);',
    'const load=value=>import(value).then(result=>result.default&&result);',
    'const load=value=>import(value).then(result=>{return result.default||result});',
    'const load=value=>import(value).then((result=effect())=>result.default||result);',
    'const load=value=>import(value).then(result=>result.default||result,other);',
    'const load=(effect(),value=>import(value).then(result=>result.default||result));',
    'const load=value=>(()=>import(value).then(result=>result.default||result))();',
    'const load=value=>import(value).then(result=>result.default||result),other=effect();',
    'const {load}={load:value=>import(value).then(result=>result.default||result)};',
    'function load(value){return import(value).then(result=>result.default||result)}',
  ])('declines a different or effectful helper declaration: %s', (declaration) => {
    expect(nodeJwtUnusedCacheImport(authored({ declaration }))).toBeUndefined();
  });

  it.each([
    'load("outside");',
    'const alias=load;',
    'load=other;',
    'load++;',
    'module.exports=load;',
    'exports.load=load;',
    'Object.assign(exports,{load});',
    'function other(){return load("outside")}',
  ])('declines a genuine reference or redefinition outside the removed ranges: %s', (suffix) => {
    expect(nodeJwtUnusedCacheImport(authored({ suffix }))).toBeUndefined();
  });

  it('declines a valid var redeclaration of the helper binding', () => {
    const own = authored({ declaration: DECLARATION.replace('const', 'var'), suffix: 'var load;' });

    expect(nodeJwtUnusedCacheImport(own)).toBeUndefined();
  });

  it('requires genuine helper references in both certified expressions', () => {
    const own = authored({ parameter: 'load' });

    expect(nodeJwtUnusedCacheImport(own)).toBeUndefined();
  });

  it('does not borrow references from a sibling scope with a same-name helper', () => {
    const own = authored({
      prefix: `function unrelated(){${DECLARATION}}`,
      declaration: '',
    });

    expect(nodeJwtUnusedCacheImport(own)).toBeUndefined();
  });

  it('rejects an AST parsed from changed source rather than trusting old ranges', () => {
    const own = authored();
    const original: unknown = parseAst(own.code.replace('result.default', 'result.changed'), {
      sourceType: 'commonjs',
    });

    expect(nodeJwtUnusedCacheImport({ ...own, original })).toBeUndefined();
  });

  it('rejects a source change after the original parse', () => {
    const own = authored();

    expect(nodeJwtUnusedCacheImport({ ...own, code: `${own.code};` })).toBeUndefined();
  });

  it.each([undefined, null, {}, 'program', 0])('declines non-AST input %s', (original) => {
    expect(nodeJwtUnusedCacheImport({ ...authored(), original })).toBeUndefined();
  });

  it.each([
    (first: Range) => [first],
    (first: Range) => [first, first],
    (first: Range, second: Range) => [{ ...first, start: first.start + 1 }, second],
    (first: Range, second: Range) => [{ ...first, end: first.end - 1 }, second],
    (first: Range, second: Range) => [{ start: first.start, end: second.end }, second],
    (first: Range, second: Range) => [first, second, first],
  ])('requires exactly two complete, nonoverlapping original calls %#', (change) => {
    const own = authored();
    const first = rangeOf(own.code, FIRST);
    const second = rangeOf(own.code, SECOND);

    expect(nodeJwtUnusedCacheImport({ ...own, removed: change(first, second) })).toBeUndefined();
  });

  it('does not treat an arbitrary enclosing statement as a removed CallExpression', () => {
    const own = authored();
    const removed = [
      rangeOf(own.code, DECLARATION),
      { start: DECLARATION.length, end: own.code.length },
    ];

    expect(nodeJwtUnusedCacheImport({ ...own, removed })).toBeUndefined();
  });

  it('requires a genuine helper use in each selected range', () => {
    const own = authored({ suffix: 'ordinary();' });
    const removed = [rangeOf(own.code, FIRST), rangeOf(own.code, 'ordinary()')];

    expect(nodeJwtUnusedCacheImport({ ...own, removed })).toBeUndefined();
  });
});

describe('cache import DATA is not a completed rewrite certificate', () => {
  const input: NodeNextRewriteInput = {
    projectDir: '/authored',
    entries: [],
    patch: {
      projectDir: '/authored',
      distDir: '/authored/.next',
      chunks: [],
      instrumentation: undefined,
      wasm: [],
    },
  };

  it('does not obtain certified ranges without an existing completed proof', () => {
    const own = authored();

    expect(nodeJwtUnusedCacheImport(own)?.status).toBe('UNQUALIFIED');
    expect(
      previewCertifiedNodeCachePolicy(undefined, input, { file: FILE, code: own.code }),
    ).toBeUndefined();
  });

  it('rejects an unrecognized opaque certificate despite valid authored DATA', () => {
    const own = authored();
    const forged = {} as NodeNextRewriteProof;

    expect(() =>
      previewCertifiedNodeCachePolicy(forged, input, { file: FILE, code: own.code }),
    ).toThrow('certificate');
  });

  it('does not mint a private caller policy from unqualified DATA without rewrite proof', () => {
    const own = authored();

    expect(
      certifyNodeJwtCallerPolicy({ rewrites: undefined, input, file: FILE, code: own.code }),
    ).toBeUndefined();
  });

  it('rejects an unrecognized rewrite certificate before minting a caller policy', () => {
    const own = authored();

    expect(() => {
      return certifyNodeJwtCallerPolicy({
        rewrites: {} as NodeNextRewriteProof,
        input,
        file: FILE,
        code: own.code,
      });
    }).toThrow('certificate');
  });

  it('rejects an unrecognized caller policy before inspecting original source', () => {
    const own = authored();

    expect(() => {
      return nodeJwtCallerPolicyInspection({} as NodeJwtCallerPolicyProof, {
        file: FILE,
        code: own.code,
      });
    }).toThrow('copied policy proof');
  });
});
