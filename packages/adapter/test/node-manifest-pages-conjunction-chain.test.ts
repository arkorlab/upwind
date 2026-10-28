import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

describe('all-member Pages constructor chains', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'pages-conjunction-source-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('closes two actual template parents and keeps both original wrapper files pending the SDK root', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const proof = await proveNodeManifestTurbopackConsumers(await own.consumerInput());

    expect(new Set(proof.terminals.map((entry) => entry.file))).toStrictEqual(
      new Set([own.first.file, own.second.file]),
    );
    expect(proof.files.map((entry) => entry.file)).toContain(own.chunk);
    expect(proof.files.map((entry) => entry.file)).toContain(own.wrapperTable);
    expect(proof.pagesConjunctionStage).toBeDefined();
    expect(proof.requiresSdkNormalization).toBe(true);
  });

  it('closes the real outer SDK and bound proofs before returning a route rewrite approval', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const proof = await proveNodeManifests(own.input, own.graph);

    expect(proof.routeRewriteApprovals).toHaveLength(1);
    expect(proof.normalization?.entries.map((entry) => entry.id)).toStrictEqual(
      own.input.entries.map((entry) => entry.id),
    );
    expect(proof.files.map((entry) => entry.file)).toContain(own.wrapperTable);
  });

  it('refuses when only the second constructor wrapper has an additional effect', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    await own.put(
      own.wrapperTable,
      (await readFile(own.wrapperTable, 'utf8')).replace('const ns=', 'extraEffect();const ns='),
    );
    own.link();

    await expect(proveNodeManifestTurbopackConsumers(await own.consumerInput())).rejects.toThrow(
      'refusing native publication',
    );
  });

  it('does not approve the first parent when the second parent has mismatched route metadata', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const input = await own.consumerInput();
    const entries = input.entries.map((entry) =>
      entry.file === own.second.file ? { ...entry, page: '/wrong/[slug]' } : entry,
    );

    await expect(proveNodeManifestTurbopackConsumers({ ...input, entries })).rejects.toThrow(
      'refusing native publication',
    );
  });

  it('requires the second parent to reach an actual SDK importer, even when the first parent closes', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    own.imports.set(
      own.analysisEntry,
      own.input.entries
        .filter((entry) => entry.filePath !== own.second.file)
        .map((entry) => ({ specifier: entry.filePath, target: entry.filePath })),
    );
    own.link();

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unclosed consumer chain',
    );
  });

  it('keeps a string module operand distinct from the numeric constructor registration', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const original = await readFile(own.chunk, 'utf8');
    const edges = [...(own.imports.get(own.chunk) ?? [])];
    await own.put(own.chunk, original.replace('runtimeContext.i(77)', 'runtimeContext.i("77")'));
    own.imports.set(own.chunk, edges);
    own.link();

    await expect(proveNodeManifestTurbopackConsumers(await own.consumerInput())).rejects.toThrow(
      'unregistered module dependency',
    );
  });

  it('refuses a changed generated SDK entry after the inner constructor graph can close', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    await own.put(own.analysisEntry, 'module.exports=untrusted;');
    own.imports.set(
      own.analysisEntry,
      own.input.entries.map((entry) => ({ specifier: entry.filePath, target: entry.filePath })),
    );
    own.link();

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unproved SDK entry terminal',
    );
  });
});
