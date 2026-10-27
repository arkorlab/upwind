import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const FILE = '/authored/ordinary-library.js';

describe('standard compiler metadata reads in original Node source', () => {
  it.each(['var', 'let', 'const'])('keeps a plain %s initializer read', (kind) => {
    const code = `${kind} bind=Function.prototype.bind;exports.bind=bind;`;

    expect(dynamicNodeClosureRefusal(FILE, code)).toBeUndefined();
  });

  it('keeps a grouped initializer and independent ordinary metadata', () => {
    const code =
      "var bind=Function.prototype.bind,tag=Symbol.for('authored');exports.bind=bind;exports.tag=tag;";

    expect(dynamicNodeClosureRefusal(FILE, code)).toBeUndefined();
  });

  it.each([
    '"use strict";const bind=Function.prototype.bind;exports.bind=bind;',
    'function select(){const bind=Function.prototype.bind;return bind}exports.select=select;',
    'const outer=()=>{let bind=Function.prototype.bind;return bind};exports.outer=outer;',
  ])('keeps the same initializer operation in an ordinary lexical context: %s', (code) => {
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeUndefined();
  });

  it.each([
    'function local(Function){return Function("ordinary")}',
    'const Function={prototype:{bind:0}};exports.value=Function.prototype.bind;',
    'const Function={prototype:{bind:0}};Function["prototype"]["bind"]=1;',
    'function local(globalThis){return globalThis.Function("ordinary")}',
    'const local={Function:{prototype:{bind:0}}};exports.value=local.Function.prototype.bind;',
  ])('preserves the existing behavior of local shadows and ordinary objects: %s', (code) => {
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeUndefined();
  });

  it.each([
    'Function("return 1")()',
    'new Function("return 1")',
    'const Compiler=Function;exports.Compiler=Compiler;',
    'const Compiler=Function;const bind=Compiler.prototype.bind;',
    'const prototype=Function.prototype;const bind=prototype.bind;',
    'const Compiler=Function.prototype.constructor;',
    'const Compiler=Function.prototype.bind.constructor;',
    'const bind=Function["prototype"].bind;',
    'const bind=Function.prototype["bind"];',
    'const bind=Function[`prototype`].bind;',
    'const bind=Function.prototype[`bind`];',
    'const bind=Function?.prototype.bind;',
    'const bind=Function.prototype?.bind;',
    'const bind=Function.prototype.bind?.();',
    'const bind=Function.prototype.bind();',
    'const bind=Function.prototype.bind.call(other);',
    'const bind=Function.prototype.bind.apply(other,[]);',
    'const bind=globalThis.Function.prototype.bind;',
    'const bind=Function.prototype.bind.unknown;',
    'Function.prototype.bind=other;',
    'Function.prototype.bind+=other;',
    'Function.prototype.bind??=other;',
    'Function.prototype.bind++;',
    '++Function.prototype.bind;',
    'delete Function.prototype.bind;',
    '([Function.prototype.bind]=values);',
    '({bind:Function.prototype.bind}=values);',
    'for(Function.prototype.bind of values){}',
    'for(Function.prototype.bind in values){}',
    'const [bind]=Function.prototype.bind;',
    'const {bind}=Function.prototype.bind;',
    'exports.bind=Function.prototype.bind;',
    'function select(){return Function.prototype.bind}',
    'use(Function.prototype.bind);',
    'Object.defineProperty(Function.prototype,"bind",{value:other});',
    'const prototype=Function.prototype;exports.prototype=prototype;',
  ])('retains the compiler refusal outside the exact initializer read: %s', (code) => {
    expect(dynamicNodeClosureRefusal(FILE, code)).toContain('compiler');
  });

  it.each([
    'const Compiler=Function;exports.Compiler=Compiler;',
    'Function("return 1")();',
    'const Compiler=Function.prototype.bind.constructor;',
    'require("node:vm").runInNewContext(source);',
    'require("node:process").dlopen(module,file);',
  ])('continues visiting other capabilities beside an accepted metadata read: %s', (other) => {
    const code = `const bind=Function.prototype.bind;${other}`;

    expect(dynamicNodeClosureRefusal(FILE, code)).toBeDefined();
  });
});
