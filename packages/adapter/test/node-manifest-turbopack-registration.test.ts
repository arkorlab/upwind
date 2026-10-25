import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
} from '../src/node-manifest-turbopack.ts';

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

describe('first strict subgroup in fixed Node factory registration', () => {
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

  it('retains original offsets and selected-ID projection without granting a manifest exemption', () => {
    const original = source(
      '"use strict";module.exports=[[1,((ctx)=>{ctx.v(42);})],"1",((ctx)=>{})];',
    );
    const factories = nodeManifestTurbopackFactories(original);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(original.code.slice(factories[0]?.start, factories[0]?.end)).toBe('(ctx)=>{ctx.v(42);}');
    expect({
      moduleId: projection.moduleId,
      mode: projection.mode,
      exports: projection.exports,
      original: projection.original,
    }).toStrictEqual({ moduleId: 1, mode: 'dependencies', exports: { kind: 'opaque' }, original });
  });

  it.each([
    ['no inherited or own strictness', 'module.exports=[[1,((ctx)=>{})],2,((ctx)=>{})];'],
    ['empty subgroup without strictness', 'module.exports=[[],2,((ctx)=>{})];'],
    [
      'one sloppy nested callback',
      'module.exports=[[1,((ctx)=>{"use strict";}),2,((ctx)=>{})],3,((ctx)=>{})];',
    ],
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
    ['own escaped lookalike', String.raw`module.exports=[[1,((ctx)=>{"use\x20strict";})]];`],
    ['own parenthesized lookalike', 'module.exports=[[1,((ctx)=>{("use strict");})]];'],
    [
      'strict wrapper side effects',
      '(()=>{"use strict";run();module.exports=[[1,((ctx)=>{})]];})();',
    ],
  ])('refuses %s without inventing runtime table metadata', (_name, code) => {
    expect(() => nodeManifestTurbopackFactories(source(code))).toThrow('Unproved Next.js');
  });
});
