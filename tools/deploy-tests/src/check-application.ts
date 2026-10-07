import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The application `check.ts` deploys: one that builds without Next.js and writes a bundle as the
 * adapter would, so that the hooks are checked without a Next.js build.
 */

const REPO = path.join(import.meta.dirname, '..', '..', '..');
/** The build id the bundle says, which is the one the suite must be told. */
export const BUNDLE_BUILD_ID = 'from-the-bundle';
/** The build id `.next/BUILD_ID` says, which is not. */
export const OUTPUT_DIRECTORY_BUILD_ID = 'from-the-output-directory';

/**
 * An application that builds without Next.js, and lies about its build id on purpose.
 *
 * `.next/BUILD_ID` says one thing and the bundle says another, so that reading the wrong one is a
 * failure here rather than a fixture whose build id the suite silently gets wrong. Which is which
 * arrives in the environment rather than in this text, so that the text stays a file and not a
 * template.
 */
const BUILD_SCRIPT = String.raw`
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const saw = (name) => name + ': ' + (process.env[name] === undefined ? 'no' : 'YES');
console.log('the build saw ' + saw('ARKOR_API_TOKEN') + ' ' + saw('ARKOR_API_TOKEN_FILE'));
console.log('the build saw ' + saw('__NEXT_NODE_NATIVE_TS_LOADER_ENABLED'));
console.log(
  'the build saw types transformed: ' +
    ((process.env.NODE_OPTIONS ?? '').includes('--experimental-transform-types') ? 'YES' : 'no'),
);

mkdirSync('.next', { recursive: true });
writeFileSync('.next/BUILD_ID', process.env.CHECK_OUTPUT_DIRECTORY_BUILD_ID);

const bytes = Buffer.from('a function\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
mkdirSync('.arkor/blobs', { recursive: true });
writeFileSync('.arkor/blobs/' + sha256, bytes);
writeFileSync(
  '.arkor/bundle.json',
  JSON.stringify({
    v: 1,
    deploymentId: process.env.NEXT_DEPLOYMENT_ID,
    nextVersion: '16.3.6',
    buildId: process.env.CHECK_BUNDLE_BUILD_ID,
    projectDir: '.',
    generatedAt: new Date().toISOString(),
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: false,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: false,
      rsc: {
        header: 'RSC',
        varyHeader: 'RSC',
        prefetchHeader: 'Next-Router-Prefetch',
        didPostponeHeader: 'x-nextjs-postponed',
        contentTypeHeader: 'text/x-component',
        suffix: '.rsc',
        prefetchSegmentHeader: 'Next-Router-Segment-Prefetch',
        prefetchSegmentSuffix: '.segment.rsc',
        prefetchSegmentDirSuffix: '.segments',
      },
    },
    entrypoints: [],
    prerenders: [],
    staticFiles: [
      // First, so that it is the file the host serves and the one the probe prefers: a path carrying the
      // build id is as strong as a file gets, and still not proof of whose deployment answered — the
      // check's page assertions are what hold the probe to asking the page all the same.
      {
        pathname: '/_next/static/' + process.env.CHECK_BUNDLE_BUILD_ID + '/chunk.js',
        blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
        immutable: false,
      },
      {
        pathname: '/_next/static/immutable/' + sha256 + '.js',
        blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
        immutable: true,
      },
    ],
    functions: {
      app: {
        mainModule: 'index.mjs',
        modules: [
          {
            name: 'index.mjs',
            type: 'esm',
            blob: { sha256, byteLength: bytes.byteLength, contentType: 'text/javascript' },
          },
        ],
        compatibilityDate: '2026-09-15',
        compatibilityFlags: [],
      },
    },
  }),
);
`;

/**
 * Its `build` is shaped like the one the suite's harness writes (`… && pnpm post-build`), and its
 * `post-build` is its own — which is the case that must not be dropped.
 */
const MANIFEST = {
  name: 'deploy-tests-check-application',
  private: true,
  scripts: {
    build: 'node build.mjs && pnpm post-build',
    'post-build':
      "node -e \"console.log('the fixture post-build ran; it saw ARKOR_API_TOKEN: ' + (process.env.ARKOR_API_TOKEN === undefined ? 'no' : 'YES'))\"",
  },
};

export function writeApplication(appDir: string): void {
  mkdirSync(path.join(appDir, 'node_modules'), { recursive: true });
  writeFileSync(path.join(appDir, 'build.mjs'), BUILD_SCRIPT);
  // Its own value, for `@next/env` to read and the deployment's environment to be replaced with.
  writeFileSync(path.join(appDir, '.env'), 'OWN=yes\n');
  writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(MANIFEST, null, 2)}\n`);
  // A fixture arrives with its own `next`, which is where `@next/env` is resolved from. This one is
  // given the adapter's, linked: that package depends on Next.js and this one deliberately does not,
  // and what is under test here is the reader rather than npm.
  const fromAdapter = createRequire(path.join(REPO, 'packages', 'adapter', 'package.json'));
  symlinkSync(
    path.dirname(fromAdapter.resolve('next/package.json')),
    path.join(appDir, 'node_modules', 'next'),
  );
}
