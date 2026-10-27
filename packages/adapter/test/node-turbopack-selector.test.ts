import { describe, expect, it } from 'vitest';

import {
  nativeTurbopackSelectorPatch,
  nativeTurbopackSelectorSource,
  nativeTurbopackSelectorTargets,
  nodeNextPolicySourcePins,
} from '../src/node-turbopack-selector.ts';

const ROOT = '/authored/node_modules/next';
const RELATIVES = [
  'dist/server/route-modules/app-page/module.compiled.js',
  'dist/server/route-modules/app-route/module.compiled.js',
  'dist/server/route-modules/pages/module.compiled.js',
  'dist/server/route-modules/pages-api/module.compiled.js',
];
const AUTHORED =
  'if(process.env.TURBOPACK){module.exports=require("./turbo")}else{module.exports=require("./ordinary")}';
const CONTEXT = {
  projectDir: '/authored',
  distDir: '/authored/.next',
  chunks: [],
  instrumentation: undefined,
  wasm: [],
};
const SELECTOR_FILE = `${ROOT}/dist/server/route-modules/pages/module.compiled.js`;
const RUNTIME_RELATIVE = 'dist/compiled/next-server/pages-turbo.runtime.prod.js';
const RUNTIME_FILE = `${ROOT}/${RUNTIME_RELATIVE}`;
const SPECIFIER = `next/${RUNTIME_RELATIVE}`;

/** Invented graph/hash DATA only: this cannot mint a completed route or rewrite certificate. */
function targetData(analysis = `if("1"){require("${SPECIFIER}")}else{require("unselected")}`) {
  const selector = { file: SELECTOR_FILE, sha256: 'authored-selector' };
  const runtime = { file: RUNTIME_FILE, sha256: 'authored-runtime' };
  const approved = { ...runtime, root: ROOT, relative: RUNTIME_RELATIVE };
  const graph = {
    sources: new Map([
      ['runtime', runtime],
      ['selector', selector],
    ]),
    retained: new Set(['runtime', 'selector']),
    rendered: new Map([['runtime', 'authored rendered target DATA']]),
    imports: new Map([['selector', [{ specifier: SPECIFIER, target: 'runtime' }]]]),
  };
  const routes = new Map([
    [RUNTIME_FILE, approved],
    [SELECTOR_FILE, { ...selector, root: ROOT, relative: RELATIVES[2]! }],
  ]);
  return { applied: { file: 'selector', result: { contents: analysis } }, graph, routes, approved };
}

