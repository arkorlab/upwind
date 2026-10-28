import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { assertNodeManifestConsumer } from '../src/node-manifest-consumers.ts';
import {
  projectNodeManifestTurbopackFactory,
  turbopackModuleSpecifier,
} from '../src/node-manifest-turbopack.ts';

const PRODUCER = 'next/dist/build/templates/app-page-runtime.js';
const ROUTE = { page: '/native/page', pathname: '/native' };
const CALLBACKS = 'require:requirePage,loadChunk:loadPage';
const ALIASES = 'const requirePage=ctx.r.bind(ctx),loadPage=ctx.l.bind(ctx);';

function project(aliases = ALIASES, callbacks = CALLBACKS, before = '', after = '') {
  const code = `module.exports=[1,ctx=>{
    ctx.s(['__next_app__',()=>app,'routeModule',()=>route,'handler',()=>handler]);
    const producer=ctx.i(2);
    ${aliases}${before}
    const entry=producer.createAppPageEntrypoint({tree,page:'/native/page',pathname:'/native',${callbacks},interopDefault});
    const app=entry.__next_app__,route=entry.routeModule,handler=entry.handler;
    ${after}
  }];`;
  return projectNodeManifestTurbopackFactory(
    { code, sha256: createHash('sha256').update(code).digest('hex') },
    1,
  );
}

function prove(projection: ReturnType<typeof project>) {
  const inputs = Object.fromEntries(
    projection.boundRuntimeInputs.map((input) => [input.kind, input.identifier]),
  );
  return assertNodeManifestConsumer({
    source: projection.source,
    imports: [
      {
        specifier: turbopackModuleSpecifier(2),
        file: `/project/node_modules/${PRODUCER}`,
        sha256: '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b',
        kind: 'app-page-factory',
        exportName: 'createAppPageEntrypoint',
      },
    ],
    route: ROUTE,
    runtimeInputs: { require: inputs['require']!, loadChunk: inputs['loadChunk']! },
  });
}

describe('bound runtime callbacks through one compiler alias', () => {
  it.each(['const', 'let', 'var'])(
    'proves a stable grouped %s alias without changing raw runtime bytes',
    (kind) => {
      const projection = project(ALIASES.replace('const ', () => `${kind} `));

      expect(prove(projection).pathname).toBe('/native');
      expect(projection.original.code).toContain('ctx.l.bind(ctx)');
      expect(projection.source.code).toContain('loadPage=__upwind_turbopack_bound_l');
      expect(projection.boundRuntimeInputs).toHaveLength(2);
    },
  );

  it('supports one alias alongside the original direct-property form', () => {
    expect(
      prove(
        project('const loadPage=ctx.l.bind(ctx);', 'require:ctx.r.bind(ctx),loadChunk:loadPage'),
      ).pathname,
    ).toBe('/native');
  });

  it.each([
    ['reassigned', 'loadPage=other;', ''],
    ['updated', 'loadPage++;', ''],
    ['destructured write', '[loadPage]=other;', ''],
    ['escaped before use', 'consume(loadPage);', ''],
    ['returned later', '', 'function leak(){return loadPage;}'],
    ['stored later', '', 'globalThis.saved=loadPage;'],
    ['called later', '', 'loadPage("other");'],
  ])('refuses a callback alias that is %s', (_name, before, after) => {
    expect(() => prove(project(ALIASES, CALLBACKS, before, after))).toThrow('Unproved Next.js');
  });

  it('refuses a chain that could hide an unrelated callback', () => {
    expect(() =>
      prove(project(`${ALIASES}const copy=loadPage;`, 'require:requirePage,loadChunk:copy')),
    ).toThrow('Unproved Next.js');
  });

  it('refuses reading a hoisted alias before its initializer', () => {
    expect(() => prove(project('', CALLBACKS, '', ALIASES.replace('const ', 'var ')))).toThrow(
      'Unproved Next.js',
    );
  });

  it.each([
    'const requirePage=ctx.r.bind(ctx),loadPage=ctx.l.bind(other);',
    'const requirePage=ctx.r.bind(ctx),loadPage=ctx.l.bind(ctx,extra);',
    'const requirePage=ctx.r.bind(ctx),loadPage=ctx.l?.bind(ctx);',
    'const requirePage=ctx.r.bind(ctx),loadPage=ctx.l.bind?.(ctx);',
    'const requirePage=ctx.r.bind(ctx);if(flag){const loadPage=ctx.l.bind(ctx);}',
    'const requirePage=ctx.r.bind(ctx);function later(){const loadPage=ctx.l.bind(ctx);}',
  ])('keeps altered receivers and conditional/deferred alias creation refused: %s', (aliases) => {
    expect(() => project(aliases)).toThrow('Unproved Next.js');
  });

  it('does not accept a caller-supplied source with shadowed compiler callbacks', () => {
    const projection = project();
    const code = `const __upwind_turbopack_bound_l=other;\n${projection.source.code}`;

    expect(() => {
      return prove({
        ...projection,
        source: { code, sha256: createHash('sha256').update(code).digest('hex') },
      });
    }).toThrow('shadowed runtime callback binding');
  });

  it.each(['var loadPage=other;', 'var loadPage;', 'function loadPage(){}'])(
    'refuses a previous same-binding declaration: %s',
    (earlier) => {
      const aliases = `${earlier}${ALIASES.replace('const ', 'var ')}`;

      expect(() => project(aliases)).toThrow('Unproved Next.js');
    },
  );

  it('rechecks earlier declarations in a supplied projection', () => {
    const projection = project(ALIASES.replace('const ', 'var '));
    const code = `var loadPage=other;\n${projection.source.code}`;

    expect(() => {
      return prove({
        ...projection,
        source: { code, sha256: createHash('sha256').update(code).digest('hex') },
      });
    }).toThrow('runtime callback alias escape');
  });

  it.each(['export {loadPage};', 'loadPage=other;', 'consume(__upwind_turbopack_bound_l);'])(
    'rechecks all callback uses in a supplied projection: %s',
    (suffix) => {
      const projection = project();
      const code = `${projection.source.code}\n${suffix}`;

      expect(() => {
        return prove({
          ...projection,
          source: { code, sha256: createHash('sha256').update(code).digest('hex') },
        });
      }).toThrow('runtime callback');
    },
  );
});
