export const ROUTE_CLASS = 'route-class';
export const APP_PAGE_FACTORY = 'app-page-factory';
export const ROUTE_EXPORTS = 'route-exports';
const APP_PAGE_RUNTIME = 'dist/build/templates/app-page-runtime.js';
const APP_PAGE_MODULE = 'dist/server/route-modules/app-page/module.compiled.js';
const APP_PAGE_SOURCE = 'dist/server/route-modules/app-page/module.js';
const ROUTE_MODULE = 'dist/server/route-modules/route-module.js';
export const PAGES_MODULE = 'dist/server/route-modules/pages/module.compiled.js';
const PAGES_SOURCE = 'dist/server/route-modules/pages/module.js';
export const PAGES_API_MODULE = 'dist/server/route-modules/pages-api/module.compiled.js';
const PAGES_API_SOURCE = 'dist/server/route-modules/pages-api/module.js';
export const APP_ROUTE_MODULE = 'dist/server/route-modules/app-route/module.compiled.js';
const APP_ROUTE_SOURCE = 'dist/server/route-modules/app-route/module.js';
const PAGES_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/pages-turbo.runtime.prod.js',
    '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1',
  ],
  [
    'dist/compiled/next-server/pages.runtime.prod.js',
    '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
  ],
]);
const PAGES_API_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/pages-api-turbo.runtime.prod.js',
    '9bda335900891fa996b194d830883cb833a869a86e59f33ec7c80cf018309424',
  ],
  [
    'dist/compiled/next-server/pages-api.runtime.prod.js',
    '322a597b07fdc559b86562fd68f1c828b554deac36e1e84a10e6687daa01a00f',
  ],
]);
const ROUTE_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/app-route-experimental.runtime.prod.js',
    '356d9c9be870fac47a341221841c76341c37a17eb038d6151e22a0788f87a906',
  ],
  [
    'dist/compiled/next-server/app-route-turbo-experimental.runtime.prod.js',
    '4755bc19f3115dc66c2e818cf7cee5c0979a6821a5fec9513beb808cebe8a0bc',
  ],
  [
    'dist/compiled/next-server/app-route-turbo.runtime.prod.js',
    '4010a14b45b58154eaf01034845c5003de0f7c3945657e9d84290fe66ea3d41c',
  ],
  [
    'dist/compiled/next-server/app-route.runtime.prod.js',
    'ff6aea920fbe3a9a4cf4179b0bc80bf20127136754cd9225586edb77f96dc254',
  ],
]);
export const EVALUATOR = 'dist/server/load-manifest.external.js';
const LOAD_COMPONENTS = 'dist/server/load-components.js';
const APP_RUNTIMES: ReadonlyMap<string, string> = new Map([
  [
    'dist/compiled/next-server/app-page-experimental.runtime.prod.js',
    '2974a9e688b53a8b9bf61ea8535f1b70f4fb4154fc60c64a231d337f556d99c7',
  ],
  [
    'dist/compiled/next-server/app-page-turbo-experimental.runtime.prod.js',
    'd0d80c2b545d96bfdebb2a3d5100c368a18a0757db211eba55abf977e37ee23f',
  ],
  [
    'dist/compiled/next-server/app-page-turbo.runtime.prod.js',
    '914353e0cf478e617e8a3b408fa74d9f526e9c338c8bda817cc05f05bfcce7a5',
  ],
  [
    'dist/compiled/next-server/app-page.runtime.prod.js',
    '9f24cd66e38f57c3144cbc456fe0f52853836d6218f449f54abba8e8c17c3921',
  ],
]);
// Exact published next@16.4.3 sources, from its integrity-verified registry package.
const REVIEWED: ReadonlyMap<string, string> = new Map([
  ...APP_RUNTIMES,
  ...PAGES_RUNTIMES,
  ...PAGES_API_RUNTIMES,
  ...ROUTE_RUNTIMES,
  [APP_PAGE_MODULE, '3b55f56f8c70bbadffdacea23a1c19689c3889bab7e78da6c8121ada787bfe99'],
  [APP_PAGE_RUNTIME, '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b'],
  [APP_PAGE_SOURCE, '0d658c55994938d4ffe32bbddb4e6009513248e1659e90e248d33bf3a98e0eed'],
  [APP_ROUTE_MODULE, 'aeab4882c08e62a742aa67daa0d4a434b3330f389c38ffdf4262b6143c80b5ed'],
  [APP_ROUTE_SOURCE, '9f9ae9defd45e773888c948e844d7a401ca79ff5c09f14211c4abd9b725e3b1b'],
  [LOAD_COMPONENTS, '47e1446da77172ba77d6f3e6f68ae00ca7bebda206b26c0ba8625d41915dcaed'],
  [PAGES_API_MODULE, '0203c76f81559286e5c80c7ef070fe7ceb325a0a7f13528e44e6b6acec208d36'],
  [PAGES_API_SOURCE, '9e1e4f6076e2d020ffa91fa79dbd2ca8e4788ffb5294df0c67f27bc90da2f3f8'],
  [PAGES_MODULE, 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f'],
  [PAGES_SOURCE, 'fc0ccc89c288c9426a39ae38af43e96bd14958e8a37ab79de2bca31a893dd29a'],
  [ROUTE_MODULE, '2f1de319c06e89b9adda0365a655e8fc6b23ec0fa424a0ea9d513b6d814a1865'],
]);
export type ManifestProtectedKind =
  | 'evaluator'
  | typeof ROUTE_CLASS
  | typeof APP_PAGE_FACTORY
  | typeof ROUTE_EXPORTS;

const RUNTIME_WRAPPERS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [APP_PAGE_MODULE, APP_RUNTIMES],
  [APP_ROUTE_MODULE, ROUTE_RUNTIMES],
  [PAGES_API_MODULE, PAGES_API_RUNTIMES],
  [PAGES_MODULE, PAGES_RUNTIMES],
]);
const RUNTIMES = new Set([
  ...APP_RUNTIMES.keys(),
  ...PAGES_RUNTIMES.keys(),
  ...PAGES_API_RUNTIMES.keys(),
  ...ROUTE_RUNTIMES.keys(),
]);
const FRAMEWORK_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlyMap<string, ManifestProtectedKind>
> = new Map([
  [APP_PAGE_MODULE, new Map<string, ManifestProtectedKind>([[APP_PAGE_RUNTIME, APP_PAGE_FACTORY]])],
  [APP_PAGE_SOURCE, new Map<string, ManifestProtectedKind>([[APP_PAGE_MODULE, ROUTE_CLASS]])],
  [APP_ROUTE_SOURCE, new Map<string, ManifestProtectedKind>([[APP_ROUTE_MODULE, ROUTE_CLASS]])],
  [
    EVALUATOR,
    new Map<string, ManifestProtectedKind>([
      [LOAD_COMPONENTS, 'evaluator'],
      [ROUTE_MODULE, ROUTE_CLASS],
    ]),
  ],
  [PAGES_API_SOURCE, new Map<string, ManifestProtectedKind>([[PAGES_API_MODULE, ROUTE_CLASS]])],
  [PAGES_SOURCE, new Map<string, ManifestProtectedKind>([[PAGES_MODULE, ROUTE_CLASS]])],
  [
    ROUTE_MODULE,
    new Map<string, ManifestProtectedKind>([
      [APP_PAGE_SOURCE, ROUTE_CLASS],
      [APP_ROUTE_SOURCE, ROUTE_CLASS],
      [PAGES_API_SOURCE, ROUTE_CLASS],
      [PAGES_SOURCE, ROUTE_CLASS],
    ]),
  ],
]);

export function frameworkParent(parent: string, child: string): ManifestProtectedKind | undefined {
  if (child === EVALUATOR && RUNTIMES.has(parent)) return ROUTE_CLASS;
  if (RUNTIME_WRAPPERS.get(parent)?.has(child) === true) return ROUTE_CLASS;
  return FRAMEWORK_TRANSITIONS.get(child)?.get(parent);
}

export function reviewedFrameworkSource(relative: string): string | undefined {
  return REVIEWED.get(relative);
}