describe('negative selector specialization with authored strings only', () => {
  it.each(RELATIVES)('does not authenticate a copied selector shape at %s', (relative) => {
    const file = `${ROOT}/${relative}`;

    expect(nativeTurbopackSelectorSource(file, AUTHORED)).toBe(AUTHORED);
    expect(nativeTurbopackSelectorSource(file, AUTHORED.repeat(2))).toBe(AUTHORED.repeat(2));
    expect(nativeTurbopackSelectorPatch.apply(AUTHORED, file, CONTEXT)).toMatchObject({
      contents: AUTHORED,
      edits: 0,
    });
    expect(nativeTurbopackSelectorPatch.target.test(file)).toBe(true);
  });

  it.each([
    '',
    'module.exports={};',
    'if(process.env.TURBOPACK){',
    'process.env.TURBOPACK="0";require("unknown");process.env.TURBOPACK="1";',
    'function choose(process){return process.env.TURBOPACK}',
    'globalThis.process.env.TURBOPACK;',
    'process.env["TURBOPACK"];',
    'process?.env.TURBOPACK;',
    'process.env.TURBOPACK();',
    'process.env.TURBOPACK=other;',
    'const text="process.env.TURBOPACK";',
    '// process.env.TURBOPACK\nmodule.exports={};',
  ])('leaves changed, malformed or unrelated content exactly unchanged: %s', (code) => {
    expect(
      nativeTurbopackSelectorSource(
        `${ROOT}/dist/server/route-modules/pages/module.compiled.js`,
        code,
      ),
    ).toBe(code);
  });

  it.each([
    'dist/server/route-modules/pages/module.compiled.js',
    '/authored/other.js',
    `${ROOT}/dist/server/route-modules/pages/module.js`,
    `${ROOT}/dist/server/route-modules/pages/module.compiled.js?query`,
    `${ROOT}/dist/server/route-modules/pages/module.compiled.js/extra`,
    `${ROOT}/dist/server/route-modules/unknown/module.compiled.js`,
    `${ROOT}/dist/server/route-modules/pages/../pages/module.compiled.js`,
    `${ROOT}//dist/server/route-modules/pages/module.compiled.js`,
    `${ROOT}/dist/server/route-modules/pages/module.compiled.js\0`,
  ])('leaves an unknown or noncanonical coordinate unchanged: %s', (file) => {
    expect(nativeTurbopackSelectorSource(file, AUTHORED)).toBe(AUTHORED);
  });

  it('provides no caller-supplied pin, callback or define authority', () => {
    const supplied = `${AUTHORED}\n/* requested TURBOPACK=1; qualified=true */`;

    expect(
      nativeTurbopackSelectorSource(
        `${ROOT}/dist/server/route-modules/pages/module.compiled.js`,
        supplied,
      ),
    ).toBe(supplied);
  });

  it('checks selected target membership as DATA without approving a graph', () => {
    const own = targetData(
      `if(process.env.NEXT_RUNTIME==="edge"){require("unselected-edge")}else if(process.env.NODE_ENV==="development"){require("unselected-dev")}else if("1"){require("${SPECIFIER}")}else{require("unselected-standard")}`,
    );

    expect(nativeTurbopackSelectorTargets(own.applied, own.graph, own.routes)).toBe(true);
  });

  it.each([
    'module.exports={};',
    'if(',
    'require(unknown);',
    `import "${SPECIFIER}";`,
    'require("next/dist/compiled/next-server/pages.runtime.prod.js");',
    'require("next/dist/compiled/next-server/app-page-turbo.runtime.prod.js");',
    'require("/outside/target.js");',
  ])('declines absent, unsupported or different active targets: %s', (analysis) => {
    const own = targetData(analysis);

    expect(nativeTurbopackSelectorTargets(own.applied, own.graph, own.routes)).toBe(false);
  });

  it.each(['source', 'retained', 'rendered', 'approval', 'edge', 'selector'] as const)(
    'requires the %s target inventory',
    (missing) => {
      const own = targetData();
      const remove = {
        source: () => own.graph.sources.delete('runtime'),
        retained: () => own.graph.retained.delete('runtime'),
        rendered: () => own.graph.rendered.delete('runtime'),
        approval: () => own.routes.delete(RUNTIME_FILE),
        edge: () => own.graph.imports.delete('selector'),
        selector: () => own.routes.delete(SELECTOR_FILE),
      };
      remove[missing]();

      expect(nativeTurbopackSelectorTargets(own.applied, own.graph, own.routes)).toBe(false);
    },
  );

  it.each([
    { sha256: 'different' },
    { root: '/other/next' },
    { relative: 'dist/compiled/next-server/pages.runtime.prod.js' },
    { file: '/other/next/runtime.js' },
  ])('requires the same approved runtime source tuple %#', (changed) => {
    const own = targetData();
    own.routes.set(RUNTIME_FILE, { ...own.approved, ...changed });

    expect(nativeTurbopackSelectorTargets(own.applied, own.graph, own.routes)).toBe(false);
  });

  it('requires a rendered source inventory rather than an integrity-only graph', () => {
    const own = targetData();

    expect(
      nativeTurbopackSelectorTargets(
        own.applied,
        { ...own.graph, rendered: undefined },
        own.routes,
      ),
    ).toBe(false);
  });

  it('requires every matching resolved target, not only one approved target', () => {
    const own = targetData();
    own.graph.imports.get('selector')!.push({ specifier: SPECIFIER, target: 'unretained' });

    expect(nativeTurbopackSelectorTargets(own.applied, own.graph, own.routes)).toBe(false);
  });

  it('deduplicates private pin DATA and rejects conflicting source digests', () => {
    const first = { file: '/authored/file.js', sha256: 'one' };
    const pins = nodeNextPolicySourcePins([[first], [first]]);

    expect(pins).toStrictEqual([first]);
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins[0])).toBe(true);
    expect(() => nodeNextPolicySourcePins([[first], [{ ...first, sha256: 'two' }]])).toThrow(
      'conflicting physical policy source pins',
    );
  });
});
