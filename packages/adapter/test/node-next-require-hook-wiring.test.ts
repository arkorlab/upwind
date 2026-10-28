import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it, vi } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { archivedNodeNextRequireHook } from '../src/node-jwt-compiler-archive.ts';
import { nodeNextStaticRequireHookSites } from '../src/node-next-require-hook-sites.ts';

// These archive-boundary cases must never read a source or load the bundler-facing proof module.
vi.mock(import('../src/node-proof.ts'), () => {
  return {
    nodeProofSource() {
      throw new Error('unexpected source read in an authored boundary control');
    },
  };
});

const FILE = '/authored/node_modules/next/dist/server/require-hook.js';
const ORDINARY = 'exports.value=()=>1;';
const REFUSALS = [
  'Function("return this")();',
  'require("module")._load("unknown");',
  'const mod=require("module");exports.loader=mod;',
  'require("child_process").spawn("unknown");',
  'const vm=require("vm");vm.runInNewContext("unknown");',
  'const {Worker}=require("worker_threads");new Worker("child.js");',
];
function hook() {
  return (
    'const path=require("path"),mod=require("module");const savedRequire=mod.prototype.require;const savedResolve=mod._resolveFilename;const map=new Map();' +
    'mod._resolveFilename=(function(resolve,requestMap,request,parent,isMain,options){const target=requestMap.get(request);if(target)request=target;return resolve.call(mod,request,parent,isMain,options);}).bind(null,savedResolve,map);' +
    `mod.prototype.require=function(request){if(request.endsWith(".shared-runtime")){return savedRequire.call(this,\`next/dist/server/route-modules/pages/vendored/contexts/\${path.basename(request,".shared-runtime")}\`);}return savedRequire.call(this,request);};`
  );
}
function closure(code: string, loaders: unknown) {
  const result: unknown = Reflect.apply(dynamicNodeClosureRefusal, undefined, [
    FILE,
    code,
    undefined,
    loaders,
  ]);
  return result;
}
function untouchedFiles() {
  const calls = { reads: 0 };
  const files = new Proxy(
    {},
    {
      get() {
        calls.reads += 1;
        throw new Error('unexpected archive access');
      },
    },
  );
  return { files, calls };
}

describe('fixed hook wiring never derives authority from operation DATA or optional arguments', () => {
  it.each([undefined, {}, { ws: undefined, nextRequireHook: undefined }])(
    'keeps ordinary closure behavior without a private hook token %#',
    (loaders) => {
      expect(dynamicNodeClosureRefusal(FILE, ORDINARY)).toBeUndefined();
      expect(closure(ORDINARY, loaders)).toBeUndefined();

      for (const code of REFUSALS) expect(closure(code, loaders)).toBeTypeOf('string');
    },
  );

  it('continues refusing the exact authored operation shape without an opaque proof', () => {
    const code = hook();
    const parsed: unknown = parseAst(code, { sourceType: 'commonjs' });
    const data = nodeNextStaticRequireHookSites(parsed);

    expect(data?.operations.size).toBe(8);
    expect(data?.namespaceOperands.size).toBe(1);
    expect(dynamicNodeClosureRefusal(FILE, code)).toBeTypeOf('string');
    expect(closure(code, {})).toBeTypeOf('string');
    expect(() => closure(code, { nextRequireHook: data })).toThrow('copied or missing proof');
  });

  it.each([{}, true, { operations: new Set(), namespaceOperands: new Set() }])(
    'rejects a forged hook token before even ordinary code can consume it %#',
    (nextRequireHook) => {
      expect(() => closure(ORDINARY, { nextRequireHook })).toThrow('copied or missing proof');
    },
  );

  it('keeps WS and JWT opaque checks separate from the new hook argument', () => {
    expect(() => closure(ORDINARY, { ws: {}, nextRequireHook: undefined })).toThrow(
      'copied compiler proof',
    );
    expect(() => {
      Reflect.apply(dynamicNodeClosureRefusal, undefined, [FILE, ORDINARY, {}, {}]);
    }).toThrow('copied compiler proof');
  });

  it('treats an absent archive hook proof as inert without reading the archive', async () => {
    const own = untouchedFiles();
    const result: unknown = await Reflect.apply(archivedNodeNextRequireHook, undefined, [
      undefined,
      own.files,
      undefined,
    ]);

    expect(result).toBeUndefined();
    expect(own.calls.reads).toBe(0);
  });

  it.each([{}, true])(
    'rejects a forged archive proof before any archive getter %#',
    async (proof) => {
      const own = untouchedFiles();
      const result: unknown = Reflect.apply(archivedNodeNextRequireHook, undefined, [
        proof,
        own.files,
        undefined,
      ]);

      await expect(result).rejects.toThrow('copied or missing proof');
      expect(own.calls.reads).toBe(0);
    },
  );
});
