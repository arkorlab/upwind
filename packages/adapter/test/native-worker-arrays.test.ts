import type { Node } from '@oxc-project/types';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';
import {
  hasRetainedWorkerCapability,
  retainedWorkerCapabilityNodes,
} from '../src/native-worker.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const IMPORT = "import {Worker} from 'node:worker_threads';";
const CHILD = '"require(\'unproved-child\')",{eval:true}';

function inspect(source: string) {
  const program = parseAst(source);
  const tree = walk(program);
  const bindings = nativeBindings(program);
  return { tree, bindings };
}
function selectedNode(tree: readonly Node[], type: Node['type']): Node {
  const found = tree.find((node) => node.type === type);
  if (found === undefined) throw new Error(`Expected the authored ${type}`);
  return found;
}
function loaderDeclaration(tree: readonly Node[]): Node {
  const declarations = tree.filter((node) => {
    return (
      node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === 'load'
    );
  });
  return selectedNode(declarations, 'VariableDeclarator');
}
function capability(source: string): boolean {
  const { tree, bindings } = inspect(source);
  return hasRetainedWorkerCapability(tree, bindings);
}

describe('retained Worker array capability escapes', () => {
  it.each([
    `const constructors=[Worker];new constructors[0](${CHILD});`,
    `new ([Worker][0])(${CHILD});`,
    `const [Thread]=[Worker];new Thread(${CHILD});`,
    `const [,[Thread]]=[0,[Worker]];new Thread(${CHILD});`,
    `const [...constructors]=[Worker];new constructors[0](${CHILD});`,
    `const {constructors}={constructors:[Worker]};new constructors[0](${CHILD});`,
    `const constructors=[[Worker]];new constructors[0][0](${CHILD});`,
    `const constructors=[{Thread:Worker}];new constructors[0].Thread(${CHILD});`,
    `const holder={Thread:Worker};const constructors=[holder];new constructors[0].Thread(${CHILD});`,
    `const constructors=[...[Worker]];new constructors[0](${CHILD});`,
    `const first=[Worker];const constructors=[...first];new constructors[0](${CHILD});`,
    `let constructors;constructors=[Worker];new constructors[0](${CHILD});`,
    `const constructors=[];constructors[0]=Worker;new constructors[0](${CHILD});`,
    `const constructors=[];constructors.push(Worker);new constructors[0](${CHILD});`,
    `let Thread;[Thread]=[Worker];new Thread(${CHILD});`,
    `function start(constructors=[Worker]){return new constructors[0](${CHILD});}`,
    'export const constructors=[Worker];',
    'export default [Worker];',
    'function constructors(){return [Worker];}',
    'const constructors=[,Worker];',
    'const Thread=Worker;const constructors=[Thread];',
    'const constructors=[globalThis.choose?Worker:class{}];',
    'const constructors=[(effect(),Worker)];',
    'const constructors=[Worker.prototype.constructor];',
    `const constructors=[globalThis.choose?{Thread:Worker}:{}];new constructors[0].Thread(${CHILD});`,
    'const constructors=[globalThis.choose&&{Thread:Worker}];',
    'const constructors=[globalThis.choose||{Thread:Worker}];',
    'const constructors=[globalThis.choose??{Thread:Worker}];',
    'const constructors=[(effect(),{Thread:Worker})];',
    'let chosen;const constructors=[chosen={Thread:Worker}];',
    'const holder=globalThis.choose?{Thread:Worker}:{};const constructors=[holder];',
    'const holder={nested:globalThis.choose?{Thread:Worker}:{}};const constructors=[holder];',
  ])('refuses a retained known constructor array without evaluating it: %s', (use) => {
    const source = IMPORT + use;

    expect(capability(source)).toBe(true);
    expect(dynamicNodeClosureRefusal('/project/array.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    `const holders=[{get holder(){return {Thread:Worker};}}];new holders[0].holder.Thread(${CHILD});`,
    `const holders=[()=>({Thread:Worker})];new holders[0]().Thread(${CHILD});`,
  ])('refuses the retained returned container in an array without invoking it: %s', (use) => {
    const source = IMPORT + use;
    const { tree, bindings } = inspect(source);

    expect(capability(source)).toBe(true);
    expect(
      retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: true }),
    ).not.toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/project/array.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    "import threads from 'node:worker_threads';const constructors=[threads.Worker];",
    "import * as threads from 'node:worker_threads';const constructors=[threads.default.Worker];",
    "const {Worker:Thread}=require('worker_threads');const constructors=[Thread];",
    "const threads=await import('node:worker_threads');const constructors=[threads.Worker];",
    "const constructors=[require('node:worker_threads')];",
    "const constructors=[import('node:worker_threads')];",
  ])('keeps the original namespace and loader origins strict through an array: %s', (source) => {
    expect(capability(source)).toBe(true);
  });

  it.each([
    'const constructors=[1,null,"Worker",false];export {constructors};',
    'const constructors=[class Worker{}];new constructors[0]();',
    'function local(Worker){const constructors=[Worker];return new constructors[0]();}',
    'function local(){const Worker=class{};return [Worker];}',
    '{const Worker=class{};const constructors=[Worker];new constructors[0]();}',
    'try{throw null;}catch(Worker){const constructors=[Worker];}',
    'const constructors=[globalThis.Worker];new constructors[0]();',
    'const holder={Worker:class{}};const constructors=[holder.Worker];',
    'const constructors=[{Worker:class{}}];new constructors[0].Worker();',
    'const first=[class{}];const constructors=[...first];new constructors[0]();',
    'let constructors;constructors=[class{}];new constructors[0]();',
    'const constructors=[false?Worker:class{}];new constructors[0]();',
    'const constructors=[true?class{}:Worker];new constructors[0]();',
    'const constructors=[false&&Worker,true||Worker,0??Worker];',
    'const constructors=[(Worker,class{})];new constructors[0]();',
    'const constructors=[true?[]:[Worker]];',
    'if(false){const constructors=[Worker];new constructors[0]();}',
    'const value=false&&[Worker];',
    'const value=true||[Worker];',
    'const value=0??[Worker];',
    'const value=false?[Worker]:[];',
    'const value=true?[]:[Worker];',
    'const constructors=[true?{}:{Thread:Worker}];',
    'const constructors=[false?{Thread:Worker}:{}];',
    'const constructors=[false&&{Thread:Worker},true||{Thread:Worker},0??{Thread:Worker}];',
    'const constructors=[({Thread:Worker},{Thread:class{}})];',
    'function local(Worker){const constructors=[globalThis.choose?{Thread:Worker}:{}];}',
    'if(false){const constructors=[globalThis.choose?{Thread:Worker}:{}];}',
    'const holders=[{get holder(){return {Thread:class{}};}}];new holders[0].holder.Thread();',
    'const holders=[()=>({Thread:class{}})];new holders[0]().Thread();',
    'function local(Worker){const holders=[{get holder(){return {Thread:Worker};}}];return holders;}',
    'function local(Worker){const holders=[()=>({Thread:Worker})];return holders;}',
    'if(false){const holders=[{get holder(){return {Thread:Worker};}}];new holders[0].holder.Thread();}',
    'if(false){const holders=[()=>({Thread:Worker})];new holders[0]().Thread();}',
    'const holders=[{get holder(){return true?{}:{Thread:Worker};}}];',
    'const holders=[()=>false?{Thread:Worker}:{}];',
  ])('preserves lexical shadows, scalar arrays and impossible origins: %s', (use) => {
    const source = IMPORT + use;

    expect(capability(source)).toBe(false);
    expect(dynamicNodeClosureRefusal('/project/array.mjs', source)).toBeUndefined();
  });

  it.each([
    'const values=[threads.isMainThread,threads.threadId];export {values};',
    'const {isMainThread,threadId}=threads;const values=[isMainThread,threadId];',
    'const chosen=globalThis.choose?threads:{isMainThread:true};const values=[chosen.isMainThread];',
    'const holders=[{get holder(){return {value:threads.threadId};}}];',
    'const holders=[()=>({value:threads.isMainThread})];',
  ])('does not promote ordinary Worker namespace scalar arrays into native work: %s', (use) => {
    expect(capability(`import threads from 'node:worker_threads';${use}`)).toBe(false);
  });

  it('keeps the exact retained array site and original lexical loader authentication', () => {
    const source = "const load=external;const constructors=[load('node:worker_threads').Worker];";
    const { tree, bindings } = inspect(source);
    const declaration = loaderDeclaration(tree);

    expect(retainedWorkerCapabilityNodes(tree, bindings)).toStrictEqual([]);

    const sites = retainedWorkerCapabilityNodes(tree, bindings, new Set([declaration]));
    const array = selectedNode(tree, 'ArrayExpression');

    expect(sites).toHaveLength(1);
    expect(sites[0]).toBe(array);
    expect(source.slice(array.start, array.end)).toBe("[load('node:worker_threads').Worker]");
  });

  it('does not give a same-named shadow the authenticated loader declaration', () => {
    const source =
      "const load=external;function local(load){return [load('node:worker_threads').Worker];}";
    const { tree, bindings } = inspect(source);
    const declaration = loaderDeclaration(tree);

    expect(retainedWorkerCapabilityNodes(tree, bindings, new Set([declaration]))).toStrictEqual([]);
  });

  it('preserves handled Worker-only fallbacks alongside ordinary arrays', () => {
    const source = `${IMPORT}const values=[1,2];function start(){try{return new Worker(${CHILD});}catch{return values;}}`;
    const { tree, bindings } = inspect(source);
    const constructor = selectedNode(tree, 'NewExpression');

    expect(
      retainedWorkerCapabilityNodes(tree, bindings, undefined, {
        nodeTarget: false,
        guards: new Map([[constructor.start, 'plain']]),
      }),
    ).toStrictEqual([]);
    expect(
      retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: true }),
    ).not.toStrictEqual([]);
  });

  it.each(['const holders=[{get holder(){return threads;}}];', 'const holders=[()=>threads];'])(
    'preserves the existing Worker-only direct namespace return inside an array: %s',
    (use) => {
      const { tree, bindings } = inspect(`import threads from 'node:worker_threads';${use}`);

      expect(
        retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: false }),
      ).toStrictEqual([]);
      expect(
        retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: true }),
      ).not.toStrictEqual([]);
    },
  );

  it('preserves ordinary namespace returns only for the Worker target', () => {
    const { tree, bindings } = inspect(
      "import threads from 'node:worker_threads';const values=[threads.threadId];function get(){return threads;}",
    );

    expect(
      retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: false }),
    ).toStrictEqual([]);
    expect(
      retainedWorkerCapabilityNodes(tree, bindings, undefined, { nodeTarget: true }),
    ).not.toStrictEqual([]);
  });
});
