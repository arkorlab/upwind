import { describe, expect, it } from 'vitest';

import { assertNodeManifestTurbopackTemplateConsumer } from '../src/node-manifest-turbopack-templates.ts';
import {
  changeOriginalTemplateFixture,
  manifestTemplateSource,
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

describe('projected fixed Next Pages and AppRoute template bodies', () => {
  it.each(['pages', 'app-route'] as const)(
    'certifies the actual published %s body after real context import/export projection',
    async (kind) => {
      const own = await projectedTemplateFixture(kind);
      const proof = await assertNodeManifestTurbopackTemplateConsumer(own);

      expect([proof.kind, proof.page, proof.pathname]).toStrictEqual([
        kind,
        own.route.page,
        own.route.pathname,
      ]);
      expect(proof.exports).toContain('routeModule');
      expect(proof.exports).toContain('handler');
      expect(proof.requiresRuntimeNormalization).toBe(true);
    },
  );

  it('tracks renamed import namespaces and handler parameters through their actual lexical bindings', async () => {
    const own = await projectedTemplateFixture('pages');
    const code = own.projection.original.code
      .replaceAll('_modulecompiled', 'constructorAlias')
      .replaceAll('_VAR_USERLAND', 'customerNamespace')
      .replaceAll(/\bctx\b/gu, 'requestContext');
    const renamed = reprojectTemplateFixture(own, code);

    await expect(assertNodeManifestTurbopackTemplateConsumer(renamed)).resolves.toMatchObject({
      kind: 'pages',
      pathname: '/blog/[slug]',
      requiresRuntimeNormalization: true,
    });
  });

  it.each([
    ['page', "page: '/blog/[slug]'", "page: '/other'"],
    [
      'constructor reassignment',
      'const routeModule =',
      '_modulecompiled = userInput;\nconst routeModule =',
    ],
    [
      'manifest caller',
      'const handler =',
      "routeModule.loadManifests('/unowned', '/elsewhere');\nconst handler =",
    ],
    ['changed handler field', 'srcPage:', 'otherPage:'],
  ])(
    'refuses a %s change instead of alpha-normalizing business code',
    async (_name, before, after) => {
      const own = await projectedTemplateFixture('pages');
      const changed = changeOriginalTemplateFixture(own, before, after);

      await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
        'Unproved Next.js',
      );
    },
  );

  it('rejects extra protected selectors and a factory that leaks a bound runtime loader', async () => {
    const own = await projectedTemplateFixture('pages');
    const escaped = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace(
        'runtimeContext.s([',
        'runtimeContext.s(["constructor",()=>_modulecompiled.PagesRouteModule,',
      ),
    );
    const bound = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace(
        'const routeModule =',
        'const escaped = {require:runtimeContext.r.bind(runtimeContext)};\nconst routeModule =',
      ),
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(escaped)).rejects.toThrow(
      'changed protected export selector',
    );
    await expect(assertNodeManifestTurbopackTemplateConsumer(bound)).rejects.toThrow(
      'unmodeled bound runtime input',
    );
  });

  it('does not accept an inert projection edited after the original factory was verified', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = {
      ...own,
      projection: {
        ...own.projection,
        source: manifestTemplateSource(`${own.projection.source.code}\nexports.extra=routeModule;`),
      },
    };

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'projection provenance',
    );
  });

  it('requires strictness from the real factory ancestry rather than assuming the template label proves it', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace('"use strict";', ''),
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'unproved factory strictness',
    );
  });
});
