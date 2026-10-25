import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditError } from '../src/dependencies.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

describe('native child constructor classification', () => {
  let directory: string;
  let entry: string;
  let binary: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-worker-child-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
    entry = path.join(directory, 'entry.mjs');
    binary = path.join(directory, 'addon.node');
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function classify(source: string, commonjs = false, nodeTarget = false) {
    const importer = commonjs ? path.join(directory, 'entry.cjs') : entry;
    await writeFile(importer, source);
    const proof = nativeLoadsPlugin([{ id: '/native', assets: { entry: importer, binary } }], {
      nodeTarget,
    });
    await using build = await rolldown({
      input: importer,
      platform: 'neutral',
      plugins: [proof.plugin],
      external: ['node:worker_threads', 'worker_threads', 'node:path'],
    });
    const output = await build.generate({ format: 'esm' });
    const chunk = output.output.find((part): part is OutputChunk => part.type === 'chunk');
    if (chunk === undefined) throw new Error('The authored child fixture produced no chunk');
    return await proof.retained(chunk);
  }

  it.each([
    "import threads from 'node:worker_threads'; export const worker = new threads.Worker('./child.js');\n",
    "import threads from 'worker_threads'; export const worker = new threads['Worker']('./child.js');\n",
    "import * as threads from 'node:worker_threads'; export const worker = new threads['Worker']('./child.js');\n",
    "import { Worker as Thread } from 'node:worker_threads'; export const worker = new Thread('./child.js');\n",
  ])(
    'refuses a retained actual Node Worker constructor with owned native dependencies: %s',
    async (source) => {
      await expect(classify(source)).rejects.toThrow('unclassified owned native child');
    },
  );

  it('refuses an unknown computed constructor on the actual Node namespace', async () => {
    const source =
      "import threads from 'node:worker_threads'; export function start(kind) { return new threads[kind]('./child.js'); }\n";

    await expect(classify(source)).rejects.toBeInstanceOf(AuditError);
  });

  it.each([
    "import threads from 'node:worker_threads'; export function start(threads) { return new threads['Worker']('./child.js'); }\n",
    "import { Worker as Thread } from 'node:worker_threads'; export function start(Thread) { return new Thread('./child.js'); }\n",
    "class Worker { constructor(file) { this.file = file; } } export const worker = new Worker('./child.js');\n",
  ])(
    'does not manufacture Node ownership from an application constructor or shadow: %s',
    async (source) => {
      const loads = await classify(source);

      expect(loads).toStrictEqual([]);
    },
  );

  it('does not confuse a known non-Worker namespace constructor with native child work', async () => {
    const loads = await classify(
      "import threads from 'node:worker_threads'; export const channel = new threads['BroadcastChannel']('messages');\n",
    );

    expect(loads).toStrictEqual([]);
  });

  it.each(['join', 'resolve'])(
    'rejects an absolute tail in dirname-based path.%s native proof',
    async (method) => {
      const source = `const path = require('node:path'); process.dlopen(module, path.${method}(__dirname, '/addon.node')); module.exports = {};\n`;

      await expect(classify(source, true)).rejects.toBeInstanceOf(AuditError);
    },
  );

  it('keeps the old plain guarded Worker fallback but refuses it during strict Node recheck', async () => {
    const source =
      "try { process.dlopen(module, './optional.node'); } catch { module.exports = { fallback: true }; }\n";
    const worker = await classify(source, true);

    expect(worker).toStrictEqual([]);
    await expect(classify(source, true, true)).rejects.toThrow('unclassified on the Node target');
  });
});
