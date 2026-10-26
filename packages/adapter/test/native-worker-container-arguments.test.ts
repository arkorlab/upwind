import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import { nativeBindings, walk } from '../src/native-ast.ts';
import { exportedWorkerCapability } from '../src/native-worker-handoff.ts';
import { assertRetainedNativeWorkerCapability } from '../src/native-worker-retained.ts';
import { retainedWorkerCapabilityNodes } from '../src/native-worker.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const WORKER = "import {Worker} from 'node:worker_threads';";
const THREADS = "import threads from 'node:worker_threads';";
const SCALAR_CHOICE =
  "const chosen=process.env.USE?require('node:worker_threads'):{isMainThread:true,threadId:0};";
const MEMORY_HANDLE = '__rolldown_external_memory_handle__';
const UNOWNED_TRACES: readonly NativeAddonEntryTrace[] = [
  { id: '/ordinary', assets: { entry: '/unused/ordinary.mjs' } },
  { id: '/orphan', assets: { binary: '/unused/orphan.node' } },
];

function sites(source: string, nodeTarget?: boolean): readonly Node[] {
  const program = parseAst(source);
  return retainedWorkerCapabilityNodes(
    walk(program),
    nativeBindings(program),
    undefined,
    nodeTarget === undefined ? undefined : { nodeTarget },
  );
}

function ordinaryAliases(length: number): string {
  const declarations = Array.from({ length }, (_, index) => {
    const previous = index === 0 ? 'root' : `item${index - 1}`;
    return `const item${index}=${previous};`;
  });
  return `const root={};${declarations.join('')}start(item${length - 1}.nested);`;
}

/** Authored metadata only; no compiler, module, function or child is executed. */
function chunk(code: string): OutputChunk {
  return {
    [MEMORY_HANDLE]: () => ({ freed: false }),
    type: 'chunk',
    code,
    name: 'authored',
    isEntry: true,
    exports: [],
    fileName: 'authored.mjs',
    modules: {},
    imports: [],
    dynamicImports: [],
    facadeModuleId: null,
    isDynamicEntry: false,
    moduleIds: [],
    map: null,
    sourcemapFileName: null,
    preliminaryFileName: 'authored.mjs',
  };
}

