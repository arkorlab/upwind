import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNodeManifestBoundBatch,
  certifyNodeManifestBoundConsumer,
  commitNodeManifestBoundStage,
  createNodeManifestBoundBatch,
  stageNodeManifestBoundProof,
} from '../src/node-manifest-bound-batch.ts';
import { APP_PAGE_FACTORY } from '../src/node-manifest-framework.ts';
import { proveNodeManifests } from '../src/node-manifest-proof.ts';
import { prepareNodeManifestRuntimeGraphs } from '../src/node-manifest-runtime-cohort.ts';
import {
  proveNodeManifestTurbopackConsumers,
  type NodeManifestTurbopackConsumerProof,
  type NodeManifestTurbopackConsumerInput,
} from '../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  addBoundBatchTemplate,
  boundBatchConsumerInput,
  boundBatchFixture,
} from './fixtures/node-manifest-bound-batch.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

function stageOf(proof: NodeManifestTurbopackConsumerProof) {
  if (proof.boundStage === undefined) throw new Error('Expected a provisional proof stage');
  return proof.boundStage;
}

function consumerCertificate(input: NodeManifestTurbopackConsumerInput) {
  const prepared = prepareNodeManifestRuntimeGraphs({
    ...input,
    inventory: input.runtimeCallers,
    profiles: input.runtimeProfiles,
  });
  const factory = prepared.graphs
    .flatMap((graph) => graph.factories)
    .find((candidate) => candidate.projection.moduleId === 1);
  const route = input.entries[0];
  if (factory === undefined || route === undefined)
    throw new Error('Expected actual AppPage source');
  const strict = {
    ...factory,
    projection: projectNodeManifestTurbopackFactory(
      factory.projection.original,
      factory.projection.moduleId,
    ),
  };
  const certificate = certifyNodeManifestBoundConsumer({
    factory: strict,
    context: input,
    cohort: prepared.cohort,
    route,
    imports: [
      {
        specifier: 'turbopack:2',
        file: input.producer.file,
        sha256: input.producer.sha256,
        kind: APP_PAGE_FACTORY,
        exportName: 'createAppPageEntrypoint',
      },
    ],
  });
  return { prepared, certificate };
}

