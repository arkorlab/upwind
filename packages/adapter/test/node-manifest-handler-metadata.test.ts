import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { commitNodeManifestBoundStage } from '../src/node-manifest-bound-batch.ts';
import { ROUTE_EXPORTS } from '../src/node-manifest-framework.ts';
import { commitNodeManifestHandlerMetadata } from '../src/node-manifest-handler-metadata.ts';
import * as sdkTerminal from '../src/node-manifest-sdk-terminal.ts';
import {
  certifyNodeManifestSdkTerminal,
  prepareNodeManifestSdkTerminalScope,
} from '../src/node-manifest-sdk-terminal.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

async function fixture(directory: string) {
  const own = await pagesConjunctionChainFixture(directory);
  const { scope } = await prepareNodeManifestSdkTerminalScope(own.input, own.graph);
  const input = { ...(await own.consumerInput()), sdkTerminalScope: scope };
  const proof = await proveNodeManifestTurbopackConsumers(input);
  const batch = input.boundBatch;
  const stage = proof.boundStage;
  assert(batch !== undefined && stage !== undefined);
  const certificates = await Promise.all(
    proof.terminals.map(async (terminal) => {
      const token = await certifyNodeManifestSdkTerminal(scope, own.analysisEntry, {
        id: terminal.id,
        kind: ROUTE_EXPORTS,
      });
      assert(token !== undefined);
      return token;
    }),
  );
  return { own, input, proof, batch, stage, certificates, scope };
}

describe('private handler metadata outer lifecycle', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'handler-metadata-stage-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('publishes the private frozen empty list after revoked pass, all real SDK certificates and exact bound commit', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    const metadata = await commitNodeManifestHandlerMetadata(own.proof, own.certificates);

    expect(metadata).toStrictEqual([]);
    expect(metadata).toBe(own.proof.helperMetadataFiles);
    expect(Object.isFrozen(metadata)).toBe(true);
    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'copied, consumed or unstaged proof',
    );
  });

  it('refuses a pending exact bound stage and incomplete SDK certificate sets', async () => {
    const own = await fixture(directory);

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'uncommitted or foreign',
    );

    commitNodeManifestBoundStage(own.batch, own.stage);

    await expect(commitNodeManifestHandlerMetadata(own.proof, [])).rejects.toThrow(
      'incomplete outer closure',
    );
    await expect(
      commitNodeManifestHandlerMetadata(own.proof, own.certificates.slice(0, 1)),
    ).rejects.toThrow('incomplete outer closure');
  });

  it('refuses copied tokens and genuine tokens from another exact SDK scope', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);

    await expect(
      commitNodeManifestHandlerMetadata(
        own.proof,
        own.certificates.map((token) => ({ ...token })),
      ),
    ).rejects.toThrow('foreign or substituted SDK terminal certificate');

    const { scope } = await prepareNodeManifestSdkTerminalScope(own.own.input, own.own.graph);
    const foreign = await Promise.all(
      own.proof.terminals.map(async (terminal) => {
        const token = await certifyNodeManifestSdkTerminal(scope, own.own.analysisEntry, {
          id: terminal.id,
          kind: ROUTE_EXPORTS,
        });
        assert(token !== undefined);
        return token;
      }),
    );

    await expect(commitNodeManifestHandlerMetadata(own.proof, foreign)).rejects.toThrow(
      'foreign or substituted SDK terminal certificate',
    );
  });

  it('rejects a public metadata field replacement before publishing any private list', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    Reflect.set(own.proof, 'helperMetadataFiles', Object.freeze([]));

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'changed original proof or metadata field',
    );
  });

  it('rejects a metadata getter before any proof field helper reads it', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    const original = own.proof.helperMetadataFiles;
    let calls = 0;
    Object.defineProperty(own.proof, 'helperMetadataFiles', {
      get() {
        calls += 1;
        return original;
      },
    });

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'changed original proof or metadata field',
    );
    expect(calls).toBe(0);
  });

  it('rejects a getter installed after a genuine SDK certificate await without invoking it', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    const original = sdkTerminal.assertNodeManifestSdkTerminal;
    const metadata = own.proof.helperMetadataFiles;
    let calls = 0;
    vi.spyOn(sdkTerminal, 'assertNodeManifestSdkTerminal').mockImplementationOnce(
      async (...args) => {
        await original(...args);
        Object.defineProperty(own.proof, 'helperMetadataFiles', {
          get() {
            calls += 1;
            return metadata;
          },
        });
      },
    );

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'changed original proof or metadata field',
    );
    expect(calls).toBe(0);
  });

  it('rechecks pinned producer filesystem bytes after the inner pass returned', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    await writeFile(own.own.producer, 'changedSource;');

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'source bytes changed',
    );
  });

  it('keeps an opaque Pages stage handle bound independently of equal JSON', async () => {
    const own = await fixture(directory);
    commitNodeManifestBoundStage(own.batch, own.stage);
    assert(own.proof.pagesConjunctionStage !== undefined);
    Reflect.set(own.proof, 'pagesConjunctionStage', { ...own.proof.pagesConjunctionStage });

    await expect(commitNodeManifestHandlerMetadata(own.proof, own.certificates)).rejects.toThrow(
      'changed original proof or metadata field',
    );
  });
});
