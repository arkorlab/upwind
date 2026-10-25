import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NativeAddonEntryTrace } from '../src/native-addons.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

interface FixtureOptions {
  readonly format?: 'esm' | 'cjs';
  readonly nativeOwned?: boolean;
  readonly orphanOnly?: boolean;
  readonly importerOnly?: boolean;
  readonly commonjsHelper?: boolean;
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
    return await proof.retained(chunk);
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
