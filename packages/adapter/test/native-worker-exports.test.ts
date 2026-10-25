import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { parseAst } from 'rolldown/parseAst';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import { nativeBindings, walk } from '../src/native-ast.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';
import { renderedWorkerRequires } from '../src/native-worker-requires.ts';
import { hasRetainedWorkerCapability } from '../src/native-worker.ts';

interface FixtureOptions {
  readonly format?: 'esm' | 'cjs';
  readonly nativeOwned?: boolean;
  readonly orphanOnly?: boolean;
  readonly importerOnly?: boolean;
  readonly commonjsHelper?: boolean;
  readonly inspect?: ((chunk: OutputChunk) => void) | undefined;
}

function inspectedChunk(chunk: OutputChunk) {
  const program = parseAst(chunk.code);
  const tree = walk(program);
  const bindings = nativeBindings(program);
  const requires = renderedWorkerRequires(chunk, tree, bindings);
  return { requires, capability: hasRetainedWorkerCapability(tree, bindings, requires) };
}

function compilerRequireText(chunk: OutputChunk): string {
  const declaration = [...inspectedChunk(chunk).requires][0];
  if (declaration === undefined) throw new Error('Expected the actual compiler helper');
  return chunk.code.slice(declaration.start, declaration.end);
}

function withWorkerCall(chunk: OutputChunk): OutputChunk {
  return {
    ...chunk,
    code: `${chunk.code}\nexport const child=new (__require('node:worker_threads').Worker)('source',{eval:true});`,
  };
}

function changedRuntime(
  chunk: OutputChunk,
  change: 'missing' | 'renamed' | 'unexported',
): OutputChunk {
  const modules = Object.fromEntries(
    Object.entries(chunk.modules).flatMap(([id, rendered]) => {
      if (id !== '\0rolldown/runtime.js') return [[id, rendered]];
      if (change === 'missing') return [];
      return [
        [
          id,
          {
            ...rendered,
            ...(change === 'renamed' && {
              code: rendered.code?.replaceAll('__require', '__require2') ?? null,
            }),
            ...(change === 'unexported' && { renderedExports: [] }),
          },
        ],
      ];
    }),
  );
  return { ...chunk, modules };
}

