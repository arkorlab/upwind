import type { Node } from '@oxc-project/types';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { nativeBindings, walk } from '../src/native-ast.ts';
import { retainedWorkerCapabilityNodes } from '../src/native-worker.ts';
import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';

function sites(source: string, nodeTarget?: boolean): readonly Node[] {
  const program = parseAst(source);
  const tree = walk(program);
  return retainedWorkerCapabilityNodes(
    tree,
    nativeBindings(program),
    undefined,
    nodeTarget === undefined ? undefined : { nodeTarget },
  );
}

const REQUIRE = "require('node:worker_threads')";
const IMPORT = "import threads from 'node:worker_threads';";

describe('worker-only immediate namespace array scalar mapping', () => {
  it.each([
    `[${REQUIRE}].map(ns=>ns.isMainThread);`,
    `[${REQUIRE}].map(ns=>ns.threadId);`,
    `[${REQUIRE}].map(ns=>ns['isMainThread']);`,
    `[${REQUIRE}].map(ns=>ns['threadId']);`,
    `${IMPORT}[threads].map(ns=>ns.isMainThread);`,
    "import * as threads from 'node:worker_threads';[threads].map(ns=>ns.threadId);",
    `const threads=${REQUIRE};[threads].map(ns=>ns.isMainThread);`,
    `[${REQUIRE},${REQUIRE}].map(ns=>ns.threadId);`,
    `const flags=[${REQUIRE}].map(ns=>ns.isMainThread);export {flags as mainThreadFlags};`,
  ])('keeps scalar stub mapping Worker-safe without relaxing the Node closure: %s', (source) => {
    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).not.toStrictEqual([]);
    expect(sites(source)).not.toStrictEqual([]);
    expect(dynamicNodeClosureRefusal('/project/scalar.mjs', source)).toBe(
      'an unproved Node Worker native-child closure',
    );
  });

  it.each([
    `[${REQUIRE}];`,
    `export default [${REQUIRE}];`,
    `function expose(){return [${REQUIRE}];}`,
    `const values=[${REQUIRE}];values.map(ns=>ns.isMainThread);`,
    `[${REQUIRE}]['map'](ns=>ns.isMainThread);`,
    `[${REQUIRE}]?.map(ns=>ns.isMainThread);`,
    `[${REQUIRE}].map?.(ns=>ns.isMainThread);`,
    `[${REQUIRE}].map(callback);`,
    `[${REQUIRE}].map(function(ns){return ns.isMainThread;});`,
    `[${REQUIRE}].map(async ns=>ns.isMainThread);`,
    `[${REQUIRE}].map(ns=>{return ns.isMainThread;});`,
    `[${REQUIRE}].map(({isMainThread:flag})=>flag);`,
    `[${REQUIRE}].map((ns,index)=>ns.isMainThread);`,
    `[${REQUIRE}].map((ns=other)=>ns.isMainThread);`,
    `[${REQUIRE}].map(ns=>ns.isMainThread,undefined);`,
    `[${REQUIRE}].map(...callbacks);`,
    `[${REQUIRE},].map(ns=>ns.Worker);`,
    `[,${REQUIRE}].map(ns=>ns.isMainThread);`,
    `[... [${REQUIRE}]].map(ns=>ns.isMainThread);`,
    `[${REQUIRE},other].map(ns=>ns.isMainThread);`,
    `[${REQUIRE}.Worker].map(ns=>ns.isMainThread);`,
    `[import('node:worker_threads')].map(ns=>ns.isMainThread);`,
    `[${REQUIRE}].map(ns=>ns.Worker);`,
    `[${REQUIRE}].map(ns=>ns.default);`,
    `[${REQUIRE}].map(ns=>ns);`,
    `[${REQUIRE}].map(ns=>({Thread:ns.Worker}));`,
    `[${REQUIRE}].map(ns=>()=>ns.isMainThread);`,
    `[${REQUIRE}].map(ns=>ns[globalThis.field]);`,
    `[${REQUIRE}].map(ns=>ns['is'+'MainThread']);`,
    `[${REQUIRE}].map(ns=>ns[\`isMainThread\`]);`,
    `[${REQUIRE}].map(ns=>ns?.isMainThread);`,
    `[${REQUIRE}].map(ns=>other.isMainThread);`,
    `[${REQUIRE}].map(ns=>(effect(),ns.isMainThread));`,
    `${IMPORT}threads.Worker=other;[threads].map(ns=>ns.isMainThread);`,
    `${IMPORT}threads.isMainThread=other;[threads].map(ns=>ns.isMainThread);`,
    `${IMPORT}delete threads.Worker;[threads].map(ns=>ns.isMainThread);`,
    `${IMPORT}const selected=globalThis.choose?threads:other;[selected].map(ns=>ns.isMainThread);`,
  ])('refuses namespace escape, constructor, unknown callback and unstable source %s', (source) => {
    expect(sites(source, false)).not.toStrictEqual([]);
    expect(sites(source, true)).not.toStrictEqual([]);
  });

  it('keeps same-named ordinary local namespaces outside Worker capability classification', () => {
    const source = `function local(require){return [${REQUIRE}].map(ns=>ns.isMainThread);}`;

    expect(sites(source, false)).toStrictEqual([]);
    expect(sites(source, true)).toStrictEqual([]);
  });

  it('retains separate known Worker constructor escapes beside scalar mapping', () => {
    const source = `${IMPORT}[threads].map(ns=>ns.isMainThread);const constructors=[threads.Worker];`;

    expect(sites(source, false)).not.toStrictEqual([]);
    expect(sites(source, true)).not.toStrictEqual([]);
  });
});
