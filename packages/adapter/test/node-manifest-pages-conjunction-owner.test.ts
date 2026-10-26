import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeManifestPagesConjunctionIncoming } from '../src/node-manifest-pages-conjunction-incoming.ts';
import { NodeManifestPagesConjunctionWalk } from '../src/node-manifest-pages-conjunction-walk.ts';
import { withNodeManifestRegistrationPass } from '../src/node-manifest-registration-pass.ts';
import { createNodeManifestRegistrationViews } from '../src/node-manifest-registration-views.ts';
import { prepareNodeManifestRuntimeGraphs } from '../src/node-manifest-runtime-cohort.ts';
import { prepareNodeManifestSdkTerminalScope } from '../src/node-manifest-sdk-terminal.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFactory } from '../src/node-manifest-turbopack-graph.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

async function fixture(directory: string) {
  const own = await pagesConjunctionChainFixture(directory);
  const { scope: sdkTerminalScope } = await prepareNodeManifestSdkTerminalScope(
    own.input,
    own.graph,
  );
  const input = { ...(await own.consumerInput()), sdkTerminalScope };
  const prepared = prepareNodeManifestRuntimeGraphs({
    ...input,
    inventory: input.runtimeCallers,
    profiles: input.runtimeProfiles,
  });
  const registrations = createNodeManifestRegistrationViews(prepared.allGraphs, input.sources);
  const factories = new Map(
    prepared.allGraphs.flatMap((graph) =>
      graph.factories.map((factory) => [factory.id, factory] as const),
    ),
  );
  return { own, input, prepared, registrations, factories };
}

function factoryWithModuleId(
  factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>,
  moduleId: number,
): NodeManifestTurbopackGraphFactory | undefined {
  for (const factory of factories.values())
    if (factory.projection.moduleId === moduleId) return factory;
  return undefined;
}

describe('private Pages conjunction mint owner', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'pages-conjunction-owner-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses a synthetic owner even with genuine source, index, cohort and SDK scope', async () => {
    const own = await fixture(directory);
    const forged = Object.freeze({ identity: Symbol('not a private consumer owner') });

    expect(() => {
      return new NodeManifestPagesConjunctionWalk({
        consumerOwner: forged,
        input: own.input,
        owner: Object.freeze({ identity: Symbol('helper owner') }),
        graphs: own.prepared.allGraphs,
        registrations: own.registrations,
        factories: own.factories,
      });
    }).toThrow('uncertified private consumer owner');
  });

  it('does not mint an initially subsetted stage through the reachable prototype API', async () => {
    const own = await fixture(directory);
    const proof = await proveNodeManifestTurbopackConsumers(own.input);
    const subset = { ...proof, terminals: proof.terminals.slice(0, 1) };
    const forged = { consumerOwner: Object.freeze({ identity: Symbol('forged private owner') }) };

    expect(() => {
      Reflect.apply(vi.spyOn(NodeManifestPagesConjunctionWalk.prototype, 'stage'), forged, [
        subset,
      ]);
    }).toThrow('uncertified private consumer owner');
  });

  it('derives both original template parents directly from the pass-bound complete rows', async () => {
    const own = await fixture(directory);
    const first = factoryWithModuleId(own.factories, 10);
    const second = factoryWithModuleId(own.factories, 11);
    const target = first?.imports.find((edge) => edge.specifier === 'turbopack:77')?.target;
    assert(
      first !== undefined && second !== undefined && target !== undefined,
      'Expected both actual protected template parents',
    );
    const incoming = withNodeManifestRegistrationPass(own.registrations, (scope) => {
      return nodeManifestPagesConjunctionIncoming({
        input: own.input,
        graphs: own.prepared.allGraphs,
        registrations: own.registrations,
        factories: own.factories,
        scope,
      });
    });

    expect(new Set(incoming.get(target))).toStrictEqual(new Set([first.id, second.id]));
  });

  it('cannot derive a topology from a caller-selected subset of actual physical rows', async () => {
    const own = await fixture(directory);
    const subset = new Map(own.factories);
    const second = factoryWithModuleId(subset, 11);
    assert(second !== undefined, 'Expected the second actual template');
    subset.delete(second.id);

    expect(() => {
      withNodeManifestRegistrationPass(own.registrations, (scope) => {
        return nodeManifestPagesConjunctionIncoming({
          input: own.input,
          graphs: own.prepared.allGraphs,
          registrations: own.registrations,
          factories: subset,
          scope,
        });
      });
    }).toThrow('incomplete physical rows');
  });
});
