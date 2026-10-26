import type { Node } from '@oxc-project/types';
import type { OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import { nativeBindings, walk } from '../src/native-ast.ts';
import { assertRetainedNativeWorkerCapability } from '../src/native-worker-retained.ts';
import { retainedWorkerCapabilityNodes } from '../src/native-worker.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

const WORKER = "import {Worker} from 'node:worker_threads';";
const THREADS = "import threads from 'node:worker_threads';";
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

/** Authored output metadata only: no bundler, module or child is executed. */
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

describe('retained known Worker inheritance capability', () => {
  it.each([
    `${WORKER}class Thread extends Worker {}`,
    `${WORKER}export class Thread extends Worker {}`,
    `${WORKER}export const Thread=class extends Worker {};`,
    `${WORKER}const Thread=class Named extends Worker {};export {Thread as ThreadView};`,
    `${WORKER}const Base=Worker;class Thread extends Base {}`,
    `${WORKER}class Thread extends Worker {}class Child extends Thread {}`,
    `${WORKER}const Thread=class extends Worker {};const Base=Thread;class Child extends Base {}`,
    `${WORKER}class Thread extends Worker {}const Child=class extends Thread {};new Child('child.js');`,
    `${WORKER}const Child=class extends class extends Worker {} {};`,
    `${THREADS}class Thread extends threads.Worker {}`,
    `${THREADS}class Thread extends threads['Worker'] {}`,
    `${THREADS}const Base=threads.Worker;class Thread extends Base {}`,
    `${THREADS}const {Worker:Base}=threads;class Thread extends Base {}`,
    "import * as threads from 'node:worker_threads';class Thread extends threads.Worker {}",
    "const {Worker:Base}=require('worker_threads');class Thread extends Base {}",
    "class Thread extends require('node:worker_threads').Worker {}",
    "const threads=await import('node:worker_threads');class Thread extends threads.Worker {}",
    `${WORKER}class Thread extends (0,Worker) {}`,
    `${WORKER}class Thread extends (choose?Worker:class{}) {}`,
    `${WORKER}export function factory(){return class extends Worker {};}`,
  ])('refuses the retained original heritage edge in every target mode: %s', (source) => {
    const known = sites(source, false);

    expect(
      known.some((node) => node.type === 'ClassDeclaration' || node.type === 'ClassExpression'),
    ).toBe(true);
    expect(sites(source, true)).not.toStrictEqual([]);
    expect(sites(source)).not.toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/project/heritage.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    'class Worker{}class Thread extends Worker {}export {Thread};',
    'class Base{}export const Thread=class extends Base {};',
    'class Metadata extends Object {static kind="ordinary";}',
    'class Thread extends globalThis.OrdinaryClass {}',
    'const threads={Worker:class {}};class Thread extends threads.Worker {}',
    "const {Worker}=require('ordinary-package');class Thread extends Worker {}",
    `${WORKER}function ordinary(Worker){return class extends Worker {};}`,
    `${WORKER}const Thread=class Worker extends Worker {};`,
    `${WORKER}function ordinary(){class Worker{}return class extends Worker {};}`,
    `${THREADS}function ordinary(threads){return class extends threads.Worker {};}`,
    `${WORKER}if(false){class Thread extends Worker {}}`,
    `${WORKER}const Thread=false?class extends Worker {}:class {};`,
    `${WORKER}class Base{}class Thread extends (true?Base:Worker) {}`,
    `${THREADS}class Metadata extends Object {static main=threads.isMainThread;}`,
    `${WORKER}class Metadata{}Metadata.label=Worker.name;export {Metadata as View};`,
  ])('keeps ordinary metadata, lexical shadows and literal-dead classes separate: %s', (source) => {
    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/project/ordinary.mjs', source)).toBeUndefined();
  });

  it.each(UNOWNED_TRACES)(
    'keeps the owning-native-source gate independent for $id',
    async (trace) => {
      const source = `${WORKER}export class Thread extends Worker {}`;
      const program = parseAst(source);

      await expect(
        assertRetainedNativeWorkerCapability(chunk(source), program, walk(program), {
          traces: [trace],
          nodeTarget: false,
        }),
      ).resolves.toBeUndefined();
    },
  );
});
