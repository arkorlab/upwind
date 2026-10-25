import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertNodeManifestConsumer,
  type NodeManifestConsumerInput,
} from '../src/node-manifest-consumers.ts';

const SPECIFIER = 'next/dist/build/templates/app-page-runtime.js';
const PRODUCER = {
  specifier: SPECIFIER,
  file: `/project/node_modules/${SPECIFIER}`,
  sha256: '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b',
  kind: 'app-page-factory' as const,
  exportName: 'createAppPageEntrypoint',
};
const ROUTE = { page: '/(group)/native/page', pathname: '/native' };
const ARGUMENT =
  '{tree,page:"/(group)/native/page",pathname:"/native",require:__next_app_require__,loadChunk:__next_app_load_chunk__,interopDefault}';

/** Source-equivalent tiny producer projections; not a claim that every compiled form is supported. */
function source(format: 'esm' | 'commonjs' = 'esm'): string {
  if (format === 'commonjs')
    return [
      `const producer=require(${JSON.stringify(SPECIFIER)});`,
      `const entrypoint=(0,producer.createAppPageEntrypoint)(${ARGUMENT});`,
      'exports.__next_app__=entrypoint.__next_app__;',
      'exports.routeModule=entrypoint.routeModule;',
      'exports.handler=entrypoint.handler;',
    ].join('\n');
  return [
    `import {createAppPageEntrypoint} from ${JSON.stringify(SPECIFIER)};`,
    `const entrypoint=createAppPageEntrypoint(${ARGUMENT});`,
    'export const __next_app__=entrypoint.__next_app__;',
    'export const routeModule=entrypoint.routeModule;',
    'export const handler=entrypoint.handler;',
  ].join('\n');
}

function input(code = source()): NodeManifestConsumerInput {
  return {
    source: { code, sha256: createHash('sha256').update(code).digest('hex') },
    imports: [PRODUCER],
    route: ROUTE,
  };
}

