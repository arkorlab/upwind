import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  manifestConstructorImport,
  reviewedRouteConstructorSource,
} from '../src/node-manifest-framework.ts';

const PROFILES = [
  {
    kind: 'pages',
    module: 'dist/server/route-modules/pages/module.compiled.js',
    relative: 'dist/server/route-modules/pages/module.compiled.js',
    sha256: 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f',
  },
  {
    kind: 'pages',
    module: 'dist/server/route-modules/pages/module.compiled.js',
    relative: 'dist/compiled/next-server/pages.runtime.prod.js',
    sha256: '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
  },
  {
    kind: 'pages',
    module: 'dist/server/route-modules/pages/module.compiled.js',
    relative: 'dist/compiled/next-server/pages-turbo.runtime.prod.js',
    sha256: '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1',
  },
  {
    kind: 'pages-api',
    module: 'dist/server/route-modules/pages-api/module.compiled.js',
    relative: 'dist/server/route-modules/pages-api/module.compiled.js',
    sha256: '0203c76f81559286e5c80c7ef070fe7ceb325a0a7f13528e44e6b6acec208d36',
  },
  {
    kind: 'pages-api',
    module: 'dist/server/route-modules/pages-api/module.compiled.js',
    relative: 'dist/compiled/next-server/pages-api.runtime.prod.js',
    sha256: '322a597b07fdc559b86562fd68f1c828b554deac36e1e84a10e6687daa01a00f',
  },
  {
    kind: 'pages-api',
    module: 'dist/server/route-modules/pages-api/module.compiled.js',
    relative: 'dist/compiled/next-server/pages-api-turbo.runtime.prod.js',
    sha256: '9bda335900891fa996b194d830883cb833a869a86e59f33ec7c80cf018309424',
  },
  {
    kind: 'app-route',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    relative: 'dist/server/route-modules/app-route/module.compiled.js',
    sha256: 'aeab4882c08e62a742aa67daa0d4a434b3330f389c38ffdf4262b6143c80b5ed',
  },
  {
    kind: 'app-route',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    relative: 'dist/compiled/next-server/app-route.runtime.prod.js',
    sha256: 'ff6aea920fbe3a9a4cf4179b0bc80bf20127136754cd9225586edb77f96dc254',
  },
  {
    kind: 'app-route',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    relative: 'dist/compiled/next-server/app-route-turbo.runtime.prod.js',
    sha256: '4010a14b45b58154eaf01034845c5003de0f7c3945657e9d84290fe66ea3d41c',
  },
  {
    kind: 'app-route',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    relative: 'dist/compiled/next-server/app-route-experimental.runtime.prod.js',
    sha256: '356d9c9be870fac47a341221841c76341c37a17eb038d6151e22a0788f87a906',
  },
  {
    kind: 'app-route',
    module: 'dist/server/route-modules/app-route/module.compiled.js',
    relative: 'dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js',
    sha256: '4755bc19f3115dc66c2e818cf7cee5c0979a6821a5fec9513beb808cebe8a0bc',
  },
] as const;

describe('fixed constructor namespace identities', () => {
  it.each(PROFILES)(
    'binds $relative to its exact published namespace and canonical role',
    async ({ kind, module, relative, sha256 }) => {
      const file = await realpath(fileURLToPath(import.meta.resolve(`next/${relative}`)));
      const code = await readFile(file);
      const evaluator = await realpath(
        fileURLToPath(import.meta.resolve('next/dist/server/load-manifest.external.js')),
      );
      const root = path.resolve(path.dirname(evaluator), '../..');
      const identity = reviewedRouteConstructorSource(relative, sha256);

      expect(createHash('sha256').update(code).digest('hex')).toBe(sha256);
      expect(identity).toStrictEqual({ kind, module, relative });
      expect(manifestConstructorImport(file, sha256)).toStrictEqual({
        kind,
        module,
        relative,
        root,
      });
      expect(Object.isFrozen(identity)).toBe(true);
    },
  );

  it.each(PROFILES)('rejects changed bytes at $relative', ({ relative }) => {
    expect(reviewedRouteConstructorSource(relative, 'a'.repeat(64))).toBeUndefined();
    expect(
      manifestConstructorImport(`/project/node_modules/next/${relative}`, 'a'.repeat(64)),
    ).toBeUndefined();
  });

  it.each([
    [
      'AppPage class',
      'dist/compiled/next-server/app-page.runtime.prod.js',
      '9f24cd66e38f57c3144cbc456fe0f52853836d6218f449f54abba8e8c17c3921',
    ],
    [
      'development runtime',
      'dist/compiled/next-server/pages.runtime.dev.js',
      '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
    ],
    [
      'source class',
      'dist/server/route-modules/pages/module.js',
      'fc0ccc89c288c9426a39ae38af43e96bd14958e8a37ab79de2bca31a893dd29a',
    ],
    [
      'unknown namespace',
      'dist/compiled/next-server/foreign.runtime.prod.js',
      '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
    ],
  ])('keeps %s outside constructor alias approval', (_name, relative, sha256) => {
    expect(reviewedRouteConstructorSource(relative, sha256)).toBeUndefined();
    expect(
      manifestConstructorImport(`/project/node_modules/next/${relative}`, sha256),
    ).toBeUndefined();
  });

  it('does not borrow a known hash for a foreign path or a different constructor family', () => {
    const pages = PROFILES[1];
    const api = PROFILES[4];

    expect(manifestConstructorImport('/project/customer-runtime.js', pages.sha256)).toBeUndefined();
    expect(reviewedRouteConstructorSource(api.relative, pages.sha256)).toBeUndefined();
  });
});
