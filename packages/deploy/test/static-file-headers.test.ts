import { BuildPatternBudget, type DeploymentBundle, type Route } from '@stayingupwind/core/bundle';
import {
  buildProjectManifest,
  MAX_MANIFEST_BYTES,
  parseProjectManifest,
  type ProjectManifest,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import { describe, expect, it } from 'vitest';

import { type FixtureBundleOptions, fixtureBundle } from '../../core/test/fixtures/bundle.ts';
import {
  type AssembledManifest,
  assembleManifest,
  fitBuildTags,
  fitFileHeaders,
  oversizedManifest,
} from '../src/manifest.ts';
import { staticFilesOf, staticFilesWithHeadersOf } from '../src/static-files.ts';

/**
 * What a deploy stores on each file of a build with `i18n`, whose rules of `next.config` the edge
 * does not judge on each request: the headers the unconditional ones set on the file as Next.js's
 * router matches it (`shippedFileHeadersOf`), which the edge lays on the file as it lays the rules
 * it judges itself. A build without `i18n` has its files' rules judged at the edge, and its entries
 * are what they were.
 */

const ANY_PATH = String.raw`(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))?(?:\/)?$`;
/** The locale group `next build` puts in front of a source (`:nextInternalLocale(en|fr)`). */
const LOCALE = String.raw`(?:\/(en|fr))`;
const POLICY = "default-src 'self'; frame-ancestors 'none'";
const IMMUTABLE = 'public,max-age=31536000,immutable';
const CHUNK = '/_next/static/chunks/main-abc123.js';
const STYLES = '/_next/static/css/app-def456.css';

/** `{ source: '/:path*' }` as Next.js 16.4.6 hands it on for `i18n` with `en` and `fr`. */
const EVERY_LOCALIZED_PATH: Route = {
  source: '/:nextInternalLocale(en|fr)/:path*',
  sourceRegex: `^${LOCALE}${ANY_PATH}`,
  headers: { 'Content-Security-Policy': POLICY, 'X-Content-Type-Options': 'nosniff' },
};
/** `{ source: '/_next/static/:path*', locale: false }`, as it is handed on. */
const NEXT_STATIC: Route = {
  source: '/_next/static/:path*',
  sourceRegex: String.raw`^\/_next\/static${ANY_PATH}`,
  headers: { 'Cross-Origin-Resource-Policy': 'same-origin' },
};

const GENERATED_AT = '2026-11-17T00:00:00.000Z';
const PLAIN_FILE: StaticFileEntry = {
  sha256: 'a'.repeat(64),
  byteLength: 1,
  contentType: 'text/plain',
  immutable: false,
};

/** A manifest of nothing but `staticFiles`. */
function manifestOf(staticFiles: Record<string, StaticFileEntry>): ProjectManifest {
  return buildProjectManifest({
    projectId: 'large',
    runId: 'run',
    generatedAt: GENERATED_AT,
    originHost: 'large.example',
    deployment: { assetSetHash: 'h', observedAt: GENERATED_AT },
    routes: [],
    app: { deploymentId: 'dpl_large', scriptName: 'large-app' },
    staticFiles,
  });
}

/** The manifest a deploy assembles of `bundle`, as one serving no runtime cache does. */
async function assembledFrom(
  bundle: DeploymentBundle,
): Promise<Extract<AssembledManifest, { readonly kind: 'assembled' }>> {
  const assembled = await assembleManifest({
    bundle,
    previous: undefined,
    projectId: 'localized',
    runId: 'run',
    originHost: 'localized.example',
    deploymentId: bundle.deploymentId,
    fingerprint: {
      dplId: bundle.deploymentId,
      buildId: bundle.buildId,
      assetSetHash: 'assets',
      observedAt: bundle.generatedAt,
    },
    app: { deploymentId: bundle.deploymentId, scriptName: 'localized-app' },
    generatedAt: bundle.generatedAt,
    encodings: new Map(),
    preloads: {},
    recoverySource: "'sha256-recovery'",
    runtimeCache: false,
    nextVersionJudged: true,
  });
  if (assembled.kind !== 'assembled') throw new Error(assembled.reason);
  return assembled;
}

function entries(options: FixtureBundleOptions): Record<string, StaticFileEntry> {
  return staticFilesOf(fixtureBundle(options), undefined, new BuildPatternBudget());
}

describe("the files of a build's manifest, with the headers its rules set on them", () => {
  it('carry what the unconditional rules of an i18n build set on each', () => {
    const files = entries({ i18n: true, headerRules: [EVERY_LOCALIZED_PATH, NEXT_STATIC] });

    expect(files['/hello.txt']?.headers).toStrictEqual({
      'content-security-policy': POLICY,
      'x-content-type-options': 'nosniff',
    });
    expect(files[CHUNK]?.headers).toStrictEqual({
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': IMMUTABLE,
    });
    // One object for the files that share their headers.
    expect(files[STYLES]?.headers).toBe(files[CHUNK]?.headers);
  });

  /** Byte for byte as before: the edge judges every rule of such a build itself. */
  it('are what they were for a build without i18n', () => {
    const files = entries({ headerRules: [EVERY_LOCALIZED_PATH, NEXT_STATIC] });

    expect(files).toStrictEqual({
      [CHUNK]: {
        sha256: '3'.repeat(64),
        byteLength: 4000,
        contentType: 'text/javascript',
        immutable: true,
      },
      [STYLES]: {
        sha256: '4'.repeat(64),
        byteLength: 800,
        contentType: 'text/css',
        immutable: true,
      },
      '/hello.txt': {
        sha256: '5'.repeat(64),
        byteLength: 12,
        contentType: 'text/plain',
        immutable: false,
      },
    });
  });

  /**
   * The files the deployment before built that this one keeps for its documents still open are
   * answered under this deployment's rules, as every file is where the edge judges them itself.
   */
  it("give a file kept from the deployment before this deployment's headers", () => {
    const bundle = fixtureBundle({ i18n: true, headerRules: [NEXT_STATIC] });
    const before = fixtureBundle({ i18n: true });
    const kept = '/_next/static/chunks/before-0a1b2c.js';
    const previous = {
      ...before,
      deploymentId: 'dpl_before',
      staticFiles: [
        ...before.staticFiles,
        {
          pathname: kept,
          blob: { sha256: '7'.repeat(64), byteLength: 9, contentType: 'text/javascript' },
          immutable: true,
        },
      ],
    };

    const files = staticFilesOf(bundle, previous, new BuildPatternBudget());

    expect(files[kept]).toMatchObject({
      deploymentId: 'dpl_before',
      headers: { 'cross-origin-resource-policy': 'same-origin', 'cache-control': IMMUTABLE },
    });
  });

  /**
   * Judging every rule against every file is work a build is allowed only so much of. Past it the
   * files carry nothing, as they did before the field — never a deployment refused over it.
   */
  it('carry nothing, rather than refuse the deployment, past the matching a build is allowed', () => {
    const { files, fileHeaders } = staticFilesWithHeadersOf(
      fixtureBundle({ i18n: true, headerRules: [EVERY_LOCALIZED_PATH, NEXT_STATIC] }),
      undefined,
      new BuildPatternBudget(),
      new BuildPatternBudget(64),
    );

    expect(Object.values(files).map((file) => file.headers)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // And say so, for whoever deploys it to say.
    expect(fileHeaders).toStrictEqual({ kind: 'left-out', reason: 'patterns' });
  });

  /**
   * What they take is an improvement the edge serves without: a manifest they would take past what
   * a deployment may publish is published as it would have been without them.
   */
  it('are left off, rather than refuse the deployment, where they would take it past its limit', () => {
    const built = manifestOf({
      '/a.txt': { ...PLAIN_FILE, headers: { link: 'x'.repeat(MAX_MANIFEST_BYTES) } },
      '/b.txt': { ...PLAIN_FILE, headers: { 'x-frame-options': 'DENY' } },
      '/c.txt': PLAIN_FILE,
    });

    const fitted = fitFileHeaders(built);

    expect(built.staticFileHeaders).toBe(true);
    expect(oversizedManifest(fitted.manifest, fitted.serialized)).toBeUndefined();
    expect(fitted.leftOut).toBe(true);
    expect(fitted.manifest).not.toHaveProperty('staticFileHeaders');
    expect(fitted.manifest.staticFiles).toStrictEqual({
      '/a.txt': PLAIN_FILE,
      '/b.txt': PLAIN_FILE,
      '/c.txt': PLAIN_FILE,
    });
  });

  /** And a manifest they fit in keeps them, as one whose files store none is fitted as before. */
  it('are kept where they fit', () => {
    const small = manifestOf({
      '/b.txt': { ...PLAIN_FILE, headers: { 'x-frame-options': 'DENY' } },
    });
    const none = manifestOf({ '/b.txt': PLAIN_FILE });

    expect(fitFileHeaders(small)).toMatchObject({ manifest: small, leftOut: false });
    expect(fitFileHeaders(none)).toStrictEqual({ ...fitBuildTags(none), leftOut: false });
  });

  it('travel through the manifest the edge reads', async () => {
    const assembled = await assembledFrom(
      fixtureBundle({ i18n: true, headerRules: [EVERY_LOCALIZED_PATH] }),
    );

    const read = parseProjectManifest(assembled.serialized);

    expect(read.staticFiles?.['/hello.txt']?.headers).toStrictEqual({
      'content-security-policy': POLICY,
      'x-content-type-options': 'nosniff',
    });
    expect(read.staticFiles?.[CHUNK]?.headers).toStrictEqual({ 'cache-control': IMMUTABLE });
    // The rules stay off the list the edge judges on each request, as they were.
    expect(read.headerRules).toBeUndefined();
    expect(assembled.fileHeaders).toStrictEqual({ kind: 'stored', files: 3 });
  });
});

/**
 * What the assembly says of the files' headers (`fileHeaders`): what a deployer is told, since a
 * deployment they were left out of is published all the same, its files answering without them.
 */
describe('what the assembly says of its files headers', () => {
  it('says nothing applies to a build whose rules the edge judges itself', async () => {
    const assembled = await assembledFrom(fixtureBundle({ headerRules: [NEXT_STATIC] }));

    expect(assembled.fileHeaders).toStrictEqual({ kind: 'not-applicable' });
    expect(assembled.manifest).not.toHaveProperty('staticFileHeaders');
  });

  /**
   * A rule whose every file's headers differ — each fills in the path it matched, as `$1` does — so
   * that no table shares them, and they come to more than a manifest may hold, while the rule itself
   * does not.
   */
  it('says they were left out where the manifest would not fit with them', async () => {
    const huge: Route = {
      source: '/_next/static/:path*',
      sourceRegex: String.raw`^\/_next\/static\/(.*)$`,
      headers: { 'x-asset': '$1'.repeat(MAX_MANIFEST_BYTES / 32) },
    };
    const assembled = await assembledFrom(fixtureBundle({ i18n: true, headerRules: [huge] }));

    expect(assembled.fileHeaders).toStrictEqual({ kind: 'left-out', reason: 'size' });
    expect(Object.values(assembled.staticFiles).map((file) => file.headers)).toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(parseProjectManifest(assembled.serialized)).not.toHaveProperty('staticFileHeaders');
  });
});

/**
 * An application with an `assetPrefix` has its pages ask for every file of its `_next` under the
 * prefix — `/assets/_next/static/…` — which `next build` rewrites to the file after its header rules
 * have been judged on the path asked for (`beforeFiles`). So a rule written for the prefixed path
 * sets its headers on that spelling and not on the file's own name, and one for `/_next/static/`
 * the other way round: the entry stores the prefixed spelling's set apart where the two differ.
 */
describe('the files of a build asked for under its asset prefix', () => {
  /** `next build`'s rewrite of the prefix, first of its `beforeFiles` (`loadRewrites`). */
  const prefixRewrite: Route = {
    source: '/assets/_next/:path+',
    sourceRegex: String.raw`^\/assets\/_next(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))$`,
    destination: '/_next/$1',
  };
  /** `{ source: '/assets/_next/static/:path*', locale: false }`, as it is handed on. */
  const prefixedRule: Route = {
    source: '/assets/_next/static/:path*',
    sourceRegex: String.raw`^\/assets\/_next\/static${ANY_PATH}`,
    headers: { 'X-Prefixed': 'yes' },
  };
  const ownRule: Route = { ...NEXT_STATIC, headers: { 'X-Canonical': 'yes' } };
  /** `{ source: '/:path*', locale: false }`: every path, the prefixed spelling among them. */
  const everyPath: Route = {
    source: '/:path*',
    sourceRegex: `^${ANY_PATH}`,
    headers: { 'X-Frame-Options': 'DENY' },
  };

  function prefixed(headerRules: readonly Route[], onMatch?: readonly Route[]): DeploymentBundle {
    const bundle = fixtureBundle({ i18n: true, beforeFiles: [prefixRewrite], headerRules });
    return {
      ...bundle,
      config: { ...bundle.config, assetPrefix: '/assets' },
      routing: { ...bundle.routing, ...(onMatch !== undefined && { onMatch: [...onMatch] }) },
    };
  }

  it('stores what a rule for each spelling sets on it alone', () => {
    const files = staticFilesOf(
      prefixed([prefixedRule, ownRule, everyPath]),
      undefined,
      new BuildPatternBudget(),
    );

    expect(files[CHUNK]?.headers).toStrictEqual({
      'x-canonical': 'yes',
      'x-frame-options': 'DENY',
      'cache-control': IMMUTABLE,
    });
    // The year-long lifetime `next build` gives its hashed files matches either spelling.
    expect(files[CHUNK]?.assetPrefixHeaders).toStrictEqual({
      'x-prefixed': 'yes',
      'x-frame-options': 'DENY',
      'cache-control': IMMUTABLE,
    });
    // A `public/` file is asked for by its own name alone.
    expect(files['/hello.txt']).not.toHaveProperty('assetPrefixHeaders');
  });

  /** The usual case: a rule over every path sets both spellings alike, and one set is stored. */
  it('stores one set where the rules set both spellings alike', () => {
    const files = staticFilesOf(prefixed([everyPath]), undefined, new BuildPatternBudget());

    expect(files[CHUNK]?.headers).toStrictEqual({
      'x-frame-options': 'DENY',
      'cache-control': IMMUTABLE,
    });
    expect(files[CHUNK]).not.toHaveProperty('assetPrefixHeaders');
  });

  /** Where only the file's own name is set anything, the prefixed spelling is stored as set none. */
  it('stores the prefixed spelling as set nothing where only the own name is set something', () => {
    const files = staticFilesOf(prefixed([ownRule], []), undefined, new BuildPatternBudget());

    expect(files[CHUNK]?.headers).toStrictEqual({ 'x-canonical': 'yes' });
    expect(files[CHUNK]?.assetPrefixHeaders).toStrictEqual({});
  });

  it('travel through the manifest the edge reads, each set held once', async () => {
    const assembled = await assembledFrom(prefixed([prefixedRule, ownRule, everyPath]));

    const read = parseProjectManifest(assembled.serialized);
    const stored = JSON.parse(assembled.serialized) as {
      readonly staticFiles: Record<string, Record<string, unknown>>;
    };

    expect(read.staticFiles?.[CHUNK]?.assetPrefixHeaders).toStrictEqual({
      'x-prefixed': 'yes',
      'x-frame-options': 'DENY',
      'cache-control': IMMUTABLE,
    });
    expect(read.staticFiles?.[STYLES]?.assetPrefixHeaders).toBe(
      read.staticFiles?.[CHUNK]?.assetPrefixHeaders,
    );
    expect(stored.staticFiles[CHUNK]?.['assetPrefixHeaders']).toBeTypeOf('number');
    expect(assembled.serialized.split('x-prefixed')).toHaveLength(2);
    expect(read.staticFileAssetPrefix).toStrictEqual({ basePath: '', assetPrefix: '/assets' });
  });
});