describe('sealed Next manifest consumers', () => {
  it.each(['esm', 'commonjs'] as const)(
    'retains only the sealed %s producer exports with a normalization obligation',
    (format) => {
      const proof = assertNodeManifestConsumer(input(source(format)));

      expect(proof).toStrictEqual({
        kind: 'app-page-template',
        ...ROUTE,
        exports: ['__next_app__', 'routeModule', 'handler'],
        requiresRuntimeNormalization: true,
      });
    },
  );

  it('tracks a renamed import without confusing an unrelated shadowed factory', () => {
    const code = `${source()
      .replaceAll('createAppPageEntrypoint', 'createAppPageEntrypoint as make')
      .replace(
        'const entrypoint=createAppPageEntrypoint as make',
        'const entrypoint=make',
      )}\nfunction unrelated(make){return make("other");}`;

    expect(assertNodeManifestConsumer(input(code)).pathname).toBe('/native');
  });

  it('allows only matching explicit named exports after their original selectors', () => {
    const code = `${source().replaceAll(
      'export const ',
      'const ',
    )}\nexport {__next_app__,routeModule,handler};`;

    expect(assertNodeManifestConsumer(input(code)).exports).toStrictEqual([
      '__next_app__',
      'routeModule',
      'handler',
    ]);
  });

  it('recognizes the exact published 16.4.3 app-page template export scaffold without evaluating it', async () => {
    const template = await readFile(
      fileURLToPath(import.meta.resolve('next/dist/build/templates/app-page.js')),
      'utf8',
    );
    const code = template
      .replaceAll('VAR_DEFINITION_PAGE', () => ROUTE.page)
      .replaceAll('VAR_DEFINITION_PATHNAME', () => ROUTE.pathname);
    const own = input(code);
    const proof = assertNodeManifestConsumer({
      ...own,
      imports: [{ ...PRODUCER, specifier: './app-page-runtime' }],
    });

    expect(proof).toStrictEqual({
      kind: 'app-page-template',
      ...ROUTE,
      exports: ['__next_app__', 'routeModule', 'handler'],
      requiresRuntimeNormalization: true,
    });
  });

  it.each(['assignment', 'alias', 're-export'] as const)(
    'does not trust an export-helper %s after matching its declaration',
    async (change) => {
      const template = await readFile(
        fileURLToPath(import.meta.resolve('next/dist/build/templates/app-page.js')),
        'utf8',
      );
      const replacement = {
        assignment: '_export = function(target, all) {};',
        alias: 'const escaped = _export;',
        're-export': 'exports.helper = _export;',
      }[change];
      const code = template
        .replaceAll('VAR_DEFINITION_PAGE', () => ROUTE.page)
        .replaceAll('VAR_DEFINITION_PATHNAME', () => ROUTE.pathname)
        .replace('_export(exports, {', () => `${replacement}\n_export(exports, {`);
      const own = input(code);

      expect(() => {
        return assertNodeManifestConsumer({
          ...own,
          imports: [{ ...PRODUCER, specifier: './app-page-runtime' }],
        });
      }).toThrow('Unproved Next.js manifest consumer');
    },
  );

  it.each([
    ['different page', source().replace('page:"/(group)/native/page"', 'page:"/unowned/page"')],
    ['different pathname', source().replace('pathname:"/native"', 'pathname:"/other"')],
    ['dynamic page', source().replace('page:"/(group)/native/page"', 'page:process.env.PAGE')],
    ['extra field', source().replace('tree,page:', 'distDir:"/tmp",tree,page:')],
    ['spread field', source().replace('tree,page:', '...options,tree,page:')],
    ['computed field', source().replace('tree,page:', 'tree,["page"]:')],
    [
      'namespace alias',
      source('commonjs').replace('const entrypoint=', 'const escaped=producer;const entrypoint='),
    ],
    [
      'factory alias',
      source('commonjs').replace(
        'const entrypoint=',
        'const escaped=producer.createAppPageEntrypoint;const entrypoint=',
      ),
    ],
    [
      'factory apply',
      source().replace(
        `createAppPageEntrypoint(${ARGUMENT})`,
        () => `createAppPageEntrypoint.apply(null,[${ARGUMENT}])`,
      ),
    ],
    ['factory re-export', [source(), '\nexport {createAppPageEntrypoint};'].join('')],
    ['producer direct re-export', `${source()}\nexport * from ${JSON.stringify(SPECIFIER)};`],
    ['dynamic producer import', `${source()}\nimport(${JSON.stringify(SPECIFIER)});`],
    [
      'destructured namespace',
      source('commonjs').replace(
        'const producer=require',
        'const {createAppPageEntrypoint:producer}=require',
      ),
    ],
    ['extra factory call', `${source()}\nconst second=createAppPageEntrypoint(${ARGUMENT});`],
    ['factory result escape', source().replace('const entrypoint=', 'globalThis.entrypoint=')],
    ['entrypoint escape', `${source()}\nglobalThis.saved=entrypoint;`],
    ['class escape', `${source()}\nuse(routeModule);`],
    ['instance mutation', `${source()}\nrouteModule.distDir="/tmp";`],
    ['instance method', `${source()}\nrouteModule.loadManifests("/outside/page","/tmp");`],
    ['handler early call', `${source()}\nhandler(request,response,context);`],
    ['selector alias escape', `${source()}\nconst another=handler;another();`],
    ['mismatched export', source().replace('export const handler=', 'export const other=')],
    ['default instance export', `${source()}\nexport default routeModule;`],
    ['CJS instance export mutation', `${source('commonjs')}\nexports.routeModule.distDir="/tmp";`],
    ['CJS exports alias', `${source('commonjs')}\nconst escaped=exports;`],
    ['module exports alias', `${source('commonjs')}\nconst escaped=module.exports;`],
    ['missing export', source().replace('export const handler=entrypoint.handler;', '')],
  ])('refuses %s instead of granting a caller-chain terminal', (_title, code) => {
    expect(() => assertNodeManifestConsumer(input(code))).toThrow(
      'Unproved Next.js manifest consumer',
    );
  });

  it.each(['route-class', 'evaluator'] as const)(
    'keeps direct %s imports refused without a complete reviewed producer',
    (kind) => {
      const own = input();

      expect(() =>
        assertNodeManifestConsumer({ ...own, imports: [{ ...PRODUCER, kind }] }),
      ).toThrow('unknown producer or direct class/evaluator use');
    },
  );

  it.each(['source', 'producer'] as const)('requires the original %s byte identity', (changed) => {
    const own = input();
    const altered =
      changed === 'source'
        ? { ...own, source: { ...own.source, sha256: 'a'.repeat(64) } }
        : { ...own, imports: [{ ...PRODUCER, sha256: 'a'.repeat(64) }] };

    expect(() => assertNodeManifestConsumer(altered)).toThrow('Unproved Next.js manifest consumer');
  });

  it('rejects a producer path substitution even when its byte hash is copied', () => {
    const own = input();

    expect(() => {
      return assertNodeManifestConsumer({
        ...own,
        imports: [{ ...PRODUCER, file: '/project/user-code.js' }],
      });
    }).toThrow('unknown producer');
  });

  it('ties projected runtime callbacks to the exact verified factory call', () => {
    const own = input();

    expect(
      assertNodeManifestConsumer({
        ...own,
        runtimeInputs: { require: '__next_app_require__', loadChunk: '__next_app_load_chunk__' },
      }).requiresRuntimeNormalization,
    ).toBe(true);
    expect(() => {
      return assertNodeManifestConsumer({
        ...own,
        runtimeInputs: { require: 'other', loadChunk: '__next_app_load_chunk__' },
      });
    }).toThrow('runtime callback binding');
  });
});
