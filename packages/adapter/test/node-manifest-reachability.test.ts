import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  inspectNodeManifestReachability,
  reachableNodeManifestFactories,
} from '../src/node-manifest-reachability.ts';
import { certifyNodeManifestRuntimeCallers } from '../src/node-manifest-runtime-callers.ts';
import {
  proveNodeManifestTurbopackConsumers,
  type NodeManifestTurbopackConsumerInput,
} from '../src/node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFactory } from '../src/node-manifest-turbopack-graph.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource as source,
  projectedTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

const DIST = '/project/.next';
const ENTRY = `${DIST}/server/pages/blog/[slug].js`;
const CHUNK = `${DIST}/server/chunks/app.js`;
const RUNTIME = `${DIST}/server/chunks/[turbopack]_runtime.js`;

function factory(
  id: string,
  imports: NodeManifestTurbopackGraphFactory['imports'] = [],
): NodeManifestTurbopackGraphFactory {
  return {
    id,
    physicalId: `physical:${id}`,
    projection: projectNodeManifestTurbopackFactory(
      source('module.exports=[1,(ctx)=>{ctx.v(42);}];'),
      1,
      'dependencies',
    ),
    imports,
  };
}

type Reachability = Parameters<typeof reachableNodeManifestFactories>[0];
function reachabilityInput(
  factories: Reachability['factories'],
  options: Partial<Omit<Reachability, 'factories'>> = {},
): Reachability {
  return {
    factories,
    graphs: [{ exportedId: 'entry', evaluations: [] }],
    callers: [],
    physicalIds: new Set(),
    runtimeIds: new Set(),
    ...options,
  };
}

function reachable(
  factories: Reachability['factories'],
  options: Partial<Omit<Reachability, 'factories'>> = {},
) {
  return reachableNodeManifestFactories(reachabilityInput(factories, options));
}

