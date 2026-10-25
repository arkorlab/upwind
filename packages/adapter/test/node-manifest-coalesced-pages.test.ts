import { describe, expect, it } from 'vitest';

import {
  certifyNodeManifestCoalescedPages,
  nodeManifestCoalescedPagesInspection,
} from '../src/node-manifest-coalesced-pages.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  COALESCED_CHUNK,
  COALESCED_ENTRY,
  coalescedPagesFixture,
} from './fixtures/node-manifest-coalesced-pages.ts';

async function proofWithPrelude(prelude: string) {
  const fixture = await coalescedPagesFixture({ prelude });
  return await proveNodeManifestTurbopackConsumers(fixture.input);
}
async function invalidRegistry() {
  const fixture = await coalescedPagesFixture({ extraFactories: '42,ctx=>{ctx.v({});},' });
  return await proveNodeManifestTurbopackConsumers(fixture.input);
}
async function wrongReadType() {
  const fixture = await coalescedPagesFixture({ readId: '42' });
  return await proveNodeManifestTurbopackConsumers(fixture.input);
}

describe('one closed coalesced userland namespace in a sealed Pages factory', () => {
  it('keeps generic strict foreign-ID refusal while closing the actual protected Pages proof', async () => {
    const fixture = await coalescedPagesFixture();
    const original = fixture.factory.projection.original;

    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow('foreign export target');

    const proof = await proveNodeManifestTurbopackConsumers(fixture.input);

    expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([COALESCED_ENTRY]);
    expect(proof.compilerSources.some((source) => source.file === COALESCED_CHUNK)).toBe(false);
    expect(proof.requiresSdkNormalization).toBe(true);
    expect(fixture.factory.projection.original).toStrictEqual(original);
  });

  it.each(['const', 'let', 'var'] as const)(
    'accepts a stable %s function value without changing its physical graph',
    async (kind) => {
      const prelude = `${kind} Page=async function NativePage(){return "native";};runtimeContext.s(["default",0,Page],42);`;
      const fixture = await coalescedPagesFixture({ prelude, readKind: kind });
      const before = JSON.stringify(fixture.graph);
      const profile = certifyNodeManifestCoalescedPages({ ...fixture, owner: fixture.input });
      const inspected = nodeManifestCoalescedPagesInspection(
        profile,
        fixture.input,
        fixture.factory.projection,
        fixture.route,
      );

      expect(inspected.raw.original).toStrictEqual(fixture.factory.projection.original);
      expect(inspected.inspectionSource.sha256).not.toBe(inspected.raw.original.sha256);
      expect(inspected.projection.mode).toBe('strict');
      expect(
        inspected.projection.imports.some((entry) => entry.specifier.includes('coalesced')),
      ).toBe(false);
      expect(JSON.stringify(fixture.graph)).toBe(before);
      await expect(proveNodeManifestTurbopackConsumers(fixture.input)).resolves.toMatchObject({
        requiresSdkNormalization: true,
      });
    },
  );

  it('binds profiles to the original graph and consumer object even for identical source', async () => {
    const fixture = await coalescedPagesFixture();
    const profile = certifyNodeManifestCoalescedPages({ ...fixture, owner: fixture.input });

    expect(() => {
      return nodeManifestCoalescedPagesInspection(
        profile,
        { ...fixture.input },
        fixture.factory.projection,
        fixture.route,
      );
    }).toThrow('cross-batch identity');
    expect(() => {
      return nodeManifestCoalescedPagesInspection(
        { ...profile },
        fixture.input,
        fixture.factory.projection,
        fixture.route,
      );
    }).toThrow('copied');
  });

  it('keeps an ordinary Next/router dependency outside privileged framework authority', async () => {
    const fixture = await coalescedPagesFixture({
      prelude:
        'var Router=runtimeContext.x("next/router",()=>require("next/router"));runtimeContext.s(["default",0,function Page(){return Router.useRouter();}],42);',
      externals: ['next/router'],
    });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).resolves.toMatchObject({
      requiresSdkNormalization: true,
    });
  });

  it('does not retarget a minted profile by replacing the caller input owner', async () => {
    const fixture = await coalescedPagesFixture();
    const current = { ...fixture, owner: fixture.input };
    const profile = certifyNodeManifestCoalescedPages(current);
    current.owner = { ...fixture.input };

    expect(() => {
      return nodeManifestCoalescedPagesInspection(
        profile,
        current.owner,
        current.factory.projection,
        current.route,
      );
    }).toThrow('cross-batch identity');
  });

  it('does not replace the minted graph object with an identical-content graph', async () => {
    const fixture = await coalescedPagesFixture();
    const current = { ...fixture, owner: fixture.input };
    const profile = certifyNodeManifestCoalescedPages(current);
    current.graph = { ...fixture.graph };

    expect(() => {
      return nodeManifestCoalescedPagesInspection(
        profile,
        current.owner,
        current.factory.projection,
        current.route,
      );
    }).toThrow('cross-batch identity');
  });

  it('does not replace the minted factory object with an identical-content factory', async () => {
    const fixture = await coalescedPagesFixture();
    const current = { ...fixture, owner: fixture.input };
    const profile = certifyNodeManifestCoalescedPages(current);
    current.factory = { ...fixture.factory };

    expect(() => {
      return nodeManifestCoalescedPagesInspection(
        profile,
        current.owner,
        current.factory.projection,
        current.route,
      );
    }).toThrow('cross-batch identity');
  });

  it('retains full-table registered-ID collision refusal', async () => {
    await expect(invalidRegistry()).rejects.toThrow('collides with a registered module ID');
  });

  it('audits original normalized imports before hiding any userland code', async () => {
    const fixture = await coalescedPagesFixture({
      prelude:
        'var vm=runtimeContext.x("node:vm",()=>require("node:vm"));runtimeContext.s(["default",0,function Page(){return vm.runInThisContext("42");}],42);',
      builtins: ['node:vm'],
    });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow(
      'original inspection has an unproved Node module loader',
    );
  });

  it('keeps numeric and string cache identities distinct', async () => {
    await expect(wrongReadType()).rejects.toThrow('unregistered module dependency');
  });

  it('does not broaden own protected exports to inline function values', async () => {
    const fixture = await coalescedPagesFixture({ ownInline: true });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow(
      'export value expression',
    );
  });

  it.each([
    'runtimeContext.s(["default",0,function Page(){return module.exports.routeModule;}],42);',
    'runtimeContext.s(["default",0,function Page(){return handler;}],42);',
    'runtimeContext.s(["default",0,function Page(){return _modulecompiled.PagesRouteModule;}],42);',
    'let Page=()=>"native";runtimeContext.s(["default",0,Page],42);Page=other;',
    'let Page=()=>"native";runtimeContext.s(["default",0,Page],42);function later(){Page=other;}',
    'const Page=effect();runtimeContext.s(["default",0,Page],42);',
    'class Page extends effect(){}runtimeContext.s(["default",0,Page],42);',
    'runtimeContext.s(["default",()=>Page],42);function Page(){return "native";}',
    'runtimeContext.s(["default",0,Page],42);var Page=()=>"native";',
  ])(
    'refuses a hidden mutation, privileged capture, eager effect or unsupported export: %s',
    async (prelude) => {
      await expect(proofWithPrelude(prelude)).rejects.toThrow('Unproved');
    },
  );

  it('does not infer adjacency from ordinary cache metadata', async () => {
    const fixture = await coalescedPagesFixture({ between: 'effect();' });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow(
      'between write and read',
    );
  });

  it('preserves a grouped stable wrapper import while isolating only the namespace role', async () => {
    const fixture = await coalescedPagesFixture({ grouped: true });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).resolves.toMatchObject({
      requiresSdkNormalization: true,
    });
  });

  it('does not manufacture raw factory strictness in the derived view', async () => {
    const fixture = await coalescedPagesFixture({ strict: false });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow('strictness');
  });

  it('does not conceal an effectful initializer in a shared namespace declaration', async () => {
    const fixture = await coalescedPagesFixture({ groupEffect: true });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow(
      'effectful namespace sibling',
    );
  });

  it('rejects additional same-factory cache reads even when ordinary ownership accepts them', async () => {
    const fixture = await coalescedPagesFixture({
      afterRead: 'const another=runtimeContext.r(42);',
    });

    await expect(proveNodeManifestTurbopackConsumers(fixture.input)).rejects.toThrow(
      'unique namespace read',
    );
  });
});