describe('retained Worker capabilities through source reexports', () => {
  let directory: string;
  let entry: string;
  let helper: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-worker-exports-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.mjs');
    helper = path.join(directory, 'bridge.mjs');
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function classify(bridge: string, code: string, options: FixtureOptions = {}) {
    helper = path.join(directory, options.commonjsHelper === true ? 'bridge.cjs' : 'bridge.mjs');
    const orphan = path.join(directory, 'orphan.mjs');
    await writeFile(helper, bridge);
    await writeFile(entry, code);
    await writeFile(orphan, 'export const unused=42;');
    const owned = options.nativeOwned !== false;
    const assets: Record<string, string> = options.orphanOnly === true ? { orphan } : { helper };
    if (options.orphanOnly !== true && options.importerOnly !== true) assets['entry'] = entry;
    if (owned) assets['binary'] = binary;
    const trace: NativeAddonEntryTrace = {
      id: '/native',
      assets,
      ...(options.importerOnly === true && { importers: [entry] }),
    };
    const proof = nativeLoadsPlugin([trace]);
    await using build = await rolldown({
      input: entry,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:worker_threads', 'worker_threads'],
    });
    const output = await build.generate({ format: options.format ?? 'esm' });
    const chunk = output.output.find((item): item is OutputChunk => item.type === 'chunk');
    if (chunk === undefined) throw new Error('The authored reexport fixture has no chunk');
    options.inspect?.(chunk);
    return await proof.retained(chunk);
  }

  async function authoredPrimitiveChunk(): Promise<OutputChunk> {
    let rendered: OutputChunk | undefined;
    await classify(
      "const threads=require('node:worker_threads');module.exports={value:threads.isMainThread};",
      "import helper from './bridge.cjs';export const value=helper.value;",
      {
        commonjsHelper: true,
        nativeOwned: false,
        inspect(chunk) {
          rendered = chunk;
        },
      },
    );
    if (rendered === undefined) throw new Error('The authored primitive fixture has no chunk');
    return rendered;
  }

  const constructors = [
    [
      "export {Worker} from 'node:worker_threads';",
      "import {Worker} from './bridge.mjs';export const start=()=>new Worker('source',{eval:true});",
    ],
    [
      "export {'Worker' as Thread} from 'worker_threads';",
      "import {Thread} from './bridge.mjs';export const start=()=>new Thread('source',{eval:true});",
    ],
    [
      "export * from 'node:worker_threads';",
      "import {Worker} from './bridge.mjs';export const start=()=>new Worker('source',{eval:true});",
    ],
    [
      "export {default} from 'node:worker_threads';",
      "import threads from './bridge.mjs';export const start=()=>new threads.Worker('source',{eval:true});",
    ],
    [
      "export * as threads from 'node:worker_threads';",
      "import {threads} from './bridge.mjs';export const start=()=>new threads.Worker('source',{eval:true});",
    ],
    [
      "import {Worker} from 'node:worker_threads';const Thread=Worker;export {Thread};",
      "import {Thread} from './bridge.mjs';export const start=()=>new Thread('source',{eval:true});",
    ],
  ] as const;

  it.each(constructors)('refuses an owned native child after helper %s', async (bridge, code) => {
    await expect(classify(bridge, code)).rejects.toThrow('unclassified owned native child');
  });

  it.each(constructors)(
    'also checks CommonJS rendered chunks after helper %s',
    async (bridge, code) => {
      await expect(classify(bridge, code, { format: 'cjs' })).rejects.toThrow(
        'unclassified owned native child',
      );
    },
  );

  it.each([
    "export {Worker} from './bridge.mjs';export const scope=42;",
    "export {Worker as default} from './bridge.mjs';export const scope=42;",
    "export * from './bridge.mjs';export const scope=42;",
    "import {Worker} from './bridge.mjs';const Thread=Worker;export {Thread};export const scope=42;",
    "import {Worker} from './bridge.mjs';export const Thread=Worker;",
  ])('refuses a retained outward constructor or namespace export: %s', async (code) => {
    await expect(classify("export {Worker} from 'node:worker_threads';", code)).rejects.toThrow(
      'unclassified owned native child',
    );
  });

  it('refuses a CommonJS namespace handed through a helper assignment', async () => {
    const bridge = "module.exports=require('node:worker_threads');";
    const code =
      "import threads from './bridge.cjs';export const start=()=>new threads.Worker('source',{eval:true});";

    await expect(classify(bridge, code, { commonjsHelper: true, format: 'cjs' })).rejects.toThrow(
      'unclassified owned native child',
    );
  });

  it('refuses a CommonJS object exporting a known Worker constructor', async () => {
    const bridge =
      "const threads=require('node:worker_threads');module.exports={Worker:threads.Worker};";
    const code =
      "import helper from './bridge.cjs';export const start=()=>new helper.Worker('source',{eval:true});";

    await expect(classify(bridge, code, { commonjsHelper: true })).rejects.toThrow(
      'unclassified owned native child',
    );
  });

  it.each([
    "const threads=require('node:worker_threads');module.exports={'Worker':threads.Worker};",
    "const {Worker}=require('node:worker_threads');const result={Worker};module.exports=result;",
    "const threads=require('node:worker_threads');module.exports={Worker:threads.Worker.prototype.constructor};",
  ])('checks literal object handoffs in both output formats: %s', async (bridge) => {
    const code =
      "import helper from './bridge.cjs';export const start=()=>new helper.Worker('source',{eval:true});";

    await expect(classify(bridge, code, { commonjsHelper: true })).rejects.toThrow(
      'unclassified owned native child',
    );
    await expect(classify(bridge, code, { commonjsHelper: true, format: 'cjs' })).rejects.toThrow(
      'unclassified owned native child',
    );
  });

  it('refuses a constructor recovered from the actual Worker prototype', async () => {
    const bridge = "export {Worker} from 'node:worker_threads';";
    const code =
      "import {Worker} from './bridge.mjs';export const start=()=>new Worker.prototype.constructor('source',{eval:true});";

    await expect(classify(bridge, code)).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    "export const start=()=>new Worker['prototype']['constructor']('source',{eval:true});",
    "const {prototype}=Worker;const {constructor:Thread}=prototype;export const start=()=>new Thread('source',{eval:true});",
    "export function start(key){return new Worker.prototype[key]('source',{eval:true});}",
    'export const prototype=Worker.prototype;',
    "const create=Worker.prototype.constructor.bind(null);export const start=()=>new create('source',{eval:true});",
  ])('retains only finite constructor and prototype capability origins: %s', async (code) => {
    await expect(
      classify(
        "export {Worker} from 'node:worker_threads';",
        `import {Worker} from './bridge.mjs';${code}`,
      ),
    ).rejects.toThrow('unclassified owned native child');
  });

  it.each([
    'export const value=[Worker.name,Worker.length,typeof Worker];',
    'const {name,length}=Worker;export {name,length};',
    'const prototype=Worker.prototype;export const value=prototype.constructor.name;',
    'const local={Worker};export const value=[local.Worker.name,local.Worker.length];',
    "export function local(Worker){return new Worker.prototype.constructor('ordinary');}",
  ])('keeps scalar metadata and genuine local prototype shadows separate: %s', async (code) => {
    await expect(
      classify(
        "export {Worker} from 'node:worker_threads';",
        `import {Worker} from './bridge.mjs';${code}`,
      ),
    ).resolves.toStrictEqual([]);
  });

  it('keeps CommonJS scalar metadata separate from an exported Worker capability', async () => {
    const bridge =
      "const threads=require('node:worker_threads');module.exports={name:threads.Worker.name,length:threads.Worker.length,type:typeof threads.Worker};";
    const code = "import helper from './bridge.cjs';export const value=helper.name;";

    await expect(classify(bridge, code, { commonjsHelper: true })).resolves.toStrictEqual([]);
  });

  it('requires actual compiler module metadata rather than an application helper name or body', async () => {
    const chunk = await authoredPrimitiveChunk();
    const original = inspectedChunk(chunk);
    const impostor = inspectedChunk({ ...chunk, modules: {} });

    expect(original.requires.size).toBe(1);
    expect(original.capability).toBe(false);
    expect(impostor.requires.size).toBe(0);
    expect(impostor.capability).toBe(false);
  });

  it.each([
    '__require=globalThis.custom;',
    'require=globalThis.custom;',
    'const require=globalThis.custom;',
  ])('rejects changed compiler helper or global require bindings: %s', async (code) => {
    const chunk = await authoredPrimitiveChunk();
    const inspection = inspectedChunk({ ...chunk, code: `${chunk.code}\n${code}` });

    expect(inspection.requires.size).toBe(0);
    expect(inspection.capability).toBe(false);
  });

  it('does not grant compiler helper origin to a same-named local parameter', async () => {
    const chunk = await authoredPrimitiveChunk();
    const code = `${chunk.code}\nexport function local(__require){return __require('node:worker_threads').Worker;}`;

    expect(inspectedChunk({ ...chunk, code }).capability).toBe(false);
  });

  it('rejects ambiguous duplicate rendered declaration ownership', async () => {
    const chunk = await authoredPrimitiveChunk();
    const text = compilerRequireText(chunk);
    const code = `${chunk.code}\nexport function local(){var ${text};return 42;}`;

    expect(inspectedChunk({ ...chunk, code }).requires.size).toBe(0);
  });

  it('retains the authenticated compiler helper origin for an actual Worker call', async () => {
    const chunk = withWorkerCall(await authoredPrimitiveChunk());

    expect(inspectedChunk(chunk).capability).toBe(true);
  });

  it.each([
    "const describeName=(value)=>value;export const described=describeName('worker_threads');",
    "const describeName=(value)=>value;export const described=describeName('node:worker_threads');",
    "const describeName=(value)=>({require:value});export const described=describeName('worker_threads');",
    "const describeName=(value)=>value.require;export const described=describeName('worker_threads');",
    "export function local(){const __require=value=>value;return __require('worker_threads');}",
  ])('does not turn an ordinary scalar function into a compiler loader: %s', async (code) => {
    const chunk = await authoredPrimitiveChunk();

    expect(inspectedChunk({ ...chunk, code: `${chunk.code}\n${code}` }).capability).toBe(false);
  });

  it.each(['missing', 'renamed', 'unexported'] as const)(
    'refuses ambiguous %s compiler metadata instead of losing a real capability',
    async (change) => {
      const chunk = withWorkerCall(await authoredPrimitiveChunk());

      expect(() => inspectedChunk(changedRuntime(chunk, change))).toThrow(
        'ambiguous compiler require provenance',
      );
    },
  );

  it.each(['__require=globalThis.other;', 'require=globalThis.other;'])(
    'refuses a mutated loader when an actual Worker capability depends on it: %s',
    async (mutation) => {
      const chunk = withWorkerCall(await authoredPrimitiveChunk());

      expect(() => inspectedChunk({ ...chunk, code: `${chunk.code}\n${mutation}` })).toThrow(
        'ambiguous compiler require provenance',
      );
    },
  );

  it('refuses duplicate compiler-helper origins when a known Worker call is retained', async () => {
    const original = await authoredPrimitiveChunk();
    const chunk = withWorkerCall(original);
    const text = compilerRequireText(original);

    expect(() =>
      inspectedChunk({ ...chunk, code: `${chunk.code}\nfunction copy(){var ${text};return 42;}` }),
    ).toThrow('ambiguous compiler require provenance');
  });

  it.each([{ nativeOwned: false }, { orphanOnly: true }])(
    'keeps object handoffs without retained native ownership separate: %j',
    async (options) => {
      const bridge =
        "const threads=require('node:worker_threads');module.exports={Worker:threads.Worker};";
      const code =
        "import helper from './bridge.cjs';export const start=()=>new helper.Worker('source',{eval:true});";

      await expect(
        classify(bridge, code, { ...options, commonjsHelper: true }),
      ).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "import {helper} from './bridge.mjs';export const safe=42;",
    "import {Worker} from 'node:worker_threads';function unused(){return new Worker.prototype.constructor('source',{eval:true});}export const safe=42;",
  ])('keeps dead object exports and prototype constructors prunable: %s', async (code) => {
    const bridge = "import {Worker} from 'node:worker_threads';export const helper={Worker};";

    await expect(classify(bridge, code)).resolves.toStrictEqual([]);
  });

  it('does not confuse a local CommonJS object constructor with the builtin Worker', async () => {
    const bridge = 'const threads={Worker:class{}};module.exports={Worker:threads.Worker};';
    const code =
      "import helper from './bridge.cjs';export const start=()=>new helper.Worker('ordinary');";

    await expect(classify(bridge, code, { commonjsHelper: true })).resolves.toStrictEqual([]);
  });

  it('accepts source ownership carried by the existing importer-only metadata', async () => {
    const [bridge, code] = constructors[0];

    await expect(classify(bridge, code, { importerOnly: true })).rejects.toThrow(
      'unclassified owned native child',
    );
  });

  it.each([
    "import {Worker} from './bridge.mjs';export const safe=42;",
    "import {Worker} from './bridge.mjs';function unused(){return new Worker('source',{eval:true});}export const safe=42;",
    "import {Worker} from './bridge.mjs';if(false)new Worker('source',{eval:true});export const safe=42;",
  ])(
    'does not retain an eager marker for dead Worker exports or constructors: %s',
    async (code) => {
      await expect(
        classify("export {Worker} from 'node:worker_threads';", code),
      ).resolves.toStrictEqual([]);
    },
  );

  it.each([
    "import {isMainThread} from './bridge.mjs';export const value=isMainThread;",
    "import {BroadcastChannel} from './bridge.mjs';export const value=new BroadcastChannel('ordinary');",
    "import {Worker} from './bridge.mjs';export function local(Worker){return new Worker('ordinary');}",
  ])('keeps non-Worker values and genuine local shadows separate: %s', async (code) => {
    const bridge = "export {Worker,isMainThread,BroadcastChannel} from 'node:worker_threads';";

    await expect(classify(bridge, code)).resolves.toStrictEqual([]);
  });

  it.each([{ nativeOwned: false }, { orphanOnly: true }])(
    'requires a retained owning source rather than a native asset elsewhere: %j',
    async (options) => {
      const [bridge, code] = constructors[0];

      await expect(classify(bridge, code, options)).resolves.toStrictEqual([]);
    },
  );

  it('does not rewrite the original physical source files', async () => {
    const [bridge, code] = constructors[0];

    await expect(classify(bridge, code)).rejects.toThrow('unclassified owned native child');
    await expect(readFile(helper, 'utf8')).resolves.toBe(bridge);
    await expect(readFile(entry, 'utf8')).resolves.toBe(code);
  });
});
