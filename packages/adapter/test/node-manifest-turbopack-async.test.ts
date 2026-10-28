import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
} from '../src/node-manifest-turbopack.ts';

const LOADER =
  'ctx.v((parentImport)=>{return Promise.all(["server/chunks/dep.js"].map((chunk)=>ctx.l(chunk))).then(()=>{return parentImport(2);});});';

function source(body: string, ids = '1') {
  const code = `module.exports=[${ids},((ctx)=>{${body}})];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function project(body: string, id: NodeManifestTurbopackModuleId = 1, ids = '1') {
  return projectNodeManifestTurbopackFactory(source(body, ids), id, 'dependencies');
}

describe('finite original AsyncLoaderModule producer', () => {
  it.each([
    LOADER,
    'ctx.v(parentImport=>Promise.all(["server/chunks/dep.js"].map(chunk=>ctx.l(chunk))).then(()=>parentImport(2)));',
    'ctx.v(function(parentImport){return Promise.all(["server/chunks/dep.js"].map(function(chunk){return ctx.l(chunk);})).then(function(){return parentImport(2);});});',
  ])('certifies the fixed callback bindings without rewriting its bytes: %s', (body) => {
    const projected = project(body);

    expect(projected.asyncLoader).toStrictEqual({ targetId: 2, chunks: ['server/chunks/dep.js'] });
    expect(projected.asyncLoads).toStrictEqual([]);
    expect(projected.imports).toStrictEqual([
      { kind: 'import', specifier: 'turbopack:2', targetId: 2 },
    ]);
    expect(projected.source.code.trim()).toBe(body);
    expect(projected.original).toStrictEqual(source(body));
    expect(Object.isFrozen(projected.asyncLoader)).toBe(true);
    expect(Object.isFrozen(projected.asyncLoader?.chunks)).toBe(true);
  });

  it('certifies the primary no-chunk Promise.resolve branch with a static target', () => {
    const body =
      'ctx.v((parentImport)=>{return Promise.resolve().then(()=>{return parentImport("2");});});';
    const projected = project(body);

    expect(projected.asyncLoader).toStrictEqual({ targetId: '2', chunks: [] });
    expect(projected.imports).toStrictEqual([
      { kind: 'import', specifier: 'turbopack:string:"2"', targetId: '2' },
    ]);
    expect(projected.source.code.trim()).toBe(body);
  });

  it('validates literal serde metadata while recording only the path Node actually loads', () => {
    const object =
      '{path:"server/chunks/dep.js",included:[2,"2"],excluded:[3],moduleChunks:["server/chunks/style.css"]}';
    const body = LOADER.replace('"server/chunks/dep.js"', () => object);
    const projected = project(body);

    expect(projected.asyncLoader).toStrictEqual({ targetId: 2, chunks: ['server/chunks/dep.js'] });
    expect(projected.source.code).toContain(object);
    expect(projected.imports.map((item) => item.targetId)).toStrictEqual([2]);
  });

  it('binds a loader only to its selected runtime export ID in a merged registration', () => {
    const body = LOADER.replace('});});', '});},1);');
    const first = project(body, 1, '1,3');
    const other = project(body, 3, '1,3');

    expect(first.asyncLoader).toStrictEqual({ targetId: 2, chunks: ['server/chunks/dep.js'] });
    expect(other.asyncLoader).toBeUndefined();
    expect(other.imports).toStrictEqual(first.imports);
  });

  it.each([2, '2'] as const)(
    'records a static ctx.A(%j) call without replacing it with a synchronous require',
    (id) => {
      const literal = jsLiteral(id);
      const body = `var result=ctx.A(${literal});ctx.v(result);`;
      const projected = project(body);

      expect(projected.asyncLoads).toStrictEqual([id]);
      expect(projected.imports.map((item) => item.targetId)).toStrictEqual([id]);
      expect(projected.source.code.trim()).toBe(body);
      expect(Object.isFrozen(projected.asyncLoads)).toBe(true);
    },
  );

  it('does not certify a context shadow or an unrelated ordinary Promise callback', () => {
    const shadow = LOADER.replace('(chunk)=>ctx.l(chunk)', '(ctx)=>ctx.l(ctx)');
    const ordinary = 'ctx.v(value=>Promise.resolve(value).then(result=>result));';

    expect(project(shadow).asyncLoader).toBeUndefined();
    expect(project(ordinary).asyncLoader).toBeUndefined();
  });

  it.each([
    ['dynamic chunk list', LOADER.replace('["server/chunks/dep.js"]', 'paths')],
    ['spread chunks', LOADER.replace('["server/chunks/dep.js"]', '[...paths]')],
    ['relative traversal', LOADER.replace('server/chunks/dep.js', '../dep.js')],
    ['absolute path', LOADER.replace('server/chunks/dep.js', '/server/chunks/dep.js')],
    ['URL path', LOADER.replace('server/chunks/dep.js', 'https://example.com/dep.js')],
    ['query path', LOADER.replace('server/chunks/dep.js', 'server/chunks/dep.js?extra')],
    ['non-JavaScript load', LOADER.replace('server/chunks/dep.js', 'server/chunks/style.css')],
    [
      'unknown metadata',
      LOADER.replace('"server/chunks/dep.js"', '{path:"server/chunks/dep.js",unknown:true}'),
    ],
    [
      'metadata getter',
      LOADER.replace(
        '"server/chunks/dep.js"',
        '{get path(){return "server/chunks/dep.js"},included:[2]}',
      ),
    ],
    [
      'dynamic metadata id',
      LOADER.replace('"server/chunks/dep.js"', '{path:"server/chunks/dep.js",included:[unknown]}'),
    ],
    [
      'metadata spread',
      LOADER.replace('"server/chunks/dep.js"', '{path:"server/chunks/dep.js",...other}'),
    ],
    [
      'callback alias',
      LOADER.replace('return parentImport(2);', 'const imported=parentImport;return imported(2);'),
    ],
    ['dynamic target', LOADER.replace('parentImport(2)', 'parentImport(target)')],
    ['spread target', LOADER.replace('parentImport(2)', 'parentImport(...ids)')],
    [
      'target rebinding',
      LOADER.replace('return parentImport(2);', 'parentImport=other;return parentImport(2);'),
    ],
    [
      'mapper rebinding',
      LOADER.replace('(chunk)=>ctx.l(chunk)', '(chunk)=>{chunk=other;return ctx.l(chunk);}'),
    ],
    ['direct mapper capability', LOADER.replace('(chunk)=>ctx.l(chunk)', 'ctx.l')],
    [
      'extra continuation effect',
      LOADER.replace('return parentImport(2);', 'sideEffect();return parentImport(2);'),
    ],
    ['continuation shadow', LOADER.replace('.then(()=>', '.then((parentImport)=>')],
    ['async callback', LOADER.replace('(parentImport)=>', 'async(parentImport)=>')],
    ['named callback', LOADER.replace('(parentImport)=>', 'function named(parentImport)')],
    ['Promise shadow', LOADER.replaceAll('parentImport', 'Promise')],
    ['additional factory mutation', `Promise.all=other;${LOADER}`],
    ['additional value export', `${LOADER}ctx.v(other);`],
    ['additional context use', `${LOADER}ctx.l("server/chunks/other.js");`],
    ['standalone path load', 'ctx.l("server/chunks/dep.js");ctx.v(42);'],
    ['dynamic async loader ID', 'ctx.v(ctx.A(loaderId));'],
    ['spread async loader ID', 'ctx.v(ctx.A(...loaderIds));'],
    ['async loader capability alias', 'const load=ctx.A;ctx.v(load);'],
  ])('refuses %s instead of granting a generic runtime loader', (_name, body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });

  it.each([LOADER, 'ctx.v(ctx.A(2));'])(
    'does not widen strict protected projection for %s',
    (body) => {
      expect(() => projectNodeManifestTurbopackFactory(source(body), 1)).toThrow(
        'Unproved Next.js',
      );
    },
  );
});
