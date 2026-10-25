import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown, type OutputChunk } from 'rolldown';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import type { RouteCode } from '../src/collect.ts';
import { instrumentationOf } from '../src/instrumentation.ts';
import { instrumentationEntryTraces } from '../src/native-addon-entries.ts';
import { nativeRouteOwners } from '../src/native-layout.ts';
import { nativeLoadsPlugin } from '../src/native-loads.ts';

describe('native project instrumentation ownership', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'upwind-native-hook-ownership-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('assigns an original hook native load to every Function without turning importer metadata into assets', async () => {
    const distDir = path.join(directory, '.next');
    const server = path.join(distDir, 'server');
    const own = path.join(server, 'instrumentation.js');
    const binary = path.join(server, 'addon.node');
    const host = path.join(directory, 'host.cjs');
    await mkdir(server, { recursive: true });
    await writeFile(own, "exports.register=()=>require('./addon.node');\n");
    // Opaque authored bytes are analyzed, never loaded as a native module.
    await writeFile(binary, new Uint8Array([0, 1, 2]));
    await writeFile(`${own}.nft.json`, JSON.stringify({ version: 1, files: ['addon.node'] }));
    await writeFile(host, 'exports.register=()=>{};\n');
    const hook = await instrumentationOf(distDir, path.join(directory, '.upwind'), false, {
      hosts: [host],
      repoRoot: directory,
    });
    const traces = await instrumentationEntryTraces(hook, distDir);
    const proof = nativeLoadsPlugin(traces);
    await using build = await rolldown({ input: own, platform: 'node', plugins: [proof.plugin] });
    const result = await build.generate({ format: 'cjs' });
    const chunk = result.output.find((item): item is OutputChunk => item.type === 'chunk');
    assert.isDefined(chunk, 'Authored hook did not produce a chunk');
    const loads = await proof.retained(chunk);
    const routes: RouteCode[] = ['/one', '/two'].map((id) => {
      return {
        id,
        kind: 'app-route',
        module: { id, filePath: `${directory}${id}.js` },
        edge: undefined,
        chunks: [],
        wasm: [],
        assets: {},
      };
    });
    const owners = [...nativeRouteOwners(routes, loads, new Set())];
    const observedLoads = loads.map((load) => {
      return {
        kind: load.kind,
        binary: load.binary,
        owners: load.owners,
      };
    });

    expect({
      importers: traces[0]?.importers,
      assets: Object.values(traces[0]?.assets ?? {}),
    }).toStrictEqual({ importers: [hook.file, own], assets: [binary] });
    expect({ loads: observedLoads, functions: owners }).toStrictEqual({
      loads: [{ kind: 'direct', binary, owners: ['instrumentation'] }],
      functions: ['/one', '/two'],
    });
  });

  it('never treats an importer metadata path as ownership of an untraced native binary', async () => {
    const entry = path.join(directory, 'instrumentation.js');
    const binary = path.join(directory, 'addon.node');
    const other = path.join(directory, 'other.node');
    await writeFile(entry, "exports.register=()=>require('./addon.node');\n");
    await writeFile(binary, new Uint8Array([0, 1]));
    await writeFile(other, new Uint8Array([2, 3]));
    const proof = nativeLoadsPlugin([
      { id: 'instrumentation', assets: { other }, importers: [entry, binary] },
    ]);
    await using build = await rolldown({ input: entry, platform: 'node', plugins: [proof.plugin] });
    const result = await build.generate({ format: 'cjs' });
    const chunk = result.output.find((item): item is OutputChunk => item.type === 'chunk');
    assert.isDefined(chunk, 'Authored hook did not produce a chunk');

    await expect(proof.retained(chunk)).rejects.toThrow('no owned, regular-file binary');
  });
});
