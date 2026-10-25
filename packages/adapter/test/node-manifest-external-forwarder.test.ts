import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { directExternalNamespace } from '../src/node-manifest-external-forwarder.ts';
import {
  proveNodeManifestTurbopackConsumers,
  type NodeManifestTurbopackConsumerInput,
} from '../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource as source,
  projectedTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

const SPECIFIER = 'next/dist/compiled/next-server/pages-turbo.runtime.prod.js';
const CALL = `ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}))`;
const DIST = '/project/.next';
const ENTRY = `${DIST}/server/pages/blog/[slug].js`;
const CHUNK = `${DIST}/server/chunks/app.js`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;

function projection(body: string, params = 'ctx,module,exports') {
  return projectNodeManifestTurbopackFactory(
    source(`module.exports=[1,(${params})=>{${body}}];`),
    1,
    'dependencies',
  );
}

async function fixture(
  body = `module.exports=${CALL};`,
  internalId?: number | string,
): Promise<NodeManifestTurbopackConsumerInput> {
  const template = await projectedTemplateFixture('pages');
  const original = template.imports.find((item) => item.file.endsWith('/pages/module.compiled.js'));
  if (original === undefined) throw new Error('Expected the pinned Pages constructor');
  const external = template.imports.filter(
    (item) => !item.specifier.startsWith('turbopack:') && item !== original,
  );
  const file = await realpath(fileURLToPath(import.meta.resolve(SPECIFIER)));
  const producer = source(await readFile(file, 'utf8'));
  const originalCall = `runtimeContext.x(${jsLiteral(original.specifier)},()=>require(${jsLiteral(original.specifier)}))`;
  const code = template.projection.original.code.replace(originalCall, 'runtimeContext.i(2)');
  if (code === template.projection.original.code)
    throw new Error('Expected the original constructor import');
  const slots = [
    ...new Set(
      template.projection.imports.flatMap((item) =>
        item.targetId === undefined ? [] : [item.targetId],
      ),
    ),
  ]
    .map((id) => `${jsLiteral(id)},ctx=>{ctx.s(["default",()=>value]);const value={};},`)
    .join('');
  const chunk = code.replace('module.exports=[', () => {
    const internal =
      internalId === undefined
        ? ''
        : `${jsLiteral(internalId)},(ctx,module,exports)=>{module.exports=${CALL};},`;
    return `module.exports=[${slots}${internal}2,(ctx,module,exports)=>{${body}},`;
  });
  const runtime = (
    await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8')
  )
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  return {
    distDir: DIST,
    rootDir: '/project',
    entries: [{ file: ENTRY, ...template.route }],
    producer: { id: file, file, sha256: producer.sha256, kind: 'pages-class' },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(
          'var R=require("../../chunks/[turbopack]_runtime.js")("server/pages/blog/[slug].js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../../chunks/[turbopack]_runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source(runtime),
        imports: [{ specifier: CHUNK, target: CHUNK }],
      },
      {
        id: CHUNK,
        file: CHUNK,
        source: source(chunk),
        imports: [
          { specifier: SPECIFIER, target: file },
          ...external.map((item) => ({ specifier: item.specifier, target: item.file })),
        ],
      },
      { id: file, file, source: producer, imports: [] },
      ...(await Promise.all(
        external.map(async (item) => {
          return {
            id: item.file,
            file: item.file,
            source: source(await readFile(item.file, 'utf8')),
            imports: [],
          };
        }),
      )),
    ],
  };
}

describe('direct CommonJS external namespace identity', () => {
  it.each([
    `module.exports=${CALL};`,
    `"use strict";module.exports=${CALL};`,
    `module.exports=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),false);`,
    `module.exports=ctx.x(${jsLiteral(SPECIFIER)},function(){return require(${jsLiteral(SPECIFIER)});});`,
  ])('recognizes only the unchanged complete external namespace: %s', (body) => {
    const original = projection(body);

    expect(original.exports).toStrictEqual({ kind: 'commonjs' });
    expect(directExternalNamespace(original)).toBe(SPECIFIER);
    expect(original.original.code).toContain(body);
    expect(original.source.code).toContain('module.exports=require(');
  });

  it('retains the actual identities of renamed CommonJS parameters', () => {
    const original = projection(
      `mod.exports=c.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}));`,
      'c,mod,out',
    );

    expect(directExternalNamespace(original)).toBe(SPECIFIER);
  });

  it.each([
    `module.exports=${CALL}.PagesRouteModule;`,
    `module.exports=${CALL}.default;`,
    `module.exports={namespace:${CALL}};`,
    `module.exports=wrap(${CALL});`,
    `module.exports=(effect(),${CALL});`,
    `effect();module.exports=${CALL};`,
    `module.exports=${CALL};effect();`,
    `module.exports=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),true);`,
    `exports.namespace=${CALL};`,
    `module.exports=(()=>${CALL})();`,
    `const value=${CALL};module.exports=value;`,
  ])('does not classify picking, wrapping, effects or interop as direct identity: %s', (body) => {
    expect(directExternalNamespace(projection(body))).toBeUndefined();
  });

  it.each([
    ['ctx,other,exports', `module.exports=${CALL};`],
    ['ctx,module,require', `module.exports=${CALL};`],
  ])('does not borrow a shadowed or outer CommonJS binding (%s)', (params, body) => {
    expect(() => directExternalNamespace(projection(body, params))).toThrow('Unproved Next.js');
  });

  it('does not confuse a nested ordinary context shadow with the actual runtime binding', () => {
    const original = projection(`module.exports=((ctx)=>${CALL})(other);`);

    expect(directExternalNamespace(original)).toBeUndefined();
  });

  it('rejects duplicate formal identities even in a sloppy function factory', () => {
    const original = source(
      `module.exports=[1,function(ctx,module,module){module.exports=${CALL};}];`,
    );

    expect(() => projectNodeManifestTurbopackFactory(original, 1, 'dependencies')).toThrow(
      'duplicate factory parameter',
    );
  });

  it('cannot borrow another selected registration or changed original source identity', () => {
    const original = projection(`module.exports=${CALL};`);

    expect(() => directExternalNamespace({ ...original, moduleId: 999 })).toThrow(
      'unknown module id',
    );
    expect(() => {
      return directExternalNamespace({
        ...original,
        original: { ...original.original, sha256: '0'.repeat(64) },
      });
    }).toThrow('source');
  });
});