describe('whole manifest bound runtime obligation batch', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'bound-manifest-source-');
    const temporary = await mkdtemp(prefix);
    directory = await realpath(temporary);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['pages', 'pages-api'] as const)(
    'closes real AppPage and %s source proofs through the exact SDK normalization root',
    async (kind) => {
      const own = await boundBatchFixture(directory);
      await addBoundBatchTemplate(own, kind);
      const proof = await proveNodeManifests(own.input, own.graph);

      expect(proof.normalization?.entries.map((entry) => entry.id)).toStrictEqual(
        own.input.entries.map((entry) => entry.id),
      );
      expect(proof.files.map((entry) => entry.file)).toContain(own.manifest);
      expect(proof.approvedCompilerSources.map((entry) => entry.file)).toStrictEqual([own.runtime]);
    },
  );

  it('collects obligations before their discharges without depending on producer visit order', async () => {
    const own = await boundBatchFixture(directory);
    await addBoundBatchTemplate(own, 'pages');
    own.graph.importers.set(
      own.evaluator,
      [...(own.graph.importers.get(own.evaluator) ?? [])].toReversed(),
    );

    await expect(proveNodeManifests(own.input, own.graph)).resolves.toHaveProperty('normalization');
  });

  it('preserves the standalone immediate refusal for another kind bound factory', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const input = await boundBatchConsumerInput(own, other, 'pages');

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'bound runtime callback escapes a sealed consumer',
    );
  });

  it('does not discharge AppPage obligations merely because the Pages proof and its root succeed', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const batch = createNodeManifestBoundBatch();
    const proof = await proveNodeManifestTurbopackConsumers({
      ...(await boundBatchConsumerInput(own, other, 'pages')),
      boundBatch: batch,
    });
    commitNodeManifestBoundStage(batch, stageOf(proof));

    expect(() => {
      assertNodeManifestBoundBatch(batch);
    }).toThrow('bound callback escapes a sealed AppPage consumer');
  });

  it('does not yield artifact approvals when the SDK normalization root is changed', async () => {
    const own = await boundBatchFixture(directory);
    await addBoundBatchTemplate(own, 'pages-api');
    await own.put(own.analysisEntry, 'module.exports=untrusted;');
    own.imports.set(
      own.analysisEntry,
      own.input.entries.map((entry) => ({ specifier: entry.filePath, target: entry.filePath })),
    );

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'unproved SDK entry terminal',
    );
  });

  it('requires the actual outer terminal walk to commit every provisional stage', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const batch = createNodeManifestBoundBatch();
    await proveNodeManifestTurbopackConsumers({
      ...(await boundBatchConsumerInput(own, other, 'app-page')),
      boundBatch: batch,
    });

    expect(() => {
      assertNodeManifestBoundBatch(batch);
    }).toThrow('uncommitted SDK terminal stage');
  });

  it('rejects copied collectors, copied stages and cross-build stage commits', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const input = await boundBatchConsumerInput(own, other, 'app-page');
    const batch = createNodeManifestBoundBatch();
    const proof = await proveNodeManifestTurbopackConsumers({ ...input, boundBatch: batch });
    const stage = stageOf(proof);

    await expect(
      proveNodeManifestTurbopackConsumers({ ...input, boundBatch: { ...batch } }),
    ).rejects.toThrow('uncertified collector');
    expect(() => {
      commitNodeManifestBoundStage(batch, { ...stage });
    }).toThrow('uncertified or reused stage');
    expect(() => {
      commitNodeManifestBoundStage(createNodeManifestBoundBatch(), stage);
    }).toThrow('uncertified or reused stage');
  });

  it('binds consumer certificates to the exact build collector even when every source and scope is identical', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const original = await boundBatchConsumerInput(own, other, 'app-page');
    const first = createNodeManifestBoundBatch();
    const input = { ...original, boundBatch: first };
    const { prepared, certificate } = consumerCertificate(input);
    const second = createNodeManifestBoundBatch();

    expect(() => {
      return stageNodeManifestBoundProof({
        batch: second,
        consumer: { ...original, boundBatch: second },
        cohort: prepared.cohort,
        factories: prepared.allGraphs.flatMap((graph) => graph.factories),
        certified: [certificate],
      });
    }).toThrow('uncertified or foreign AppPage discharge');
    expect(() => {
      return stageNodeManifestBoundProof({
        batch: first,
        consumer: input,
        cohort: prepared.cohort,
        factories: prepared.allGraphs.flatMap((graph) => graph.factories),
        certified: [{ ...certificate }],
      });
    }).toThrow('uncertified or foreign AppPage discharge');
  });

  it('rejects an original source or resolution scope change between producer proofs', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const input = await boundBatchConsumerInput(own, other, 'pages');
    const batch = createNodeManifestBoundBatch();
    const proof = await proveNodeManifestTurbopackConsumers({ ...input, boundBatch: batch });
    commitNodeManifestBoundStage(batch, stageOf(proof));
    const changed = await boundBatchConsumerInput(own, other, 'app-page');
    const file = path.join(directory, 'extra.js');
    const sources = [
      ...changed.sources,
      { id: file, file, source: source('exports.value=1;'), imports: [] },
    ];

    await expect(
      proveNodeManifestTurbopackConsumers({ ...changed, sources, boundBatch: batch }),
    ).rejects.toThrow('source or cohort scope mismatch');
  });

  it('requires a reviewed runtime cohort for deferral and refuses finalized handle reuse', async () => {
    const own = await boundBatchFixture(directory);
    const other = await addBoundBatchTemplate(own, 'pages');
    const input = await boundBatchConsumerInput(own, other, 'app-page');
    const batch = createNodeManifestBoundBatch();
    assertNodeManifestBoundBatch(batch);

    await expect(
      proveNodeManifestTurbopackConsumers({ ...input, boundBatch: batch }),
    ).rejects.toThrow('finalized collector');
    await expect(
      proveNodeManifestTurbopackConsumers({
        ...input,
        runtimeProfiles: undefined,
        boundBatch: createNodeManifestBoundBatch(),
      }),
    ).rejects.toThrow('missing reviewed cohort');
  });

  it('keeps unknown bound callbacks under the final all-factory obligation gate', async () => {
    const own = await boundBatchFixture(directory);
    await addBoundBatchTemplate(own, 'pages');
    const code = await readFile(own.chunk, 'utf8');
    const imports = own.imports.get(own.chunk) ?? [];
    await own.put(
      own.chunk,
      code.replace(
        'module.exports=[',
        'module.exports=[99,ctx=>{const input={require:ctx.r.bind(ctx)};ctx.v(42);},',
      ),
    );
    own.imports.set(own.chunk, imports);

    await expect(proveNodeManifests(own.input, own.graph)).rejects.toThrow(
      'bound callback escapes a sealed AppPage consumer',
    );
  });
});
