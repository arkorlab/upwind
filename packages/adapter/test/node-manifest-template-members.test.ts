import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf, type Node } from '../src/lexical-scope.ts';
import { NodeManifestAlpha } from '../src/node-manifest-alpha.ts';
import { propertyName, visitTree } from '../src/node-manifest-consumer-ast.ts';
import {
  nodeManifestTemplateMemberKey,
  nodeManifestTemplateMemberName,
} from '../src/node-manifest-template-members.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import {
  changeOriginalTemplateFixture,
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

function parsed(source: string): Node {
  const value: unknown = parseAst(source);
  if (!isNode(value)) throw new Error('Expected an authored inert AST');
  return value;
}
function view(source: string, selected = true): unknown {
  const original = parsed(source);
  return new NodeManifestAlpha({
    original,
    body: listOf(original, 'body'),
    ...(selected && { memberName: nodeManifestTemplateMemberName }),
  }).body();
}
function member(source: string): Node {
  const found = visitTree(parsed(source)).find((visit) => visit.node.type === 'MemberExpression');
  if (found === undefined) throw new Error('Expected the authored member');
  return found.node;
}

const KEYS = [
  'PagesRouteModule',
  'PagesAPIRouteModule',
  'AppRouteRouteModule',
  'default',
  'RouteKind',
  'PAGES',
  'PAGES_API',
  'APP_ROUTE',
  'hoist',
  'getHandler',
];

describe('scoped fixed-template literal member inspection', () => {
  it.each(KEYS)('compares only reviewed %s selectors without changing source AST', (key) => {
    const source = `const ns=source;const result=ns[${JSON.stringify(key)}];`;
    const original = parsed(source);
    const before = JSON.stringify(original);
    const alpha = new NodeManifestAlpha({
      original,
      body: listOf(original, 'body'),
      memberName: nodeManifestTemplateMemberName,
    });

    expect(alpha.body()).toStrictEqual(view(`const ns=source;const result=ns.${key};`));
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps the generic property helper and an Alpha view without opt-in unchanged', () => {
    expect(propertyName(member('ns["default"];'))).toBeUndefined();
    expect(view('ns["default"];', false)).not.toStrictEqual(view('ns.default;', false));
  });

  it.each([
    'key',
    'key()',
    '0',
    '0n',
    '`default`',
    '"de"+"fault"',
    '(effect(),"default")',
    '/default/',
  ])('refuses computed expression %s as literal selector DATA', (key) => {
    expect(nodeManifestTemplateMemberKey(member(`ns[${key}];`))).toBeUndefined();
    expect(view(`ns[${key}];`)).not.toStrictEqual(view('ns.default;'));
  });

  it.each(['ns?.["default"];', 'other.ns["default"];', 'ns["unreviewed"];', 'ns["f"];'])(
    'does not normalize optional, nested or unreviewed selector %s',
    (source) => {
      expect(nodeManifestTemplateMemberName(member(source))).toBeUndefined();
    },
  );

  it('keeps a namespace receiver, its lexical shadow and an unbound call distinct', () => {
    expect(view('const ns=source;function run(arg){return ns["default"];}')).not.toStrictEqual(
      view('const outer=source;function run(outer){return outer.default;}'),
    );
    expect(view('ns["default"]();')).not.toStrictEqual(view('(0,ns.default)();'));
    expect(view('(0,ns["hoist"])(value);')).toStrictEqual(view('(0,ns.hoist)(value);'));
    expect(view('other["default"];')).not.toStrictEqual(view('ns.default;'));
  });

  it.each(['pages', 'pages-api', 'app-route'] as const)(
    'checks a bracket constructor in the complete pinned public %s template',
    async (kind) => {
      const own = await projectedTemplateFixture(kind);
      const constructor = {
        pages: 'PagesRouteModule',
        'pages-api': 'PagesAPIRouteModule',
        'app-route': 'AppRouteRouteModule',
      }[kind];
      const changed = changeOriginalTemplateFixture(
        own,
        `_modulecompiled.${constructor}`,
        `_modulecompiled[${JSON.stringify(constructor)}]`,
      );
      const before = JSON.stringify(changed);

      await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).resolves.toMatchObject({
        kind,
        requiresRuntimeNormalization: true,
      });
      expect(JSON.stringify(changed)).toBe(before);
    },
  );

  it('compares bracket component defaults and physical helper reads with the same ports', async () => {
    const own = await projectedTemplateFixture('pages');
    const code = own.projection.original.code
      .replaceAll('_modulecompiled.PagesRouteModule', '_modulecompiled["PagesRouteModule"]')
      .replaceAll('_VAR_MODULE_APP.default', '_VAR_MODULE_APP["default"]')
      .replaceAll('_VAR_MODULE_DOCUMENT.default', '_VAR_MODULE_DOCUMENT["default"]')
      .replaceAll('_routekind.RouteKind', '_routekind["RouteKind"]')
      .replaceAll('_helpers.hoist', '_helpers["hoist"]')
      .replaceAll('_pageshandler.getHandler', '_pageshandler["getHandler"]');
    const changed = reprojectTemplateFixture(own, code);

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).resolves.toMatchObject({
      kind: 'pages',
      requiresRuntimeNormalization: true,
    });
  });

  it.each([
    '_modulecompiled[globalThis.selector]',
    '_modulecompiled[`PagesRouteModule`]',
    '_modulecompiled[(effect(),"PagesRouteModule")]',
    '_modulecompiled["OtherRouteModule"]',
    'other["PagesRouteModule"]',
  ])('keeps a changed constructor receiver or selector refused: %s', async (replacement) => {
    const own = await projectedTemplateFixture('pages');
    const changed = changeOriginalTemplateFixture(
      own,
      '_modulecompiled.PagesRouteModule',
      replacement,
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'Unproved Next.js',
    );
  });

  it('does not normalize a changed helper receiver into an unbound helper call', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = changeOriginalTemplateFixture(own, '(0, _helpers.hoist)', '_helpers["hoist"]');

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'Unproved Next.js',
    );
  });
});
