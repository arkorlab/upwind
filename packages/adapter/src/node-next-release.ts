import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** A published Next.js release whose native sources the SDK qualifies, by their exact bytes. */
export interface NativeNextRelease {
  readonly version: '16.4.3' | '16.4.4';
  /** The published `package.json`, by its exact bytes. */
  readonly packageJsonSha256: string;
  /**
   * The reviewed sources that differ between the releases, by path. Every other reviewed source is
   * the same published bytes in each (`node-manifest-framework.ts`).
   */
  readonly sources: ReadonlyMap<string, string>;
}

const MAX_PACKAGE_BYTES = 65_536;
const APP_PAGE_RUNTIME = 'dist/build/templates/app-page-runtime.js';
const RUNTIME = 'dist/compiled/next-server/';

/** Each release's sources, in one order: the factory template, then the twelve runtimes. */
const PATHS = [
  APP_PAGE_RUNTIME,
  `${RUNTIME}app-page-experimental.runtime.prod.js`,
  `${RUNTIME}app-page-turbo-experimental.runtime.prod.js`,
  `${RUNTIME}app-page-turbo.runtime.prod.js`,
  `${RUNTIME}app-page.runtime.prod.js`,
  `${RUNTIME}pages-turbo.runtime.prod.js`,
  `${RUNTIME}pages.runtime.prod.js`,
  `${RUNTIME}pages-api-turbo.runtime.prod.js`,
  `${RUNTIME}pages-api.runtime.prod.js`,
  `${RUNTIME}app-route-experimental.runtime.prod.js`,
  `${RUNTIME}app-route-turbo-experimental.runtime.prod.js`,
  `${RUNTIME}app-route-turbo.runtime.prod.js`,
  `${RUNTIME}app-route.runtime.prod.js`,
] as const;

function defineRelease(
  version: NativeNextRelease['version'],
  packageJsonSha256: string,
  sources: readonly string[],
): NativeNextRelease {
  if (sources.length !== PATHS.length) throw new TypeError(`Incomplete Next.js ${version} sources`);
  return Object.freeze({
    version,
    packageJsonSha256,
    sources: new Map(PATHS.map((relative, index) => [relative, sources[index] ?? ''])),
  });
}

// Exact published next@16.4.3 and next@16.4.4 sources, from their integrity-verified registry packages.
export const NATIVE_NEXT_RELEASES: readonly NativeNextRelease[] = Object.freeze([
  defineRelease('16.4.3', 'b67bad7944d603b27dd2d2719b57203fd3b3e5c147b2efa6dea5ceb135274caf', [
    '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b',
    '2974a9e688b53a8b9bf61ea8535f1b70f4fb4154fc60c64a231d337f556d99c7',
    'd0d80c2b545d96bfdebb2a3d5100c368a18a0757db211eba55abf977e37ee23f',
    '914353e0cf478e617e8a3b408fa74d9f526e9c338c8bda817cc05f05bfcce7a5',
    '9f24cd66e38f57c3144cbc456fe0f52853836d6218f449f54abba8e8c17c3921',
    '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1',
    '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98',
    '9bda335900891fa996b194d830883cb833a869a86e59f33ec7c80cf018309424',
    '322a597b07fdc559b86562fd68f1c828b554deac36e1e84a10e6687daa01a00f',
    '356d9c9be870fac47a341221841c76341c37a17eb038d6151e22a0788f87a906',
    '4755bc19f3115dc66c2e818cf7cee5c0979a6821a5fec9513beb808cebe8a0bc',
    '4010a14b45b58154eaf01034845c5003de0f7c3945657e9d84290fe66ea3d41c',
    'ff6aea920fbe3a9a4cf4179b0bc80bf20127136754cd9225586edb77f96dc254',
  ]),
  defineRelease('16.4.4', '30706a767e4f0c93dd18f073d4856641c2f9d135cbb182ee232c553e4c7c323d', [
    '5c33bd724b1310148a0e128351c877b987ea91893cd77750d072322df90a4150',
    'f0927c6bd58e33907c7574979516f3fdf12e047412c334b9b88c0d7cc0f34b32',
    '999a2f4623c0e9f23ba925f9ed51d9a37bf860fa1bf7229112ceb75d8787d549',
    '244c3d5778a3009aa96bd87590acecf356cf6df71155cdb92b67057dfcbed299',
    'b0640fff1e7bfd7b6cb2452cd65f58020fb1b5e0fc4e70508ac2b8ef0fd2014f',
    'c942ce0e1225d5173eb2c42dd9958727ae30c6a0e522b0ca939a2f9576c30f39',
    '0adbf685547722a714dd900f2981897f841d424024202d91e6931a54e98110d7',
    '4fbed6b321caa34a790fd6ee671a3ba8135d97dc8f49181f34c3c648f6124b6b',
    '8d0dd3380764b15950850af06f229d666471e0c92cb31960d45c9be4e0d750c9',
    'b0f88dacfa8f35841e4cc80faf8cee94716da591e31a68e0159b3b61db4d4723',
    '071075f8dec3ceeee13700b11accd19f93503c5ede4e052a4a25324a220000ad',
    'f85e8b56387771d0e9833ef879a2f5f38fd19ba4a1bfc5e8e3d8c68f8d9f769d',
    '5487d86709ea8de206e57dad2dca618008b436b3c0027f821382d51daee72704',
  ]),
]);