describe('retained Worker capability containers in call arguments', () => {
  it.each([
    'function start({Thread}){return new Thread("child.js");}start({Thread:Worker});',
    'function start({nested:{Thread}}){return new Thread("child.js");}start({nested:{Thread:Worker}});',
    'function start(options){return new options.Thread("child.js");}const options={Thread:Worker};start(options);',
    'const options={Thread:Worker};const alias=options;start(alias);',
    'const options={nested:{Thread:Worker}};function start({Thread}){return new Thread("child.js");}start(options.nested);',
    'const options={nested:{Thread:Worker}};const alias=options.nested;start(alias);',
    'const options={one:{two:{Thread:Worker}}};const alias=options.one;start(alias.two);',
    'const options={nested:{Thread:Worker}};start(options["nested"]);',
    'const o={nested:{Thread:Worker}};start(o?.nested);',
    `tag\`\${{Thread:Worker}}\`;`,
    'function* source(){yield {Thread:Worker}}for(const {Thread} of source())new Thread("child.js");',
    'try{throw {Thread:Worker}}catch({Thread}){new Thread("child.js")}',
    'class Box{static opts={Thread:Worker}}start(Box.opts);',
    'const {Thread}={Thread:Worker};new Thread("child.js");',
    'const options={nested:{Thread:Worker}};const {nested:{Thread}}=options;new Thread("child.js");',
    'const options={nested:{Thread:Worker}};const {nested}=options;start(nested);',
    'const options={nested:{Thread:Worker}};const {nested}=options;new nested.Thread("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};new nested.deep.Thread("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};new nested["deep"]["Thread"]("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};const copy=nested.deep;new copy.Thread("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};const Thread=nested.deep.Thread.bind(null);new Thread("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};class Child extends nested.deep.Thread{}new Child("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker}}};const Child=class extends nested.deep.Thread{};new Child("child.js");',
    `const {nested}={nested:{deep:{Thread:Worker}}};nested.deep.Thread\`child.js\`;`,
    'const {nested}={nested:{deep:{Thread:Worker}}};new nested[globalThis.key].Thread("child.js");',
    'const options={nested:{deep:{Thread:Worker}}};options.marker=1;const {nested}=options;new nested.deep.Thread("child.js");',
    'const {nested}={nested:{deep:{Thread:Worker,get Thread(){return globalThis.other}}}};new nested.deep.Thread("child.js");',
    'const options={nested:{Thread:Worker}};options.marker=1;const {nested}=options;new nested.Thread("child.js");',
    'const options={nested:{Thread:Worker}};const {[globalThis.key]:chosen}=options;start(chosen);',
    'const options={nested:{Thread:Worker}};const {...rest}=options;start(rest);',
    'const {...rest}={Thread:Worker};new rest.Thread("child.js");',
    `const options={nested:{Thread:Worker}};tag\`\${options?.nested}\`;`,
    'function* source(){yield* [{Thread:Worker}]}',
    'const Box=class {opts={Thread:Worker}};start(new Box());',
    'const options={nested:{Thread:Worker}};start(options[globalThis.key]);',
    'const options={...{nested:{Thread:Worker}}};start(options.nested);',
    'const options={flag:true,[globalThis.key]:{Thread:Worker}};start(options.flag);',
    'const options={__proto__:{nested:{Thread:Worker}}};start(options.nested);',
    'const options={"__proto__":{nested:{Thread:Worker}}};start(options.nested);',
    'const options={Thread:Worker};start({...options});',
    'start({nested:{...{Thread:Worker}}});',
    'start({nested:[{Thread:Worker}]});',
    'const options={Thread:Worker};start(choose?options:{});',
    'start(choose?{Thread:Worker}:{});',
    'start(choose&&{Thread:Worker});',
    'start((effect(),{Thread:Worker}));',
    'let chosen;start(chosen={Thread:Worker});',
    'function start({Thread=class {}}={}){return new Thread("child.js");}start({Thread:Worker});',
    'new Starter({Thread:Worker});',
    'start.call(null,{Thread:Worker});',
    'start(...[{Thread:Worker}]);',
    'start({[globalThis.field]:Worker});',
    'start({get Thread(){return Worker;}});',
    'start({get nested(){return {Thread:Worker};}});',
  ])('refuses a known container handoff without inferring the callee: %s', (use) => {
    const source = WORKER + use;

    expect(sites(source, false)).not.toStrictEqual([]);
    expect(sites(source, true)).not.toStrictEqual([]);
    expect(sites(source)).not.toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/project/arguments.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    'start({Thread:class {}});',
    'start({Worker:42,nested:{value:"Worker"}});',
    'const options={Thread:class {}};const alias=options;start({...alias});',
    'const options={nested:{Thread:Worker},flag:true};start(options.flag);',
    'const options={nested:{Thread:Worker},flag:true};start(options?.flag);',
    'const {nested}={nested:{deep:{Thread:class {}}}};new nested.deep.Thread("ordinary");',
    'function local(Worker){const {nested}={nested:{deep:{Thread:Worker}}};new nested.deep.Thread("ordinary")}',
    'const {nested}=false?{nested:{deep:{Thread:Worker}}}:{nested:{deep:{Thread:class {}}}};new nested.deep.Thread("ordinary");',
    'const {nested}={nested:{deep:{Thread:Worker,flag:true}}};new nested.deep.flag("ordinary");',
    'const {nested}={nested:{deep:{Thread:Worker}}};new nested.deep.Thread.name.Worker("ordinary");',
    'const options={nested:{Thread:Worker},flag:true};const {flag}=options;start(flag);',
    'const options={nested:{Thread:Worker},flag:true};const {flag:alias}=options;start(alias);',
    'const options={nested:{Thread:Worker},flag:true};options.marker=1;const {flag}=options;start(flag);',
    'const options={nested:{Thread:Worker,flag:true}};const {nested:{flag}}=options;start(flag);',
    'const {Thread}={Thread:class {}};new Thread("ordinary");',
    'function local(Worker){const {Thread}={Thread:Worker};new Thread("ordinary")}',
    `function local(Worker){tag\`\${{Thread:Worker}}\`}`,
    'function* source(Worker){yield {Thread:Worker}}',
    'function local(Worker){try{throw {Thread:Worker}}catch({Thread}){new Thread("ordinary")}}',
    'function local(Worker){class Box{static opts={Thread:Worker}}start(Box.opts)}',
    `tag\`\${{value:true}}\`;`,
    'function* source(){yield {value:true}}',
    'try{throw {value:true}}catch({value}){consume(value)}',
    'class Box{static opts={value:true}}start(Box.opts);',
    `const value=\`\${{Thread:Worker}}\`;consume(value);`,
    `const value=\`\${{nested:{Thread:Worker}}}\`;consume(value);`,
    `tag\`\${false?{Thread:Worker}:{}}\`;`,
    'function* source(){yield false?{Thread:Worker}:{}}',
    'try{throw false?{Thread:Worker}:{}}catch(value){consume(value)}',
    'class Box{static opts=false?{Thread:Worker}:{}}start(Box.opts);',
    'if(false){const {Thread}={Thread:Worker};new Thread("dead")}',
    'const options={__proto__:{nested:{Thread:Worker}},flag:true};start(options.flag);',
    'const options={nested:{Thread:class {}}};start(options.nested);',
    'const options={nested:{Thread:class {}}};start(options[globalThis.key]);',
    'const options={nested:{Thread:class {}},[globalThis.key]:true};start(options.nested);',
    'const options={nested:false?{Thread:Worker}:{value:true}};start(options.nested);',
    'const options={nested:{value:true},["__proto__"]:{Thread:Worker}};start(options.nested);',
    'function local(Worker){const options={nested:{Thread:Worker}};start(options.nested);}',
    'function local(Worker){start({Thread:Worker});}',
    'function local(){const Worker=class {};start({Thread:Worker});}',
    'try{throw null;}catch(Worker){start({Thread:Worker});}',
    'start(false?{Thread:Worker}:{});',
    'start(true?{}:{Thread:Worker});',
    'start(false&&{Thread:Worker});',
    'start((Worker,{Thread:class {}}));',
    'if(false)start({Thread:Worker});',
    'start({get Thread(){return class {};}});',
    'start({get nested(){return false?{Thread:Worker}:{};}});',
    'function local(Worker){start({get Thread(){return Worker;}});}',
    'const left=right,right=left;start(left);',
    'const left=right,right=left;start(left.nested);',
    'function start({Thread=class {}}={}){return new Thread("ordinary");}start({});',
  ])('preserves ordinary objects, scalar values, shadows and dead choices: %s', (use) => {
    const source = WORKER + use;

    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
  });

  it.each([
    'start({main:threads.isMainThread,id:threads.threadId});',
    'const options={main:threads.isMainThread};start(options);',
    'const options={nested:{main:threads.isMainThread}};start(options.nested);',
    'const options={one:{threads}};start(options.one.threads.isMainThread);',
    'const options={one:{threads}};start(options?.one.threads.isMainThread);',
    'const {nested}={nested:{deep:{ns:threads}}};export const check=()=>nested.deep.ns.isMainThread;',
    'const {nested}={nested:{deep:{ns:threads}}};new nested.deep.ns.BroadcastChannel("ordinary");',
    'const {nested}={nested:{deep:{ns:threads}}};nested.deep.ns.getEnvironmentData("key");',
    'const {nested}={nested:{deep:{ns:threads}}};new nested.deep.ns.isMainThread.Worker("ordinary");',
    'const {isMainThread:main,threadId:id}=threads;start({main,id});',
    'const {ns}={ns:threads};export const check=()=>ns.isMainThread;',
    'const {ns}={ns:threads};const alias=ns;export const check=()=>alias.threadId;',
    'const {nested:{ns}}={nested:{ns:threads}};export const check=()=>ns.isMainThread;',
    'const {ns}={ns:threads};export const get=()=>ns;',
    'function local(threads){const {ns}={ns:threads};return ns.isMainThread}',
    'const {name}=threads.Worker;start({name});',
    `tag\`\${{main:threads.isMainThread,id:threads.threadId}}\`;`,
    'function* source(){yield {main:threads.isMainThread}}',
    'try{throw {main:threads.isMainThread}}catch(value){consume(value)}',
    'class Box{static opts={main:threads.isMainThread}}start(Box.opts);',
    'const choice=choose?threads:{isMainThread:true};start({main:choice.isMainThread});',
    'const values=[threads].map(ns=>ns.isMainThread);start({values});',
    'function get(){return threads;}start(get);',
    'start(()=>threads);',
  ])('preserves existing Worker-safe scalar and direct callback namespace rules: %s', (use) => {
    expect(sites(THREADS + use, false)).toStrictEqual([]);
  });

  it.each([
    'const {ns}={ns:threads};export const start=()=>new ns.Worker("child.js");',
    'const {ns}={ns:threads};start(ns);',
    'const {ns}={ns:threads};export const get=()=>ns[globalThis.key];',
    'const options={ns:threads};options.ns=globalThis.other;const {ns}=options;export const check=()=>ns.isMainThread;',
    'const {ns}={ns:threads};threads.isMainThread=globalThis.other;export const check=()=>ns.isMainThread;',
    'let {ns}={ns:threads};ns=globalThis.other;export const check=()=>ns.isMainThread;',
    'const {ns}=flag?{ns:threads}:{};export const check=()=>ns.isMainThread;',
    'const {ns}={ns:threads,...globalThis.other};export const get=()=>ns;',
    'const {ns}={ns:threads,get ns(){return globalThis.other}};export const get=()=>ns;',
    'const {ns}={ns:threads,ns(){return 1}};export const get=()=>ns;',
    'const {ns}={ns:threads,get [globalThis.key](){return 1}};export const get=()=>ns;',
  ])(
    'propagates genuine or ambiguous capability origins through the same selected alias: %s',
    (use) => {
      expect(sites(THREADS + use, false)).not.toStrictEqual([]);
      expect(sites(THREADS + use, true)).not.toStrictEqual([]);
    },
  );

  it.each([
    'const threads=import("node:worker_threads");export const start=()=>new threads.Worker("ordinary");',
    'const {Worker:Thread}=import("node:worker_threads");export const start=()=>new Thread("ordinary");',
    'const threads=import("node:worker_threads");const {ns}={ns:threads};export const start=()=>new ns.Worker("ordinary");',
    'const pending=import("node:worker_threads");const {nested}={nested:{deep:{pending}}};export const start=()=>new nested.deep.pending.Worker("ordinary");',
    'const pending=import("node:worker_threads");const {nested}={nested:{deep:{pending}}};export const start=()=>new nested.deep.pending.Worker.Worker("ordinary");',
    'const {Worker:Thread}=await Promise.resolve({Worker:class {}});export const start=()=>new Thread("ordinary");',
    'const threads=await import("node:worker_threads");export const channel=new threads.BroadcastChannel("ordinary");',
  ])('preserves the documented promise/scalar/non-Worker distinctions: %s', (source) => {
    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
  });

  it('keeps a selected namespace return Worker-only and Node-strict', () => {
    const source = `${THREADS}const {ns}={ns:threads};export const get=()=>ns;`;

    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).not.toStrictEqual([]);
    expect(sites(source)).not.toStrictEqual([]);
  });

  it.each([
    'const {ns}={ns:threads};export const check=()=>ns.isMainThread;',
    'const {ns}={ns:threads};const alias=ns;export const check=()=>alias.threadId;',
    'const {ns}={ns:threads,get other(){return 1}};export const check=()=>ns.threadId;',
    'function local(threads){const {ns}={ns:threads};return ns.isMainThread}',
  ])('keeps selected scalar namespace reads ordinary in every target mode: %s', (use) => {
    const source = THREADS + use;

    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
    expect(sites(source)).toStrictEqual([]);
  });

  it.each([
    'const {isMainThread:flag}=chosen;exports.check=()=>flag;',
    'const {threadId:id}=chosen;exports.check=()=>id;',
    'const {isMainThread:flag,threadId:id}=chosen;exports.check=()=>({flag,id});',
    'const {isMainThread:flag}=chosen;const alias=flag;exports.check=()=>alias;',
  ])('keeps genuinely proved scalar choices primitive through container expansion: %s', (use) => {
    const source = SCALAR_CHOICE + use;

    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
    expect(sites(source)).toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/authored/scalar.cjs', source)).toBeUndefined();
  });

  it.each([
    'const {Worker:Thread}=chosen;exports.start=()=>new Thread("child.js");',
    'const {[globalThis.key]:flag}=chosen;exports.check=()=>flag;',
    'const {...rest}=chosen;exports.check=()=>rest.isMainThread;',
    'let {isMainThread:flag}=chosen;flag=globalThis.other;exports.check=()=>flag;',
    'chosen.isMainThread=globalThis.other;const {isMainThread:flag}=chosen;exports.check=()=>flag;',
    'const alias=chosen;alias.threadId=globalThis.other;const {threadId:id}=chosen;exports.check=()=>id;',
    'const {isMainThread:flag=true}=chosen;exports.check=()=>flag;',
    'const {isMainThread:flag}=chosen;consume(chosen);exports.check=()=>flag;',
    'const {ns}={ns:chosen};exports.check=()=>ns;',
  ])('does not use scalar-rule reuse to exempt other choices or mutation: %s', (use) => {
    expect(sites(SCALAR_CHOICE + use, false)).not.toStrictEqual([]);
    expect(sites(SCALAR_CHOICE + use, true)).not.toStrictEqual([]);
  });

  it('keeps the original call node as the refusal site without changing source', () => {
    const source = `${WORKER}start({Thread:Worker});`;
    const program = parseAst(source);
    const tree = walk(program);
    const call = tree.find((node) => node.type === 'CallExpression');
    const before = JSON.stringify(program);
    const retained = retainedWorkerCapabilityNodes(tree, nativeBindings(program));

    expect(retained).toContain(call);
    expect(JSON.stringify(program)).toBe(before);
    expect(call?.type).toBe('CallExpression');
  });

  it.each([
    `const options={Thread:Worker};start(options${'.nested'.repeat(33)});`,
    `const options={Thread:Worker,${Array.from({ length: 1025 }, () => '...{}').join(',')}};start(options.nested);`,
  ])('refuses static member analysis beyond its finite bounds', (use) => {
    expect(() => sites(WORKER + use, false)).toThrow(
      'Worker container static member analysis exceeds its finite bounds',
    );
  });

  it.each([
    `const options={};start(options${'.nested'.repeat(33)});`,
    `const options={${Array.from({ length: 1025 }, () => '...{}').join(',')}};start(options.nested);`,
    `const options={${Array.from({ length: 1025 }, () => '...{main:threads.isMainThread,name:threads.Worker.name}').join(',')}};start(options.nested);`,
    `const options={${Array.from({ length: 1025 }, () => '...{Thread:false?threads.Worker:null}').join(',')}};start(options.nested);`,
    ordinaryAliases(40),
  ])('preserves an over-limit ordinary container without a known carrier', (use) => {
    expect(sites(THREADS + use, false)).toStrictEqual([]);
    expect(sites(THREADS + use, true)).toStrictEqual([]);
  });

  it('preserves an over-limit ordinary alias chain in the container helper', () => {
    const program = parseAst(ordinaryAliases(1025));
    const call = walk(program).find((node) => node.type === 'CallExpression');

    expect(
      call &&
        exportedWorkerCapability(
          call,
          {
            bindings: nativeBindings(program),
            origin: (node) =>
              node.type === 'Identifier' && node.name === 'Worker' ? 'constructor' : undefined,
          },
          new Set(),
        ),
    ).toBe(false);
  });

  it.each([
    ['[Worker]', '0', true],
    ['[Worker]', '99', false],
    ['[,Worker]', '0', false],
    ['[,Worker]', '1', true],
    ['[...[],Worker]', '0', true],
    ['[Worker]', 'globalThis.key', true],
    ['[Worker]', '"map"', false],
    ['[Worker]', '"length"', false],
  ] as const)(
    'selects original numeric array data without promoting methods: %s/%s',
    (array, key, expected) => {
      const program = parseAst(
        `${WORKER}const options={array:${array}};new options.array[${key}]();`,
      );
      const tree = walk(program);
      const bindings = nativeBindings(program);
      const imported = tree.find((node) => node.type === 'ImportSpecifier');
      const call = tree.find((node) => node.type === 'NewExpression');

      expect(
        call &&
          exportedWorkerCapability(
            call,
            {
              bindings,
              tree,
              origin: (node) => {
                return node.type === 'Identifier' && bindings.lookup(node, node.name) === imported
                  ? 'constructor'
                  : undefined;
              },
            },
            new Set(),
          ),
      ).toBe(expected);
    },
  );

  it.each(UNOWNED_TRACES)('preserves the independent owning-native gate for $id', async (trace) => {
    const source = `${WORKER}start({Thread:Worker});`;
    const program = parseAst(source);

    await expect(
      assertRetainedNativeWorkerCapability(chunk(source), program, walk(program), {
        traces: [trace],
        nodeTarget: false,
      }),
    ).resolves.toBeUndefined();
  });
});
