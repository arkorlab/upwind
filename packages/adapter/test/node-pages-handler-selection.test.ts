import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { selectPagesHandlerOrigin } from '../../../tools/native-pages-handler-profile/select.mts';
import { matchReviewedPagesHandler } from '../src/node-pages-handler-profile.ts';

const MARKER = 'globalThis.__upwind_public_pages_get_handler__';
const DIRECT = `function handler(value){return value;}function getServerSideProps(){${MARKER}=handler;}`;

function profile(...sources: string[]) {
  return {
    schema: 1,
    status: 'UNQUALIFIED',
    semanticClosure: 'unmapped:getHandler',
    inputs: {
      fixture: 'a'.repeat(64),
      image: 'b'.repeat(64),
      lock: 'c'.repeat(64),
      next: 'd'.repeat(64),
      packageManager: 'e'.repeat(64),
      swc: 'f'.repeat(64),
    },
    files: sources.map((source, index) => {
      return {
        name: `chunks/public${index}.js`,
        source,
        sha256: createHash('sha256').update(source).digest('hex'),
      };
    }),
  };
}
function selected(code: string) {
  return selectPagesHandlerOrigin(profile(code));
}
function functionText(code: string, result: ReturnType<typeof selected>): string {
  const fn = result.selection?.function;
  if (fn === undefined) throw new Error('expected an authored direct function selection');
  return code.slice(fn.start, fn.end);
}