async function pagesFixture(): Promise<NodeManifestTurbopackConsumerInput> {
  const template = await projectedTemplateFixture('pages');
  const original = template.projection.original.code;
  const callback = original.slice(
    template.projection.factory.start,
    template.projection.factory.end,
  );
  const slots = [
    ...new Set(
      template.projection.imports.flatMap((item) =>
        item.targetId === undefined ? [] : [item.targetId],
      ),
    ),
  ]
    .map((id) => `${jsLiteral(id)},(ctx)=>{ctx.s(["default",()=>value]);const value={};},`)
    .join('');
  const external = template.imports.filter((item) => !item.specifier.startsWith('turbopack:'));
  const producer = external.find((item) => item.file.endsWith('/pages/module.compiled.js'));
  if (producer === undefined) throw new Error('Expected the pinned Pages constructor');
  const runtime = (
    await readFile(new URL('fixtures/node-runtime/production.txt', import.meta.url), 'utf8')
  )
    .replace(
      'var RUNTIME_PUBLIC_PATH = "output/[turbopack]_runtime.js";',
      'var RUNTIME_PUBLIC_PATH = "server/chunks/[turbopack]_runtime.js";',
    )
    .replace('var RELATIVE_ROOT_PATH = "../../../../../../..";', 'var RELATIVE_ROOT_PATH = "..";');
  const imports = external.map((item) => ({ specifier: item.specifier, target: item.file }));
  const runtimeSpecifier = path.posix.relative(path.posix.dirname(ENTRY), RUNTIME);
  return {
    distDir: DIST,
    rootDir: '/project',
    entries: [{ file: ENTRY, ...template.route }],
    producer: {
      id: producer.file,
      file: producer.file,
      sha256: producer.sha256,
      kind: 'pages-class',
    },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(
          `var R=require(${jsLiteral(runtimeSpecifier)})("server/pages/blog/[slug].js");R.c("server/chunks/app.js");R.m(1);module.exports=R.m(1).exports;`,
        ),
        imports: [{ specifier: runtimeSpecifier, target: RUNTIME }],
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
        source: source(`module.exports=[${slots}1,${callback},9,${callback}];`),
        imports,
      },
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

function change(
  input: NodeManifestTurbopackConsumerInput,
  file: string,
  edit: (code: string) => string,
): NodeManifestTurbopackConsumerInput {
  return {
    ...input,
    sources: input.sources.map((item) =>
      item.file === file ? { ...item, source: source(edit(item.source.code)) } : item,
    ),
  };
}

function activate(
  input: NodeManifestTurbopackConsumerInput,
  mode: 'evaluated' | 'exported' | 'imported',
): NodeManifestTurbopackConsumerInput {
  if (mode === 'exported')
    return change(input, ENTRY, (code) =>
      code.replace('module.exports=R.m(1)', 'module.exports=R.m(9)'),
    );
  const evaluated = mode === 'imported' ? 3 : 9;
  const changed =
    mode === 'imported'
      ? change(input, CHUNK, (code) =>
          code.replace('module.exports=[', 'module.exports=[3,(ctx)=>{ctx.r(9);ctx.v(42);},'),
        )
      : input;
  return change(changed, ENTRY, (code) =>
    code.replace('R.m(1);', () => `R.m(${evaluated});R.m(1);`),
  );
}

describe('closed static manifest reachability', () => {
  it('groups merged registration aliases only within their actual runtime Map', () => {
    const own = { ...factory('entry'), physicalId: 'shared-table', runtimeId: 'pages-runtime' };
    const alias = { ...own, id: 'same-runtime-alias' };
    const other = { ...own, id: 'other-runtime-alias', runtimeId: 'app-runtime' };

    expect(reachable([own, alias, other])).toStrictEqual(['entry', 'same-runtime-alias']);
  });

  it('seeds every evaluation, export and independently certified caller before following imports', () => {
    const factories = [
      factory('entry', [{ specifier: 'child', target: 'child' }]),
      factory('child'),
      factory('evaluated'),
      factory('caller'),
      factory('unused'),
    ];

    expect(
      reachable(factories, {
        graphs: [{ exportedId: 'entry', evaluations: ['evaluated'] }],
        callers: [{ id: 'boot', file: 'boot', sha256: 'source', invoked: ['caller'] }],
      }),
    ).toStrictEqual(['caller', 'child', 'entry', 'evaluated']);

    const inspected = inspectNodeManifestReachability(
      reachabilityInput(factories, {
        graphs: [{ exportedId: 'entry', evaluations: ['evaluated'] }],
        callers: [{ id: 'boot', file: 'boot', sha256: 'source', invoked: ['caller'] }],
      }),
    );

    expect(inspected).toStrictEqual({
      reached: ['caller', 'child', 'entry', 'evaluated'],
      fallback: undefined,
    });
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.reached)).toBe(true);
  });

  it('keeps all selected IDs of an executed merged factory even when its other export is unused', () => {
    const entry = factory('entry');

    expect(reachable([entry, { ...entry, id: 'alias' }, factory('unused')])).toStrictEqual([
      'alias',
      'entry',
    ]);
  });

  it.each([
    ['missing-seed', 'unregistered-seed'],
    ['missing-edge', 'unresolved-import'],
    ['runtime-edge', 'open-runtime-import'],
    ['bound-runtime', 'reachable-bound-runtime'],
    ['empty-seeds', 'no-seeds'],
    ['duplicate-factory', 'duplicate-factory'],
  ] as const)('keeps conservative all-factory analysis for %s', (mode, fallback) => {
    const entry = factory('entry', [{ specifier: 'target', target: 'target' }]);
    const bound = projectNodeManifestTurbopackFactory(
      source('module.exports=[1,(ctx)=>{const input={require:ctx.r.bind(ctx)};ctx.v(42);}];'),
      1,
      'dependencies',
    );
    const inputs = {
      'missing-seed': { factories: [factory('other')], options: {} },
      'missing-edge': { factories: [entry], options: {} },
      'runtime-edge': {
        factories: [entry],
        options: { physicalIds: new Set(['target']), runtimeIds: new Set(['target']) },
      },
      'bound-runtime': { factories: [{ ...factory('entry'), projection: bound }], options: {} },
      'empty-seeds': { factories: [factory('entry')], options: { graphs: [] } },
      'duplicate-factory': { factories: [factory('entry'), factory('entry')], options: {} },
    };
    const input = inputs[mode];

    expect(reachable(input.factories, input.options)).toBeUndefined();
    expect(
      inspectNodeManifestReachability(reachabilityInput(input.factories, input.options)),
    ).toStrictEqual({ reached: undefined, fallback });
  });

  it('returns no partial set or source identities when an unregistered seed forces all factories', () => {
    const result = inspectNodeManifestReachability(
      reachabilityInput([factory('entry')], {
        graphs: [{ exportedId: 'private-looking/module-path', evaluations: ['entry'] }],
      }),
    );

    expect(result).toStrictEqual({ reached: undefined, fallback: 'unregistered-seed' });
    expect(JSON.stringify(result)).toBe('{"fallback":"unregistered-seed"}');
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('allows only closed physical or builtin dependencies without treating them as factory IDs', () => {
    const entry = factory('entry', [
      { specifier: 'external', target: 'external' },
      { specifier: 'node:fs', target: 'node:fs' },
    ]);

    expect(
      reachable([entry, factory('unused')], { physicalIds: new Set(['external']) }),
    ).toStrictEqual(['entry']);
  });
});

describe('protected Pages consumer reachability', () => {
  it('excludes an unused constructor consumer while still retaining the complete physical table proof', async () => {
    const proof = await proveNodeManifestTurbopackConsumers(await pagesFixture());

    expect(proof.terminals).toStrictEqual([
      { id: ENTRY, file: ENTRY, kind: 'pages', page: '/blog/[slug]', pathname: '/blog/[slug]' },
    ]);
    expect(proof.files.map((file) => file.file)).toContain(CHUNK);
    expect(proof.requiresSdkNormalization).toBe(true);
  });

  it.each(['evaluated', 'exported', 'imported'] as const)(
    'refuses the same unsealed constructor consumer once %s',
    async (mode) => {
      const input = activate(await pagesFixture(), mode);

      await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('sealed route');
    },
  );

  it('includes an additional owned boot seed without giving that boot a protected route terminal', async () => {
    const input = await pagesFixture();
    const other = `${DIST}/server/pages/other.js`;
    const sources = [
      ...input.sources,
      {
        id: other,
        file: other,
        source: source(
          'var R=require("../chunks/[turbopack]_runtime.js")("server/pages/other.js");R.c("server/chunks/app.js");module.exports=R.m(9).exports;',
        ),
        imports: [{ specifier: '../chunks/[turbopack]_runtime.js', target: RUNTIME }],
      },
    ];
    const runtimeCallers = await certifyNodeManifestRuntimeCallers({
      rootDir: '/project',
      distDir: DIST,
      entries: [
        { id: '/native', canonicalFilePath: ENTRY },
        { id: '/other', canonicalFilePath: other },
      ],
      routes: [],
      entryTraces: [],
      sources,
      retained: new Set(sources.map((item) => item.id)),
    });

    await expect(
      proveNodeManifestTurbopackConsumers({ ...input, sources, runtimeCallers }),
    ).rejects.toThrow('sealed route');
  });

  it.each([
    [true, 'sealed route; reachability fallback: reachable-bound-runtime'],
    [false, 'bound runtime callback escapes'],
  ] as const)(
    'keeps the open runtime callback conservative when reachable=%s',
    async (evaluated, reason) => {
      const added = change(await pagesFixture(), CHUNK, (code) => {
        return code.replace(
          'module.exports=[',
          'module.exports=[3,(ctx)=>{const input={require:ctx.r.bind(ctx)};ctx.v(42);},',
        );
      });
      const input = change(added, ENTRY, (code) =>
        evaluated ? code.replace('R.m(1);', 'R.m(3);R.m(1);') : code,
      );

      await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(reason);
    },
  );

  it('does not hide an unused malformed context operation behind reachability', async () => {
    const input = change(await pagesFixture(), CHUNK, (code) =>
      code.replace('module.exports=[', 'module.exports=[8,(ctx)=>{ctx.unknown();},'),
    );

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('context method');
  });
});
