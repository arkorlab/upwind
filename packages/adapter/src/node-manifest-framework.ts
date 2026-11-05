import { isReleasePath, isReleaseSource } from './node-next-release.ts';

export const ROUTE_CLASS = 'route-class';
export const APP_PAGE_CLASS = 'app-page-class';
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
const RUNTIME = 'dist/compiled/next-server/';
const PAGES_RUNTIME_PATHS = [
  `${RUNTIME}pages-turbo.runtime.prod.js`,
  `${RUNTIME}pages.runtime.prod.js`,
];
const PAGES_API_RUNTIME_PATHS = [
  `${RUNTIME}pages-api-turbo.runtime.prod.js`,
  `${RUNTIME}pages-api.runtime.prod.js`,
];
const ROUTE_RUNTIME_PATHS = [
  `${RUNTIME}app-route-experimental.runtime.prod.js`,
  `${RUNTIME}app-route-turbo-experimental.runtime.prod.js`,
  `${RUNTIME}app-route-turbo.runtime.prod.js`,
  `${RUNTIME}app-route.runtime.prod.js`,
];
const APP_RUNTIME_PATHS = [
  `${RUNTIME}app-page-experimental.runtime.prod.js`,
  `${RUNTIME}app-page-turbo-experimental.runtime.prod.js`,
  `${RUNTIME}app-page-turbo.runtime.prod.js`,
  `${RUNTIME}app-page.runtime.prod.js`,
];
const PAGES_RUNTIMES: ReadonlySet<string> = new Set(PAGES_RUNTIME_PATHS);
const PAGES_API_RUNTIMES: ReadonlySet<string> = new Set(PAGES_API_RUNTIME_PATHS);
const ROUTE_RUNTIMES: ReadonlySet<string> = new Set(ROUTE_RUNTIME_PATHS);
const APP_RUNTIMES: ReadonlySet<string> = new Set(APP_RUNTIME_PATHS);
export const EVALUATOR = 'dist/server/load-manifest.external.js';
const LOAD_COMPONENTS = 'dist/server/load-components.js';
/**
 * Exact published sources, the same bytes in next@16.4.3 and next@16.4.4, from their
 * integrity-verified registry packages. The factory template and the runtimes differ between them
 * (`node-next-release.ts`).
 */
const REVIEWED: ReadonlyMap<string, string> = new Map([
  [APP_PAGE_MODULE, '3b55f56f8c70bbadffdacea23a1c19689c3889bab7e78da6c8121ada787bfe99'],
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
  | typeof APP_PAGE_CLASS
  | typeof APP_PAGE_FACTORY
  | typeof ROUTE_EXPORTS;

const RUNTIME_WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [APP_PAGE_MODULE, APP_RUNTIMES],
  [APP_ROUTE_MODULE, ROUTE_RUNTIMES],
  [PAGES_API_MODULE, PAGES_API_RUNTIMES],
  [PAGES_MODULE, PAGES_RUNTIMES],
]);

// eslint-disable-next-line unicorn/prefer-iterator-concat -- The supported Node.js 24 runtime does not provide Iterator.concat.
const RUNTIMES: ReadonlySet<string> = new Set([
  ...APP_RUNTIME_PATHS,
  ...PAGES_RUNTIME_PATHS,
  ...PAGES_API_RUNTIME_PATHS,
  ...ROUTE_RUNTIME_PATHS,
]);
const FRAMEWORK_TRANSITIONS: ReadonlyMap<
  string,
  ReadonlyMap<string, ManifestProtectedKind>
> = new Map([
  [APP_PAGE_MODULE, new Map<string, ManifestProtectedKind>([[APP_PAGE_RUNTIME, APP_PAGE_FACTORY]])],
  [APP_PAGE_SOURCE, new Map<string, ManifestProtectedKind>([[APP_PAGE_MODULE, APP_PAGE_CLASS]])],
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
      [APP_PAGE_SOURCE, APP_PAGE_CLASS],
      [APP_ROUTE_SOURCE, ROUTE_CLASS],
      [PAGES_API_SOURCE, ROUTE_CLASS],
      [PAGES_SOURCE, ROUTE_CLASS],
    ]),
  ],
]);

export function frameworkParent(parent: string, child: string): ManifestProtectedKind | undefined {
  if (child === EVALUATOR && APP_RUNTIMES.has(parent)) return APP_PAGE_CLASS;
  if (parent === APP_PAGE_MODULE && APP_RUNTIMES.has(child)) return APP_PAGE_CLASS;
  // Resolution may select the production namespace directly instead of retaining its wrapper.
  // Only the separately hash-checked, fixed template factory may consume this class authority.
  if (parent === APP_PAGE_RUNTIME && APP_RUNTIMES.has(child)) return APP_PAGE_FACTORY;
  if (child === EVALUATOR && RUNTIMES.has(parent)) return ROUTE_CLASS;
  if (RUNTIME_WRAPPERS.get(parent)?.has(child) === true) return ROUTE_CLASS;
  return FRAMEWORK_TRANSITIONS.get(child)?.get(parent);
}

/** Whether `sha256` is the published bytes of the reviewed `relative` in a supported release. */
export function isReviewedFrameworkSource(relative: string, sha256: string): boolean {
  return REVIEWED.get(relative) === sha256 || isReleaseSource(relative, sha256);
}

/** Whether `relative` names a reviewed source of a supported release. */
export function isReviewedFrameworkPath(relative: string): boolean {
  return REVIEWED.has(relative) || isReleasePath(relative);
}

export interface ManifestConstructorIdentity {
  readonly kind: 'pages' | 'pages-api' | 'app-route';
  /** Canonical wrapper namespace exported by the exact selected runtime. */
  readonly module: string;
  /** Actual reviewed physical source suffix, never replaced with the canonical wrapper path. */
  readonly relative: string;
}

const ROUTE_CONSTRUCTORS = [
  { kind: 'pages', module: PAGES_MODULE, runtimes: PAGES_RUNTIMES },
  { kind: 'pages-api', module: PAGES_API_MODULE, runtimes: PAGES_API_RUNTIMES },
  { kind: 'app-route', module: APP_ROUTE_MODULE, runtimes: ROUTE_RUNTIMES },
] as const;

/** The pinned wrappers directly export these selected, pinned production namespaces. */
export function reviewedRouteConstructorSource(
  relative: string,
  sha256: string,
): ManifestConstructorIdentity | undefined {
  for (const profile of ROUTE_CONSTRUCTORS) {
    const reviewed =
      relative === profile.module
        ? REVIEWED.get(profile.module) === sha256
        : profile.runtimes.has(relative) && isReleaseSource(relative, sha256);
    if (reviewed) return Object.freeze({ kind: profile.kind, module: profile.module, relative });
  }
  return undefined;
}

export function manifestConstructorImport(
  file: string,
  sha256: string,
): (ManifestConstructorIdentity & { readonly root: string }) | undefined {
  const normalized = file.replaceAll('\\', '/');
  for (const profile of ROUTE_CONSTRUCTORS) {
    const candidates = [profile.module, ...profile.runtimes];
    for (const relative of candidates) {
      if (!normalized.endsWith(`/${relative}`)) continue;
      const identity = reviewedRouteConstructorSource(relative, sha256);
      if (identity === undefined) return undefined;
      return Object.freeze({ ...identity, root: normalized.slice(0, -relative.length - 1) || '/' });
    }
  }
  return undefined;
}