describe('unqualified public Pages marker origin data', () => {
  it('reports the original declaration/function and marker ranges without granting authority', () => {
    const input = profile(DIRECT);
    const result = selectPagesHandlerOrigin(input);

    expect(result.status).toBe('UNQUALIFIED');
    expect(result.reason).toBe('direct-function-data');
    expect(functionText(DIRECT, result)).toBe('function handler(value){return value;}');
    expect(result.selection?.declaration).toMatchObject({
      file: 'chunks/public0.js',
      sha256: input.files[0]?.sha256,
    });
    expect(Object.isFrozen(result.selection?.aliases)).toBe(true);
    expect(matchReviewedPagesHandler(input)).toBeUndefined();
  });

  it.each([
    'const handler=value=>value;',
    'const handler=function(value){return value;};',
    'const handler=function self(value){return value?self(value-1):0;};',
    'function handler(value){return value?handler(value-1):0;}',
  ])('resolves a stable plain function binding: %s', (declaration) => {
    expect(selected(`${declaration}${MARKER}=handler;`).reason).toBe('direct-function-data');
  });

  it('follows only immutable local identifier aliases and preserves original Unicode offsets', () => {
    const code = `const label='日本語';const handler=value=>value;const selected=handler;${MARKER}=selected;`;
    const result = selected(code);

    expect(result.reason).toBe('direct-function-data');
    expect(result.selection?.aliases).toHaveLength(2);
    expect(functionText(code, result)).toBe('value=>value');
  });

  it('reports genuine enclosing registration IDs and the actual compiler context parameter as data', () => {
    const code = `module.exports=[1,"1",(ctx,module,exports)=>{const handler=value=>value;function gssp(){${MARKER}=handler;}}];`;
    const result = selected(code);

    expect(result.reason).toBe('direct-function-data');
    expect(result.selection?.factory?.registeredIds).toStrictEqual([1, '1']);
    expect(result.selection?.factory?.context.name).toBe('ctx');
    expect(Object.isFrozen(result.selection?.factory?.registeredIds)).toBe(true);
  });

  it('accepts a computed literal key but does not treat comments or strings as markers', () => {
    const code = `const label='${MARKER}';/*${MARKER}=fake;*/const handler=()=>42;globalThis["__upwind_public_pages_get_handler__"]=handler;`;

    expect(selected(code).reason).toBe('direct-function-data');
    expect(selected(`const label='${MARKER}';`).reason).toBe('marker-absent');
  });

  it.each([
    `function g(globalThis){const handler=()=>42;${MARKER}=handler;}`,
    `const globalThis={};const handler=()=>42;${MARKER}=handler;`,
    `try{}catch(globalThis){const handler=()=>42;${MARKER}=handler;}`,
    `import globalThis from 'local';const handler=()=>42;${MARKER}=handler;`,
  ])('refuses a lexically shadowed global object: %s', (code) => {
    expect(selected(code)).toMatchObject({ status: 'UNQUALIFIED', reason: 'shadowed-global' });
  });

  it.each([
    `globalThis={};${DIRECT}`,
    `${DIRECT}globalThis={};`,
    `globalThis.globalThis={};${DIRECT}`,
    `delete globalThis.globalThis;${DIRECT}`,
    `({value:globalThis}=settings);${DIRECT}`,
  ])('refuses original global binding replacement anywhere in the file: %s', (code) => {
    expect(selected(code).reason).toBe('reassigned-global');
  });

  it('accounts for global replacement in another public corpus file', () => {
    expect(selectPagesHandlerOrigin(profile(DIRECT, 'globalThis={};')).reason).toBe(
      'reassigned-global',
    );
  });

  it.each([
    `const other=globalThis;${DIRECT}`,
    `${DIRECT}const root=globalThis.globalThis;const key='__upwind_public_pages_get_handler__';root[key]=other;`,
    `const root=globalThis['globalThis'];const key='globalThis';root[key]={};${DIRECT}`,
    `Object.defineProperty(globalThis,'__upwind_public_pages_get_handler__',{value:fake});${DIRECT}`,
    `handoff(globalThis);${DIRECT}`,
  ])('keeps unknown global aliases/reflection unqualified: %s', (code) => {
    expect(selected(code).reason).toBe('global-object-escape');
  });

  it.each([
    `const handler=()=>42;${MARKER}+=handler;`,
    `const handler=()=>42;${MARKER}??=handler;`,
    `const handler=()=>42;consume(${MARKER});`,
    `const handler=()=>42;other.__upwind_public_pages_get_handler__=handler;`,
    `const handler=()=>42;globalThis?.__upwind_public_pages_get_handler__;`,
  ])('requires the exact nonoptional global assignment: %s', (code) => {
    expect(selected(code).reason).toBe('unsupported-marker-use');
  });

  it('refuses duplicate marker uses in the same or another file', () => {
    expect(selected(`${DIRECT}${MARKER}=handler;`).reason).toBe('duplicate-marker');
    expect(selectPagesHandlerOrigin(profile(DIRECT, DIRECT)).reason).toBe('duplicate-marker');
  });

  it.each([
    `let handler=()=>42;${MARKER}=handler;`,
    `var handler=()=>42;${MARKER}=handler;`,
    `function handler(){return 42;}handler=other;${MARKER}=handler;`,
    `function handler(){return 42;}${MARKER}=handler;function later(){handler=other;}`,
    `function handler(){return 42;}function handler(){return 7;}${MARKER}=handler;`,
    `const handler=()=>42;for(handler of values){}${MARKER}=handler;`,
  ])('refuses mutable/redeclared function origins: %s', (code) => {
    const result = selected(code);

    expect(result.reason).toBe('mutable-binding');
    expect(result.selection).toBeUndefined();
  });

  it.each([
    `const captured=42;const handler=()=>captured;${MARKER}=handler;`,
    `const handler=()=>this;${MARKER}=handler;`,
    `const handler=()=>arguments;${MARKER}=handler;`,
    `const handler=()=>process.env.NODE_ENV;${MARKER}=handler;`,
  ])('returns origin ranges but no closed-helper claim for captures: %s', (code) => {
    const result = selected(code);

    expect(result.reason).toBe('unclosed-function-capture');
    expect(result.selection?.function).toBeDefined();
  });

  it.each([
    `const handler=()=>42;handoff(handler);${MARKER}=handler;`,
    `const handler=()=>42;handler.extra=other;${MARKER}=handler;`,
    `const handler=()=>42;module.exports=handler;${MARKER}=handler;`,
  ])('retains alias/member/export escape obligations: %s', (code) => {
    expect(selected(code).reason).toBe('escaping-function-binding');
  });

  it.each([
    ['i', 'internal-import'],
    ['r', 'internal-require'],
    ['x', 'external-import'],
  ] as const)('reports an actual compiler %s port as unresolved DATA only', (method, kind) => {
    const argument = method === 'x' ? '"external",()=>require("external")' : '7';
    const code = `module.exports=[1,ctx=>{const ns=ctx.${method}(${argument});function gssp(){${MARKER}=ns.f;}}];`;
    const result = selected(code);

    expect(result.reason).toBe('module-origin-not-closed');
    expect(result.port).toMatchObject({ kind });
    expect(result.selection).toBeUndefined();
  });

  it.each([
    `import {getHandler as handler} from 'next/dist/server/route-modules/pages/pages-handler.js';${MARKER}=handler;`,
    `const ns=require('external');${MARKER}=ns.getHandler;`,
    `module.exports=[1,ctx=>{const ns=ctx.i(7);const handler=()=>ns.f();${MARKER}=handler;}];`,
  ])('does not qualify externalized or coalesced dependency captures: %s', (code) => {
    expect(selected(code).reason).not.toBe('direct-function-data');
  });

  it.each([
    `const handler=()=>42;${MARKER}=handler();`,
    `const handler=()=>42;${MARKER}=(0,handler);`,
    `${MARKER}=()=>42;`,
  ])('does not evaluate or infer unsafe RHS forms: %s', (code) => {
    expect(selected(code).selection).toBeUndefined();
  });

  it('revalidates copied profile hashes and never promotes self-consistent replacement data', () => {
    const input = profile(DIRECT);
    const copied = structuredClone(input);
    copied.files[0]!.source = DIRECT.replace('return value', 'return 7');

    expect(() => selectPagesHandlerOrigin(copied)).toThrow('source');

    const changed = profile(DIRECT.replace('return value', 'return 7'));

    expect(selectPagesHandlerOrigin(changed).status).toBe('UNQUALIFIED');
    expect(matchReviewedPagesHandler(changed)).toBeUndefined();
  });

  it('returns finite reasons without embedding invalid source in errors', () => {
    const result = selected('const PRIVATE_SOURCE_BODY = ;');

    expect(result).toStrictEqual({ status: 'UNQUALIFIED', reason: 'invalid-source-syntax' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_BODY');
  });

  it.each(['return;', 'if(condition)return;', '{return;}'])(
    'omits incompatible optional factory metadata for valid plain CJS: %s',
    (prefix) => {
      const code = `${prefix}const PRIVATE_SOURCE_BODY='authored';${DIRECT}`;
      const result = selected(code);

      expect(result.status).toBe('UNQUALIFIED');
      expect(result.reason).toBe('direct-function-data');
      expect(functionText(code, result)).toBe('function handler(value){return value;}');
      expect(result.selection?.factory).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_BODY');
      expect(JSON.stringify(result)).not.toContain('Parse failed');
    },
  );

  it.each([`with(opaque){${DIRECT}}`, `eval('handler=other');${DIRECT}`])(
    'does not invent lexical origin through dynamic scopes',
    (code) => {
      expect(selected(code).reason).toBe('unsupported-dynamic-scope');
    },
  );
});