describe('direct CommonJS internal require identity', () => {
  it.each([
    ['module.exports=ctx.r(7);', 'turbopack:7'],
    ['"use strict";module.exports=ctx.r(7);', 'turbopack:7'],
    ["module.exports=ctx.r('7');", 'turbopack:string:"7"'],
  ])('recognizes only the complete required exports: %s', (body, specifier) => {
    const original = projection(body);

    expect(directExternalNamespace(original)).toBe(specifier);
    expect(original.original.code).toContain(body);
  });

  it('retains renamed CommonJS identities for an internal require', () => {
    const original = projection('mod.exports=c.r(7);', 'c,mod,out');

    expect(directExternalNamespace(original)).toBe('turbopack:7');
  });

  it.each([
    'module.exports=ctx.i(7);',
    'module.exports=ctx.r(7).PagesRouteModule;',
    'module.exports={namespace:ctx.r(7)};',
    'module.exports=wrap(ctx.r(7));',
    'module.exports=(effect(),ctx.r(7));',
    'effect();module.exports=ctx.r(7);',
    'module.exports=ctx.r(7);effect();',
    'exports.namespace=ctx.r(7);',
    'module.exports=(()=>ctx.r(7))();',
    'const value=ctx.r(7);module.exports=value;',
    'module.exports=(0,ctx.r)(7);',
  ])('does not classify namespace conversion, picking, wrapping or effects: %s', (body) => {
    expect(directExternalNamespace(projection(body))).toBeUndefined();
  });

  it.each([
    'module.exports=ctx.r(value);',
    'module.exports=ctx.r(7,8);',
    'module.exports=ctx.r?.(7);',
    'module.exports=ctx?.r(7);',
    'module.exports=ctx.r.call(ctx,7);',
    'module.exports=ctx.r(null);',
    'module.exports=ctx["r"](7);',
  ])('retains strict projector refusal for unproved require forms: %s', (body) => {
    expect(() => projection(body)).toThrow('Unproved Next.js');
  });

  it.each([7, '7'])(
    'closes the actual typed registry edge in the protected proof: %s',
    async (id) => {
      const body = `module.exports=ctx.r(${jsLiteral(id)});`;
      const proof = await proveNodeManifestTurbopackConsumers(await fixture(body, id));

      expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([ENTRY]);
    },
  );

  it('does not conflate an internal numeric target with a registered string target', async () => {
    const input = await fixture('module.exports=ctx.r(7);', '7');

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'unregistered module dependency',
    );
  });
});

describe('external namespace forwarding in protected Pages proof', () => {
  it('propagates only the actual reviewed constructor namespace through the strict forwarder', async () => {
    const proof = await proveNodeManifestTurbopackConsumers(await fixture());

    expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([ENTRY]);
    expect(proof.requiresSdkNormalization).toBe(true);
  });

  it.each([
    `module.exports=${CALL}.PagesRouteModule;`,
    `module.exports={namespace:${CALL}};`,
    `effect();module.exports=${CALL};`,
    `module.exports=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),true);`,
  ])('does not turn a changed external value into route authority: %s', async (body) => {
    await expect(proveNodeManifestTurbopackConsumers(await fixture(body))).rejects.toThrow(
      'consumer without a sealed route',
    );
  });

  it('does not infer reviewed authority for an unknown external namespace', async () => {
    const unknown = 'unknown-external';
    const input = await fixture(
      `module.exports=ctx.x(${jsLiteral(unknown)},()=>require(${jsLiteral(unknown)}));`,
    );
    const file = '/project/unknown-external.js';
    const sources = [
      ...input.sources.map((record) => {
        return record.id === CHUNK
          ? {
              ...record,
              imports: [
                { specifier: unknown, target: file },
                ...record.imports.filter((edge) => edge.specifier !== SPECIFIER),
              ],
            }
          : record;
      }),
      { id: file, file, source: source('exports.PagesRouteModule=unknown;'), imports: [] },
    ];

    await expect(proveNodeManifestTurbopackConsumers({ ...input, sources })).rejects.toThrow(
      'unclosed protected factory chain',
    );
  });
});
