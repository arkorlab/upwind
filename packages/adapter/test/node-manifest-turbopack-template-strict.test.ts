import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { isNode, listOf } from '../src/lexical-scope.ts';
import {
  assertStrictFactory,
  withoutStrict,
} from '../src/node-manifest-turbopack-template-strict.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  manifestTemplateSource,
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

const FALSE_DIRECTIVES = [
  String.raw`"use\x20strict";`,
  String.raw`'use\u0020strict';`,
  '("use strict");',
  "('use strict');",
  '`use strict`;',
  'false;',
  '"use sloppy";',
];

function body(source: string): readonly unknown[] {
  const parsed: unknown = parseAst(source);
  if (!isNode(parsed)) throw new Error('Expected an authored AST');
  return listOf(parsed, 'body');
}
function projection(directive: string) {
  const code = `module.exports=[1,(ctx)=>{${directive}const value=1;ctx.s(["value",()=>value]);}];`;
  return projectNodeManifestTurbopackFactory(manifestTemplateSource(code), 1);
}

describe('genuine original factory strict directives', () => {
  it.each(['"use strict";', "'use strict';", '/* authored comment */"use strict";'])(
    'accepts a genuine first directive %s and removes only its original statement',
    (directive) => {
      const own = projection(directive);
      const statements = body(`${directive}const value=1;`);
      const before = JSON.stringify(statements);

      expect(() => {
        assertStrictFactory(own);
      }).not.toThrow();
      expect(withoutStrict(statements)).toStrictEqual(statements.slice(1));
      expect(JSON.stringify(statements)).toBe(before);
    },
  );

  it.each(FALSE_DIRECTIVES)('refuses a false directive %s and retains that expression', (value) => {
    const own = projection(value);
    const statements = body(`${value}const result=1;`);

    expect(() => {
      assertStrictFactory(own);
    }).toThrow('unproved factory strictness');
    expect(withoutStrict(statements)).toBe(statements);
  });

  it.each([';"use strict";', 'false;"use strict";', '"other directive";"use strict";', ''])(
    'keeps the conservative first-statement gate for %s',
    (value) => {
      const statements = body(`${value}const result=1;`);

      expect(() => {
        assertStrictFactory(projection(value));
      }).toThrow('unproved factory strictness');
      expect(withoutStrict(statements)).toBe(statements);
    },
  );

  it.each([
    '"use strict";module.exports=[1,(ctx)=>{const value=1;ctx.s(["value",()=>value]);}];',
    '(()=>{"use strict";module.exports=[1,(ctx)=>{const value=1;ctx.s(["value",()=>value]);}];})();',
    '(function(){"use strict";module.exports=[1,(ctx)=>{const value=1;ctx.s(["value",()=>value]);}];})();',
    'module.exports=[(()=>{"use strict";return [1,(ctx)=>{const value=1;ctx.s(["value",()=>value]);}];})()];',
  ])(
    'preserves genuine original inherited strictness in the reviewed wrapper grammar: %s',
    (code) => {
      const own = projectNodeManifestTurbopackFactory(manifestTemplateSource(code), 1);

      expect(() => {
        assertStrictFactory(own);
      }).not.toThrow();
    },
  );

  it.each([
    ['while block', 'while(false){"use strict";', '}'],
    ['for block', 'for(;false;){"use strict";', '}'],
    ['catch block', 'try{}catch(error){"use strict";', '}'],
    ['ordinary block', '{"use strict";', '}'],
  ])('does not turn a %s string into inherited directive authority', (_name, prefix, suffix) => {
    const own = projection('');
    const original = manifestTemplateSource(`${prefix}${own.original.code}${suffix}`);
    // Isolate this original-range gate; the full projector also rejects the outer registration.
    const wrapped = {
      ...own,
      original,
      factory: {
        ...own.factory,
        start: own.factory.start + prefix.length,
        end: own.factory.end + prefix.length,
      },
    };

    expect(() => {
      assertStrictFactory(wrapped);
    }).toThrow('unproved factory strictness');
    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow(
      'registration statements',
    );
  });

  it('does not erase a false factory directive even when strictness is genuinely inherited', async () => {
    const own = await projectedTemplateFixture('app-route');
    const escaped = String.raw`"use\x20strict";`;
    const code = `"use strict";${own.projection.original.code.replace('"use strict";', () => escaped)}`;
    const changed = reprojectTemplateFixture(own, code);
    const before = JSON.stringify(changed);

    expect(() => {
      assertStrictFactory(changed.projection);
    }).not.toThrow();
    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'changed handler or constructor body',
    );
    expect(JSON.stringify(changed)).toBe(before);
  });
});
