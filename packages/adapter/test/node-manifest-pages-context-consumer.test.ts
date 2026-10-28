import { describe, expect, it } from 'vitest';

import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import {
  addContextRoute,
  changeContextGraphSource,
  CONTEXT_CHUNK,
  CONTEXT_ENTRY,
  CONTEXT_RUNTIME,
  CONTEXT_ID,
  ORDINARY_ID,
  pagesContextGraph,
  withForeignContext,
} from './fixtures/node-manifest-pages-context.ts';
import { manifestTemplateSource } from './fixtures/node-manifest-turbopack-template.ts';

describe('pages context leaves inside a complete protected source graph', () => {
  it.each(['r', 'i', 'x'] as const)(
    'closes the actual %s selector without promoting its namespace',
    async (form) => {
      const input = await pagesContextGraph({ form });
      const before = JSON.stringify(input.sources);
      const proof = await proveNodeManifestTurbopackConsumers(input);

      expect(proof.terminals.map((entry) => entry.file)).toStrictEqual([CONTEXT_ENTRY]);
      expect(proof.compilerSources.map((entry) => entry.file)).toStrictEqual([CONTEXT_RUNTIME]);
      expect(proof.files.some((entry) => entry.file === CONTEXT_CHUNK)).toBe(true);
      expect(proof.requiresSdkNormalization).toBe(true);
      expect(JSON.stringify(input.sources)).toBe(before);
      expect(proof.boundStage).toBeUndefined();
    },
  );

  it('follows a typed string namespace forwarder to the same physical producer', async () => {
    const input = await pagesContextGraph({ forwardId: 'pages-producer' });

    await expect(proveNodeManifestTurbopackConsumers(input)).resolves.toMatchObject({
      terminals: [{ file: CONTEXT_ENTRY }],
      compilerSources: [{ file: CONTEXT_RUNTIME }],
    });
  });

  it('does not certify a contexts-only producer with no normalized route terminal', async () => {
    const input = changeContextGraphSource(await pagesContextGraph(), CONTEXT_ENTRY, (code) => {
      return code.replace(
        'module.exports=R.m(1).exports;',
        () => `R.m(${CONTEXT_ID});module.exports=R.m(${ORDINARY_ID}).exports;`,
      );
    });

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'missing protected SDK route terminal',
    );
  });

  it('does not normalize a context-as-route alongside an otherwise genuine Pages terminal', async () => {
    const input = addContextRoute(await pagesContextGraph());

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('Unproved Next.js');
  });

  it('does not borrow the original route terminal for another pinned Pages root', async () => {
    const input = withForeignContext(await pagesContextGraph());

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'missing protected SDK route terminal',
    );
  });

  it.each([
    ['extra effect', 'sideEffect();module.exports='],
    ['alias assignment', 'const escape=module;escape.exports='],
  ])('does not hide %s before the namespace assignment', async (_name, replacement) => {
    const input = changeContextGraphSource(await pagesContextGraph(), CONTEXT_CHUNK, (code) =>
      code.replace('module.exports=ctx.r(51).vendored', () => `${replacement}ctx.r(51).vendored`),
    );

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('Unproved Next.js');
  });

  it.each(['RouterContext()', 'RouterContext.Provider', 'PagesRouteModule'])(
    'does not grant a broader namespace value or call: %s',
    async (selector) => {
      const input = changeContextGraphSource(await pagesContextGraph(), CONTEXT_CHUNK, (code) => {
        return code.replace(
          ".vendored['contexts'].RouterContext;",
          () => `.vendored['contexts'].${selector};`,
        );
      });

      await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow('Unproved Next.js');
    },
  );

  it('requires the actual import target rather than a descriptor with the expected specifier', async () => {
    const input = await pagesContextGraph({ form: 'x' });
    const sources = input.sources.map((record) => {
      return record.file === CONTEXT_CHUNK
        ? {
            ...record,
            imports: record.imports.map((edge) =>
              edge.target === input.producer.id ? { ...edge, target: 'node:path' } : edge,
            ),
          }
        : record;
    });

    await expect(proveNodeManifestTurbopackConsumers({ ...input, sources })).rejects.toThrow(
      'Unproved Next.js',
    );
  });

  it('does not exempt an unknown physical runtime caller', async () => {
    const input = await pagesContextGraph();
    const file = '/project/customer.cjs';
    const sources = [
      ...input.sources,
      {
        id: file,
        file,
        source: manifestTemplateSource('module.exports=require("./runtime.cjs");'),
        imports: [{ specifier: './runtime.cjs', target: CONTEXT_RUNTIME }],
      },
    ];

    await expect(proveNodeManifestTurbopackConsumers({ ...input, sources })).rejects.toThrow(
      'unknown runtime API caller',
    );
  });

  it('does not accept a changed current producer code under its old reviewed SHA', async () => {
    const input = await pagesContextGraph();
    const sources = input.sources.map((record) => {
      return record.id === input.producer.id
        ? { ...record, source: { ...record.source, code: `${record.source.code}\nchanged();` } }
        : record;
    });

    await expect(proveNodeManifestTurbopackConsumers({ ...input, sources })).rejects.toThrow(
      'source identity',
    );
  });
});
