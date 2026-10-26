import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNodeManifestBoundBatch,
  assertNodeManifestBoundStageCommitted,
  commitNodeManifestBoundStage,
  createNodeManifestBoundBatch,
} from '../src/node-manifest-bound-batch.ts';
import { ROUTE_EXPORTS } from '../src/node-manifest-framework.ts';
import { commitNodeManifestPagesConjunctionStage } from '../src/node-manifest-pages-conjunction-walk.ts';
import {
  certifyNodeManifestSdkTerminal,
  prepareNodeManifestSdkTerminalScope,
} from '../src/node-manifest-sdk-terminal.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

async function stageFixture(directory: string) {
  const own = await pagesConjunctionChainFixture(directory);
  const { scope } = await prepareNodeManifestSdkTerminalScope(own.input, own.graph);
  const input = { ...(await own.consumerInput()), sdkTerminalScope: scope };
  const proof = await proveNodeManifestTurbopackConsumers(input);
  const batch = input.boundBatch;
  const stage = proof.boundStage;
  assert(batch !== undefined && stage !== undefined, 'Expected actual pending bound stage');
  const certificates = await Promise.all(
    proof.terminals.map(async (terminal) => {
      const certificate = await certifyNodeManifestSdkTerminal(scope, own.analysisEntry, {
        id: terminal.id,
        kind: ROUTE_EXPORTS,
      });
      assert(certificate !== undefined, 'Expected a real source-certified SDK terminal');
      return certificate;
    }),
  );
  return { own, input, proof, batch, stage, certificates, scope };
}

describe('pending Pages conjunction SDK lifecycle', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'pages-conjunction-stage-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('finalizes after the inner pass is revoked only with exact real SDK proofs and a committed bound stage', async () => {
    const own = await stageFixture(directory);

    expect(() => {
      assertNodeManifestBoundStageCommitted(own.batch, own.stage);
    }).toThrow('uncommitted or foreign');

    commitNodeManifestBoundStage(own.batch, own.stage);

    expect(() => {
      assertNodeManifestBoundStageCommitted(own.batch, own.stage);
    }).not.toThrow();

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).resolves.toBeUndefined();
    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).rejects.toThrow('reused SDK stage');
    // A constructor conjunction cannot discharge the separate real AppPage bound obligation.
    expect(() => {
      assertNodeManifestBoundBatch(own.batch);
    }).toThrow('bound callback escapes');
  });

  it('refuses SDK completion while the exact bound stage remains pending', async () => {
    const own = await stageFixture(directory);

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).rejects.toThrow('uncommitted or foreign');
  });

  it('does not treat manual bound commitment as a certificate for any SDK terminal', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);

    await expect(commitNodeManifestPagesConjunctionStage(own.proof, [])).rejects.toThrow(
      'complete SDK terminal certificates',
    );
    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates.slice(0, 1)),
    ).rejects.toThrow('complete SDK terminal certificates');
  });

  it('rejects copied bound and SDK tokens and another private batch', async () => {
    const own = await stageFixture(directory);
    const copiedStage = { ...own.stage };
    const foreign = createNodeManifestBoundBatch();
    commitNodeManifestBoundStage(own.batch, own.stage);

    expect(() => {
      assertNodeManifestBoundStageCommitted(own.batch, copiedStage);
    }).toThrow('uncommitted or foreign');
    expect(() => {
      assertNodeManifestBoundStageCommitted(foreign, own.stage);
    }).toThrow('uncommitted or foreign');

    const copies = own.certificates.map((certificate) => ({ ...certificate }));

    await expect(commitNodeManifestPagesConjunctionStage(own.proof, copies)).rejects.toThrow(
      'foreign or substituted SDK',
    );
  });

  it('does not substitute source-valid SDK certificates from another private outer scope', async () => {
    const own = await stageFixture(directory);
    const { scope } = await prepareNodeManifestSdkTerminalScope(own.own.input, own.own.graph);
    const foreign = await Promise.all(
      own.proof.terminals.map(async (terminal) => {
        const certificate = await certifyNodeManifestSdkTerminal(scope, own.own.analysisEntry, {
          id: terminal.id,
          kind: ROUTE_EXPORTS,
        });
        assert(certificate !== undefined, 'Expected independently source-valid SDK proof');
        return certificate;
      }),
    );
    commitNodeManifestBoundStage(own.batch, own.stage);

    await expect(commitNodeManifestPagesConjunctionStage(own.proof, foreign)).rejects.toThrow(
      'foreign or substituted SDK',
    );
  });

  it('rejects a copied consumer proof even when its opaque stage object is retained', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);

    await expect(
      commitNodeManifestPagesConjunctionStage({ ...own.proof }, own.certificates),
    ).rejects.toThrow('uncertified consumer proof');
  });

  it('does not substitute another real committed stage from the same batch', async () => {
    const own = await stageFixture(directory);
    const other = await proveNodeManifestTurbopackConsumers(own.input);
    assert(other.boundStage !== undefined, 'Expected the independently staged bound proof');
    commitNodeManifestBoundStage(own.batch, other.boundStage);
    Object.assign(own.proof, { boundStage: other.boundStage });

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).rejects.toThrow('changed bound SDK stage');
  });

  it('cannot downgrade a genuine staged proof by clearing its optional stage field', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    Object.assign(own.proof, { pagesConjunctionStage: undefined });

    await expect(commitNodeManifestPagesConjunctionStage(own.proof, [])).rejects.toThrow(
      'changed pending SDK stage association',
    );
  });

  it('does not accept a terminal subset substituted into the original proof object', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    Object.assign(own.proof, { terminals: own.proof.terminals.slice(0, 1) });

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates.slice(0, 1)),
    ).rejects.toThrow('foreign, changed or reused SDK');
  });

  it('consumes a pending stage at most once when two real finalizations run concurrently', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    const results = await Promise.allSettled([
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ]);

    expect(new Set(results.map((result) => result.status))).toStrictEqual(
      new Set(['fulfilled', 'rejected']),
    );
  });

  it('rechecks actual SDK bytes after the inner result and SDK certificate were returned', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    await writeFile(own.own.analysisEntry, 'module.exports=changed;');

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).rejects.toThrow('consumer source changed');
  });

  it('rejects a changed physical wrapper after the inner pass has ended', async () => {
    const own = await stageFixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    const wrapper = own.input.sources.find((source) => source.file === own.own.wrapperTable);
    assert(wrapper !== undefined, 'Expected the actual second wrapper source');
    Object.assign(wrapper.source, { code: `${wrapper.source.code}\n` });

    await expect(
      commitNodeManifestPagesConjunctionStage(own.proof, own.certificates),
    ).rejects.toThrow('changed owner or graph scope');
  });
});
