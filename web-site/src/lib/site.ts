/**
 * The facts of this site that are the same in every language: where it is served from, and what it
 * points at.
 *
 * The origin is written out rather than read from the environment. There is one deployment of this
 * site and one name for it, and a canonical URL assembled from a variable is a canonical URL that
 * can be wrong in an environment nobody checked. `www` is the name: the apex redirects to it, so
 * every absolute URL this site emits — canonical, hreflang, the sitemap, the Open Graph card —
 * names the host a visitor ends up on.
 */
export const SITE_URL = 'https://www.stayingupwind.com';

export const REPOSITORY_URL = 'https://github.com/arkorlab/upwind';
export const ISSUES_URL = `${REPOSITORY_URL}/issues`;
export const CONTRIBUTING_URL = `${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`;
export const LICENSE_MIT_URL = `${REPOSITORY_URL}/blob/main/LICENSE-MIT`;
export const LICENSE_APACHE_URL = `${REPOSITORY_URL}/blob/main/LICENSE-APACHE`;
/**
 * Where "npm" in the header and the footer goes.
 *
 * The CLI's own page, not the scope's: `npmjs.com/org/<scope>` and `npmjs.com/~<user>` are different
 * addresses depending on how the scope was registered, and a package page is the one that cannot be
 * the wrong guess. Each package in the table below links to its own anyway.
 */
export const NPM_URL = 'https://www.npmjs.com/package/upwind';

/** What the hero tells a reader to run, and the one command this site asks anybody to trust. */
export const CREATE_COMMAND = 'pnpm create upwind';

/**
 * The Next.js a reader can run this on.
 *
 * **The published adapter's range, not the repository's.** This page is read by somebody about to
 * run `pnpm create upwind`, and what they install is the release — so the number that matters is
 * `peerDependencies.next` of the `@stayingupwind/adapter` in this project's own lockfile, which is
 * the version that serves this very site. The working tree can already support a Next.js the
 * registry does not: naming that one here would send a reader to a version the package they install
 * refuses to build with.
 *
 * It is a copy, because the adapter's `exports` does not offer its `package.json` to be read. The
 * thing to check it against is one directory away — `web-site/pnpm-lock.yaml`, under
 * `@stayingupwind/adapter` — so a bump that moves the range moves it in the same diff as this line.
 */
export const SUPPORTED_NEXT_RANGE = '>=16.3.0 <17';

/** The npm scope the scoped libraries share; `upwind` and `create-upwind` sit outside it. */
const SCOPE = '@stayingupwind';

/**
 * The packages a reader can install, in the order they meet them: the command you run, the thing
 * that builds, the thing that serves, the vocabulary underneath, what an application reads its own
 * storage through, and the scaffolder.
 *
 * **This list follows the registry, not `packages/`.** The repository can hold a package that has
 * not shipped yet — every row here is a link to npm, and a link to a version nobody can install is
 * a 404 on the day this site deploys, which is the day the change lands rather than the day it is
 * released. A release that publishes a new package adds its row here, and nothing else: no sentence
 * in `content/` counts these, so the list is the only place that knows how many there are.
 *
 * Each row's prose is the dictionary's (`content/`), because it is the only part of a row that is
 * written in a language. The names and the links are here.
 */
export const PACKAGES = [
  { id: 'upwind', name: 'upwind', directory: 'packages/upwind' },
  { id: 'adapter', name: `${SCOPE}/adapter`, directory: 'packages/adapter' },
  { id: 'runtime', name: `${SCOPE}/runtime`, directory: 'packages/runtime' },
  { id: 'core', name: `${SCOPE}/core`, directory: 'packages/core' },
  { id: 'sdk', name: `${SCOPE}/sdk`, directory: 'packages/sdk' },
  { id: 'create', name: 'create-upwind', directory: 'packages/create-upwind' },
] as const;

export type PackageId = (typeof PACKAGES)[number]['id'];

export function npmUrl(name: string): string {
  return `https://www.npmjs.com/package/${name}`;
}

export function readmeUrl(directory: string): string {
  return `${REPOSITORY_URL}/tree/main/${directory}`;
}