/** The release a `package.json` is, by its exact bytes and the version it names. */
export function nativeNextReleaseOf(
  packageJsonSha256: string,
  version: unknown,
): NativeNextRelease | undefined {
  return NATIVE_NEXT_RELEASES.find(
    (candidate) =>
      candidate.packageJsonSha256 === packageJsonSha256 && candidate.version === version,
  );
}

/** The supported release a `package.json` names, by its version alone. */
export function nativeNextReleaseNamed(version: unknown): NativeNextRelease | undefined {
  return NATIVE_NEXT_RELEASES.find((candidate) => candidate.version === version);
}

/** Whether `sha256` is the published bytes of a release-dependent `relative` in some release. */
export function isReleaseSource(relative: string, sha256: string): boolean {
  return NATIVE_NEXT_RELEASES.some((candidate) => candidate.sources.get(relative) === sha256);
}

/** Whether `sha256` is another release's bytes of `relative`, not those of `release`. */
export function isForeignReleaseSource(
  release: NativeNextRelease,
  relative: string,
  sha256: string,
): boolean {
  return release.sources.get(relative) !== sha256 && isReleaseSource(relative, sha256);
}

/** Whether `relative` names a source whose reviewed bytes depend on the release. */
export function isReleasePath(relative: string): boolean {
  return (PATHS as readonly string[]).includes(relative);
}

const RELEASE_AT = new Map<string, { readonly key: string; readonly release: NativeNextRelease }>();

/**
 * The release of the `next` package at `root`, from its `package.json`, or undefined where that is
 * no supported release. Read once for each unchanged file; a build reads the same package often.
 */
export function nativeNextReleaseAt(root: string): NativeNextRelease | undefined {
  const file = path.join(root, 'package.json');
  let key: string;
  try {
    const info = statSync(file, { bigint: true });
    if (!info.isFile() || info.size > MAX_PACKAGE_BYTES) return undefined;
    key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
  } catch {
    return undefined;
  }
  const known = RELEASE_AT.get(file);
  if (known?.key === key) return known.release;
  const bytes = readFileSync(file);
  let metadata: unknown;
  try {
    metadata = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof metadata !== 'object' || metadata === null || !('name' in metadata)) return undefined;
  if (metadata.name !== 'next' || !('version' in metadata)) return undefined;
  const found = nativeNextReleaseOf(
    createHash('sha256').update(bytes).digest('hex'),
    metadata.version,
  );
  if (found !== undefined) RELEASE_AT.set(file, { key, release: found });
  return found;
}
