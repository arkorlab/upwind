import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { certifyNodeManifestAppPageFactory } from '../src/node-manifest-app-page-factory.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
} from '../src/node-manifest-turbopack.ts';

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

describe('first grouping array in fixed Node factory registration', () => {
  it.each([
    ['global directive', '"use strict";module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];'],
    ['single quoted directive', "'use strict';module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];"],
    [
      'exact arrow wrapper',
      '(()=>{"use strict";module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];})();',
    ],
    [
      'exact function wrapper',
      '(function(){"use strict";module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];})();',
    ],
    [
      'own callback directive',
      'module.exports=[[1,((ctx)=>{"use strict";}),"named",((ctx)=>{\'use strict\';})],2,((ctx)=>{})];',
    ],
    [
      'original mixed wrapper',
      'module.exports=[(()=>{"use strict";return[1,((ctx)=>{})];})(),2,((ctx)=>{})];',
    ],
  ])('accepts only the first bounded subgroup with %s', (_name, code) => {
    const factories = nodeManifestTurbopackFactories(source(code));

    expect(factories.flatMap((factory) => factory.ids)).toStrictEqual(
      _name === 'own callback directive' ? [1, 'named', 2] : [1, 2],
    );
  });

  it.each([
    ['no directive', 'module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];', [1, 2]],
    ['empty first group', 'module.exports=[[],2,((ctx)=>{})];', [2]],
    [
      'partial own directives',
      'module.exports=[[1,((ctx)=>{"use strict";}),2,((ctx)=>{})],3,((ctx)=>{})];',
      [1, 2, 3],
    ],
    ['own escaped lookalike', String.raw`module.exports=[[1,((ctx)=>{"use\x20strict";})]];`, [1]],
    ['own parenthesized lookalike', 'module.exports=[[1,((ctx)=>{("use strict");})]];', [1]],
  ] as const)(
    'accepts ordinary grouping with %s without asserting JS strictness',
    (_name, code, expected) => {
      expect(
        nodeManifestTurbopackFactories(source(code)).flatMap((factory) => factory.ids),
      ).toStrictEqual(expected);
    },
  );

  it('gives a flat and grouped ordinary callback identical inspection semantics without a new authority flag', () => {
    const body = 'ctx.v(42);';
    const flat = projectNodeManifestTurbopackFactory(
      source(`module.exports=[1,((ctx)=>{${body}})];`),
      1,
      'dependencies',
    );
    const grouped = projectNodeManifestTurbopackFactory(
      source(`module.exports=[[1,((ctx)=>{${body}})]];`),
      1,
      'dependencies',
    );
    const view = (projection: typeof flat) => {
      return {
        moduleId: projection.moduleId,
        mode: projection.mode,
        source: projection.source,
        imports: projection.imports,
        exports: projection.exports,
        cacheInitializers: projection.cacheInitializers,
        boundRuntimeInputs: projection.boundRuntimeInputs,
        requiresReviewedRuntime: projection.requiresReviewedRuntime,
      };
    };

    expect(view(grouped)).toStrictEqual(view(flat));
    expect('inheritedStrict' in grouped).toBe(false);
  });

  it('does not grant an AppPage factory certificate to a non-strict grouped callback', async () => {
    const original = source(
      'module.exports=[[1,((ctx)=>{ctx.s(["createAppPageEntrypoint",()=>createAppPageEntrypoint]);function createAppPageEntrypoint(){}})]];',
    );
    const projection = projectNodeManifestTurbopackFactory(original, 1);

    await expect(
      certifyNodeManifestAppPageFactory({
        file: '/not-read-without-strict-proof.js',
        projection,
        imports: [],
      }),
    ).rejects.toThrow('factory strictness');
  });

  it('retains original offsets and selected-ID projection without granting a manifest exemption', () => {
    const original = source(
      '"use strict";module.exports=[[1,((ctx)=>{ctx.v(42);})],"1",((ctx)=>{})];',
    );
    const factories = nodeManifestTurbopackFactories(original);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(factories.map(({ start, end }) => original.code.slice(start, end))).toStrictEqual([
      '(ctx)=>{ctx.v(42);}',
      '(ctx)=>{}',
    ]);
    expect({
      moduleId: projection.moduleId,
      mode: projection.mode,
      exports: projection.exports,
      original: projection.original,
    }).toStrictEqual({ moduleId: 1, mode: 'dependencies', exports: { kind: 'opaque' }, original });
  });

  it.each([
    ['later array', '"use strict";module.exports=[1,((ctx)=>{}),[2,((ctx)=>{})]];'],
    ['recursive direct array', '"use strict";module.exports=[[[1,((ctx)=>{})]],2,((ctx)=>{})];'],
    [
      'recursive mixed wrapper',
      '"use strict";module.exports=[[(()=>{"use strict";return[1,((ctx)=>{})];})()],2,((ctx)=>{})];',
    ],
    ['hole', '"use strict";module.exports=[[1,,((ctx)=>{})],2,((ctx)=>{})];'],
    ['effectful element', '"use strict";module.exports=[[run(),((ctx)=>{})],2,((ctx)=>{})];'],
    [
      'extra registration statement',
      '"use strict";run();module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];',
    ],
    ['duplicate subgroup ID', '"use strict";module.exports=[[1,((ctx)=>{})],1,((ctx)=>{})];'],
    ['template lookalike', '`use strict`;module.exports=[[1,((ctx)=>{})]];'],
    ['parenthesized lookalike', '("use strict");module.exports=[[1,((ctx)=>{})]];'],
    ['escaped lookalike', String.raw`"use\x20strict";module.exports=[[1,((ctx)=>{})]];`],
    [
      'strict wrapper side effects',
      '(()=>{"use strict";run();module.exports=[[1,((ctx)=>{})]];})();',
    ],
  ])('refuses %s without inventing runtime table metadata', (_name, code) => {
    expect(() => nodeManifestTurbopackFactories(source(code))).toThrow('Unproved Next.js');
  });
});
