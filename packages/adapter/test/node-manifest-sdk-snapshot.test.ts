import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROUTE_EXPORTS } from '../src/node-manifest-framework.ts';
import * as routes from '../src/node-manifest-routes.ts';
import {
  assertNodeManifestPendingSdkContext,
  certifyNodeManifestSdkTerminal,
  prepareNodeManifestSdkTerminalScope,
} from '../src/node-manifest-sdk-terminal.ts';
import { pagesConjunctionChainFixture } from './fixtures/node-manifest-pages-conjunction-chain.ts';

async function fixture(directory: string) {
  const own = await pagesConjunctionChainFixture(directory);
  const { scope } = await prepareNodeManifestSdkTerminalScope(own.input, own.graph);
  const input = { ...(await own.consumerInput()), sdkTerminalScope: scope };
  return { own, scope, input };
}

describe('original SDK graph and pending input snapshots', () => {
  let directory: string;

  beforeEach(async () => {
    const prefix = path.join(tmpdir(), 'sdk-identity-source-');
    directory = await realpath(await mkdtemp(prefix));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('revalidates an original pending input and fully validates each distinct input', async () => {
    const own = await fixture(directory);
    assertNodeManifestPendingSdkContext(own.scope, own.input);
    assertNodeManifestPendingSdkContext(own.scope, own.input);
    const first = own.input.sources[0];
    assert(first !== undefined);
    const sources = own.input.sources.map((source) => {
      return source === first
        ? { ...source, source: { ...source.source, code: 'different initial bytes' } }
        : source;
    });

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, { ...own.input, sources });
    }).toThrow('pending SDK original source binding');
    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, { ...own.input });
    }).not.toThrow();
  });

  it('refuses a copied source array on an already sealed original consumer input', async () => {
    const own = await fixture(directory);
    assertNodeManifestPendingSdkContext(own.scope, own.input);
    Reflect.set(own.input, 'sources', [...own.input.sources]);

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.input);
    }).toThrow('pending SDK original source binding');
  });

  it('refuses a nested code mutation after the first source hash validation', async () => {
    const own = await fixture(directory);
    assertNodeManifestPendingSdkContext(own.scope, own.input);
    const first = own.input.sources[0];
    assert(first !== undefined);
    Reflect.set(first.source, 'code', 'changed source with unchanged claimed digest');

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.input);
    }).toThrow('pending SDK original source binding');
  });

  it('does not invoke a newly installed source getter before checking the pending snapshot', async () => {
    const own = await fixture(directory);
    assertNodeManifestPendingSdkContext(own.scope, own.input);
    const first = own.input.sources[0];
    assert(first !== undefined);
    let calls = 0;
    Object.defineProperty(first.source, 'code', {
      get() {
        calls += 1;
        return 'unread';
      },
    });

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.input);
    }).toThrow('pending SDK original source binding');
    expect(calls).toBe(0);
  });

  it('rejects a first-input accessor before reading its fields', async () => {
    const own = await fixture(directory);
    let calls = 0;
    const input = { ...own.input };
    Object.defineProperty(input, 'sources', {
      get() {
        calls += 1;
        return own.input.sources;
      },
    });

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, input);
    }).toThrow('accessor');
    expect(calls).toBe(0);
  });

  it('checks the stored SDK wrapper before a graph pointer helper can invoke a getter', async () => {
    const own = await fixture(directory);
    const original = own.own.graph.sources;
    let calls = 0;
    Object.defineProperty(own.own.graph, 'sources', {
      get() {
        calls += 1;
        return original;
      },
    });

    expect(() => {
      assertNodeManifestPendingSdkContext(own.scope, own.input);
    }).toThrow('stale or uncertified SDK terminal scope');
    expect(calls).toBe(0);
  });

  it('rechecks graph property descriptors after real asynchronous SDK source reads', async () => {
    const own = await fixture(directory);
    const first = own.input.entries[0];
    assert(first !== undefined);
    const pending = certifyNodeManifestSdkTerminal(own.scope, own.own.analysisEntry, {
      id: first.file,
      kind: ROUTE_EXPORTS,
    });
    const original = own.own.graph.sources;
    let calls = 0;
    Object.defineProperty(own.own.graph, 'sources', {
      get() {
        calls += 1;
        return original;
      },
    });

    await expect(pending).rejects.toThrow('stale or uncertified SDK terminal scope');
    expect(calls).toBe(0);
  });

  it('checks the original input snapshot before post-sealing pointer reads', async () => {
    const own = await pagesConjunctionChainFixture(directory);
    const original = routes.sealedRoutes;
    const entries = own.input.entries;
    let calls = 0;
    vi.spyOn(routes, 'sealedRoutes').mockImplementationOnce(async (...args) => {
      const sealed = await original(...args);
      Object.defineProperty(own.input, 'entries', {
        get() {
          calls += 1;
          return entries;
        },
      });
      return sealed;
    });

    await expect(prepareNodeManifestSdkTerminalScope(own.input, own.graph)).rejects.toThrow(
      'changed SDK terminal inputs while sealing',
    );
    expect(calls).toBe(0);
  });
});
