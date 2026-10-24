import { describe, expect, it } from 'vitest';

import { escapedPathOf, requestPathOf } from '../src/manifest/built-names.ts';
import { isExactPathname } from '../src/manifest/dynamic.ts';
import {
  buildProjectManifest,
  computeManifestId,
  fileRequestPathOf,
  findRouteEntry,
  parseProjectManifest,
  routeRequestPathOf,
  serializeManifest,
  staticFileKey,
  staticFileStatus,
} from '../src/manifest/manifest.ts';
import {
  type DynamicRoute,
  MANIFEST_SCHEMA_VERSION,
  READ_MANIFEST_SCHEMA_VERSIONS,
  type RouteEntry,
} from '../src/manifest/schema.ts';

/** The version a writer published before this one: the latest read below it, not one less. */
const PREVIOUS_VERSION = Math.max(
  ...READ_MANIFEST_SCHEMA_VERSIONS.filter((version) => version < MANIFEST_SCHEMA_VERSION),
);

const OBSERVED_AT = '2026-09-15T00:00:00.000Z';
const APP = { deploymentId: 'dpl_1', scriptName: 'app-1' };
const ENTRY: RouteEntry = {
  pathname: '/blog/hello',
  status: 200,
  shell: {
    sha256: 'a'.repeat(64),
    byteLength: 1234,
    contentType: 'text/html; charset=utf-8',
    encoding: 'identity',
  },
  headers: { 'content-type': 'text/html; charset=utf-8' },
};

/** The entry above, under another pathname. */
function named(pathname: string): RouteEntry {
  return { ...ENTRY, pathname };
}

function build(routes: readonly RouteEntry[] = [ENTRY]) {
  return buildProjectManifest({
    projectId: 'site1',
    runId: 'run1',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes,
    app: APP,
  });
}

/**
 * The manifest `build` makes, with dynamic routes of the patterns given and the pages of their own
 * they also match (`filesystemPages`), which a manifest of this build lists however few.
 */
function withDynamic(
  routes: readonly RouteEntry[],
  dynamicRoutes: readonly DynamicRoute[],
  filesystemPages: readonly string[] = [],
) {
  return buildProjectManifest({
    projectId: 'site1',
    runId: 'run1',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes,
    app: APP,
    dynamicRoutes,
    filesystemPages,
  });
}

/** The manifest `build` makes, of an application with a list of its own in `htmlLimitedBots`. */
function listing(htmlLimitedBots: string) {
  return buildProjectManifest({
    projectId: 'site1',
    runId: 'run1',
    generatedAt: OBSERVED_AT,
    originHost: 'example.com',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes: [ENTRY],
    app: APP,
    htmlLimitedBots,
  });
}

describe('buildProjectManifest', () => {
  /** Absent fields are skipped by the canonical JSON, so a manifest without a cache keeps its id. */
  it('names the runtime cache a route is served from, and its scope, only when there is one', async () => {
    const cached: RouteEntry = {
      ...ENTRY,
      cache: { entryId: 'ent_1', kind: 'app-page', delivery: 'resume' },
      bypassFor: [{ type: 'header', key: 'next-action' }],
    };
    const plain = build();
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
      routes: [cached],
      app: APP,
      cache: { keySchemaVersion: 1, scopeId: 'dpl_1' },
    });
    const parsed = parseProjectManifest(serializeManifest(manifest));

    expect(parsed).toStrictEqual(manifest);
    expect(findRouteEntry(parsed, '/blog/hello')?.cache?.entryId).toBe('ent_1');
    expect(parsed.cache).toStrictEqual({ keySchemaVersion: 1, scopeId: 'dpl_1' });
    expect(plain.cache).toBeUndefined();
    await expect(computeManifestId(manifest)).resolves.not.toBe(await computeManifestId(plain));
  });

  /**
   * The agents the application sends blocking metadata to travel as the build recorded them, a
   * pattern the edge will not run included — whether it runs one is the reader's to decide — and a
   * manifest without a list of its own keeps its id.
   */
  it('carries the htmlLimitedBots pattern the build recorded, and only when there is one', async () => {
    const plain = build();
    const listed = listing('MyBot|Discordbot');
    const parsed = parseProjectManifest(serializeManifest(listed));
    const backtracking = parseProjectManifest(serializeManifest(listing('(a+)+')));

    expect(parsed).toStrictEqual(listed);
    expect(parsed.htmlLimitedBots).toBe('MyBot|Discordbot');
    expect(backtracking.htmlLimitedBots).toBe('(a+)+');
    expect(plain.htmlLimitedBots).toBeUndefined();
    expect(serializeManifest(plain)).not.toContain('htmlLimitedBots');
    await expect(computeManifestId(listed)).resolves.not.toBe(await computeManifestId(plain));
  });

  it('round-trips through serialisation with a stable id', async () => {
    const manifest = build();
    const parsed = parseProjectManifest(serializeManifest(manifest));

    expect(parsed).toStrictEqual(manifest);
    await expect(computeManifestId(parsed)).resolves.toBe(await computeManifestId(manifest));
  });

  it('applies default continuation and asset policies', () => {
    const manifest = build();

    expect(manifest.continuation.totalTimeoutMs).toBeGreaterThan(0);
    expect(manifest.assetPolicy.pathClasses).toContain('immutable');
  });

  /** An edge that does not know the version refuses the manifest rather than reading it wrong. */
  it('names its schema version and refuses one it does not know', () => {
    const noApp: Record<string, unknown> = { ...build() };
    delete noApp['app'];
    const later = JSON.stringify({
      ...build(),
      schemaVersion: Math.max(...READ_MANIFEST_SCHEMA_VERSIONS) + 1,
    });

    expect(build().schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(() => parseProjectManifest(JSON.stringify(noApp))).toThrow('app');
    expect(() => parseProjectManifest(later)).toThrow('schemaVersion');
  });

  /**
   * What a version accepts is never narrowed: a reader takes a manifest of every version a reader
   * took before it, each of which an edge served the day before — the one before its own, and the
   * one before that, whose manifests are still served where nothing has published since.
   */
  it.each(READ_MANIFEST_SCHEMA_VERSIONS)(
    'reads a manifest of schema version %s',
    (schemaVersion) => {
      const written = { ...build(), schemaVersion };

      expect(parseProjectManifest(JSON.stringify(written)).schemaVersion).toBe(schemaVersion);
    },
  );

  it('reads its own version among them', () => {
    expect(READ_MANIFEST_SCHEMA_VERSIONS).toContain(MANIFEST_SCHEMA_VERSION);
  });

  it('reads a manifest of the version before its own', () => {
    const before = { ...build(), schemaVersion: PREVIOUS_VERSION };

    expect(parseProjectManifest(JSON.stringify(before)).schemaVersion).toBe(PREVIOUS_VERSION);
  });

  /**
   * A pattern that does not compile is refused at the upload, not here: a reader that checked
   * again would refuse, with the whole manifest, one an upload wrote before the check was — and
   * an edge rolled out with the check would drop every such project it served the day before.
   */
  it('reads a matcher pattern as it was written, whether or not it compiles', () => {
    const valid = {
      ...build(),
      middleware: { matchers: [{ sourceRegex: String.raw`^\/a(?:\/)?$` }] },
    };
    const broken = { ...build(), middleware: { matchers: [{ sourceRegex: '^(' }] } };
    const brokenRule = { ...build(), headerRules: [{ sourceRegex: '[', headers: { 'x-a': '1' } }] };

    const parsed = parseProjectManifest(JSON.stringify(valid));
    const read = parseProjectManifest(JSON.stringify(broken));
    const readRule = parseProjectManifest(JSON.stringify(brokenRule));

    expect(parsed.middleware?.matchers).toHaveLength(1);
    expect(read.middleware?.matchers).toStrictEqual([{ sourceRegex: '^(' }]);
    expect(readRule.headerRules).toHaveLength(1);
  });

  it('carries the pre-compressed renderings of a shell, and does without them', async () => {
    const encoded: RouteEntry = {
      ...ENTRY,
      shellEncodings: {
        br: {
          sha256: 'b'.repeat(64),
          byteLength: 300,
          contentType: ENTRY.shell.contentType,
          encoding: 'br',
        },
        gzip: {
          sha256: 'c'.repeat(64),
          byteLength: 400,
          contentType: ENTRY.shell.contentType,
          encoding: 'gzip',
          crc32: 0xcb_f4_39_26,
        },
      },
    };
    const manifest = build([encoded]);
    const parsed = parseProjectManifest(serializeManifest(manifest));
    // A manifest from before compression existed names no renderings and serves identity.
    const plain = parseProjectManifest(serializeManifest(build()));
    const plainId = await computeManifestId(build());

    // A key may only hold the reference of its own encoding: the two must never disagree.
    const crossed = JSON.parse(serializeManifest(manifest)) as {
      routes: Record<string, { shellEncodings: { br: unknown; gzip: unknown } }>;
    };
    crossed.routes['/blog/hello']!.shellEncodings.br = encoded.shellEncodings?.gzip;

    // A CRC the trailer cannot write in four bytes is not a CRC-32.
    const overflowing = JSON.parse(serializeManifest(manifest)) as {
      routes: Record<string, { shellEncodings: { gzip: { crc32: number } } }>;
    };
    overflowing.routes['/blog/hello']!.shellEncodings.gzip.crc32 = 0x1_00_00_00_00;

    expect(parsed.routes['/blog/hello']?.shellEncodings).toStrictEqual(encoded.shellEncodings);
    expect(() => parseProjectManifest(JSON.stringify(crossed))).toThrow(/encoding/u);
    expect(() => parseProjectManifest(JSON.stringify(overflowing))).toThrow(/crc32/u);
    expect(plain.routes['/blog/hello']?.shellEncodings).toBeUndefined();
    await expect(computeManifestId(manifest)).resolves.not.toBe(plainId);
  });

  /**
   * Optional and omitted when the head named nothing, for the same reason: a route with no
   * render-blocking resource of its own publishes the entry it published before the field existed.
   */
  it('carries the render-blocking resources a route names, and omits them when there are none', () => {
    const preloads = ['</app.css>; rel=preload; as=style'];
    const preloading: RouteEntry = { ...ENTRY, pathname: '/', preloads };
    const json = serializeManifest(build([ENTRY, preloading]));

    expect(parseProjectManifest(json).routes['/']?.preloads).toStrictEqual(preloads);
    expect(parseProjectManifest(json).routes['/blog/hello']?.preloads).toBeUndefined();
    expect(serializeManifest(build())).not.toContain('preloads');
  });
});

describe('findRouteEntry', () => {
  it('matches exactly, without case folding or slash normalisation', () => {
    const manifest = build();

    expect(findRouteEntry(manifest, '/blog/hello')).toStrictEqual(ENTRY);
    expect(findRouteEntry(manifest, '/blog/hello/')).toBeUndefined();
    expect(findRouteEntry(manifest, '/Blog/hello')).toBeUndefined();
    expect(findRouteEntry(manifest, 'constructor')).toBeUndefined();
  });

  /**
   * Next.js names a prerender by the characters its path reads as, and a request carries them
   * escaped: looked up only as it came, a page with a space or a Japanese slug in its path was
   * never served from what the build prerendered.
   */
  it('finds a route the request spelled escaped under the name the build gave it', () => {
    const manifest = build([named('/sticks & stones'), named('/記事'), named('/100%25')]);

    expect(findRouteEntry(manifest, '/sticks%20%26%20stones')?.pathname).toBe('/sticks & stones');
    expect(findRouteEntry(manifest, '/%E8%A8%98%E4%BA%8B')?.pathname).toBe('/記事');
    expect(findRouteEntry(manifest, '/100%25')?.pathname).toBe('/100%25');
    expect(findRouteEntry(manifest, '/%E8%A8')).toBeUndefined();
    expect(findRouteEntry(manifest, '/sticks%20and%20stones')).toBeUndefined();
  });

  /**
   * Next.js finds a page of its own decoded whole, ahead of any dynamic route (`getItem`), and a
   * member of a dynamic route by its value, a delimiter in it escaped (`escapePathDelimiters`):
   * `/a%2Fb` is the member whose value is `a/b`, which a request may spell `%2f` as well. Decoded
   * whole for a member, an escaped slash was a separator, and `/a%2Fb` was looked up as `/a/b` — a
   * member of another route — and an escaped escape (`/a%252Fb`, the value `a%2Fb`) as `a/b`.
   */
  it('finds a member by its built name, an escaped slash inside its segment', () => {
    const members = [{ sourceRegex: '^/([^/]+?)(?:/)?$' }, { sourceRegex: '^/(.+?)(?:/)?$' }];
    const both = withDynamic([named('/a%2Fb'), named('/a/b')], members);
    const other = withDynamic([named('/a/b')], members);

    expect(findRouteEntry(both, '/a%2Fb')?.pathname).toBe('/a%2Fb');
    expect(findRouteEntry(both, '/a%2fb')?.pathname).toBe('/a%2Fb');
    expect(findRouteEntry(both, '/a%252Fb')).toBeUndefined();
    expect(findRouteEntry(other, '/a%2Fb')).toBeUndefined();
    expect(findRouteEntry(other, '/a%2fb')).toBeUndefined();
  });

  /**
   * A page no dynamic route could take for a member is found decoded whole, as Next.js finds it,
   * and ahead of a member named as the request spells it: Next.js's filesystem check asks for the
   * page before any dynamic route asks for the member.
   */
  it('finds a page of its own decoded whole, where no dynamic route reads it as a member', () => {
    const manifest = withDynamic([named('/api/a/b')], [{ sourceRegex: '^/api/([^/]+?)(?:/)?$' }]);
    const both = withDynamic(
      [named('/docs/a%2Fb'), named('/docs/a/b')],
      [{ sourceRegex: '^/docs/([^/]+?)(?:/)?$' }],
    );

    expect(findRouteEntry(manifest, '/api/a%2Fb')?.pathname).toBe('/api/a/b');
    expect(findRouteEntry(both, '/docs/a%2Fb')?.pathname).toBe('/docs/a/b');
    expect(findRouteEntry(both, '/docs/a%2fb')?.pathname).toBe('/docs/a/b');
  });

  /**
   * A page of its own that a catch-all's pattern also matches is listed as one (`filesystemPages`)
   * and found decoded whole ahead of the catch-all, as Next.js finds it; unlisted, it is taken for a
   * member of the catch-all, which no escaped slash names.
   */
  it('finds a page a catch-all also matches decoded whole, where it is listed as its own', () => {
    const catchAll = [{ sourceRegex: '^/docs/(.+?)(?:/)?$' }];
    const listed = withDynamic([named('/docs/a/b')], catchAll, ['/docs/a/b']);
    const unlisted = withDynamic([named('/docs/a/b')], catchAll);

    expect(findRouteEntry(listed, '/docs/a%2Fb')?.pathname).toBe('/docs/a/b');
    expect(findRouteEntry(unlisted, '/docs/a%2Fb')).toBeUndefined();
  });

  /**
   * A manifest from before the pages of their own were listed is read as it was then: as spelled,
   * and then decoded whole, as that build's Functions find a page.
   */
  it('reads a manifest that lists no pages of their own as before', () => {
    const earlier = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
      routes: [named('/docs/a/b'), named('/a%2Fb')],
      app: APP,
      dynamicRoutes: [{ sourceRegex: '^/(.+?)(?:/)?$' }],
    });

    expect(earlier.filesystemPages).toBeUndefined();
    expect(findRouteEntry(earlier, '/docs/a%2Fb')?.pathname).toBe('/docs/a/b');
    expect(findRouteEntry(earlier, '/a%2Fb')?.pathname).toBe('/a%2Fb');
    expect(findRouteEntry(earlier, '/a%2fb')).toBeUndefined();
  });
});

describe('the path a request asks by', () => {
  const ORIGIN = 'https://example.com';

  /** The path the URL holds once `path`, a path a request asks by, is written into it. */
  function pathOf(path: string | undefined): string {
    if (path === undefined) {
      throw new Error('no path a request asks by');
    }
    return new URL(path, ORIGIN).pathname;
  }

  /**
   * Next.js names a page by its parameters' values, a `%` or a space in one as it is, and a `/` in
   * one escaped (`prerender-encoding`). Asked by the path a request names it by, the edge finds
   * each; written into a URL as it is, a name with a `%` in a parameter names no page, and every
   * deployment of such a build failed its validation for it.
   */
  it('names each page as the edge finds it, where the name written in as it is names none', () => {
    const names = [
      '/closed/docs/space here/100%',
      '/closed/docs/space here/with%2Fslash/100%',
      '/sticks & stones',
      '/100%25',
      '/a%252Fb',
      '/記事',
    ];
    const manifest = withDynamic(
      names.map((name) => named(name)),
      [{ sourceRegex: '^/closed/(.+?)(?:/)?$' }],
    );

    for (const name of names) {
      const asked = pathOf(requestPathOf(name));

      expect(findRouteEntry(manifest, asked)?.pathname).toBe(name);
    }

    expect(findRouteEntry(manifest, pathOf('/closed/docs/space here/100%'))).toBeUndefined();
  });

  /**
   * A route is asked at the path the edge finds it by: a page of its own by its name as it is, a `%2F`
   * in it a `%` and a `2F`, and a member by its built name. A member a page of its own shadows is
   * asked at none: Next.js finds the page first for every path that names the member.
   */
  it('asks for each route at the path the edge finds it by, and for a shadowed member at none', () => {
    const manifest = withDynamic(
      [named('/docs/a/b'), named('/docs/a%2Fb'), named('/x%2F?')],
      [{ sourceRegex: '^/docs/(.+?)(?:/)?$' }],
      ['/docs/a/b', '/x%2F?'],
    );
    const own = pathOf(routeRequestPathOf(manifest, '/x%2F?'));
    const page = pathOf(routeRequestPathOf(manifest, '/docs/a/b'));

    expect(routeRequestPathOf(manifest, '/docs/a%2Fb')).toBeUndefined();
    expect(own).toBe('/x%252F%3F');
    expect(findRouteEntry(manifest, own)?.pathname).toBe('/x%2F?');
    expect(findRouteEntry(manifest, page)?.pathname).toBe('/docs/a/b');
  });

  /**
   * The edge finds a route as spelled before it decodes one: where another is named as a request
   * would spell a route (`/docs/100%25` beside `/docs/100%`), it is asked by a spelling none is
   * named as.
   */
  it('asks for a route another is named as the spelling of, and finds each', () => {
    const names = ['/docs/100%', '/docs/100%25'];
    const manifest = withDynamic(
      names.map((name) => named(name)),
      [{ sourceRegex: '^/docs/(.+?)(?:/)?$' }],
    );

    for (const name of names) {
      const asked = pathOf(routeRequestPathOf(manifest, name));

      expect(findRouteEntry(manifest, asked)?.pathname).toBe(name);
    }
  });

  /** A file is found as spelled, or decoded whole (`staticFileKey`): escaped whole, it is either. */
  it('names each file as the edge finds it, where the name written in as it is names none', () => {
    const file = {
      sha256: 'b'.repeat(64),
      byteLength: 1,
      contentType: 'text/plain',
      immutable: false,
    };
    const names = ['/50% off.png', '/space here/100%.html', '/a%2Fb.txt', '/記事.html'];
    const manifest = {
      ...build(),
      staticFiles: Object.fromEntries(names.map((name) => [name, file])),
    };

    for (const name of names) {
      const asked = pathOf(escapedPathOf(name));

      expect(staticFileKey(manifest, asked)).toBe(name);
    }

    expect(staticFileKey(manifest, pathOf('/50% off.png'))).toBeUndefined();
  });

  /** Where another file is named as a request would spell one (`/a%20b` beside `/a b`), each is found. */
  it('asks for a file another is named as the spelling of, and finds each', () => {
    const file = {
      sha256: 'b'.repeat(64),
      byteLength: 1,
      contentType: 'text/plain',
      immutable: false,
    };
    const names = ['/a b', '/a%20b', '/a%2F.txt', '/a%252F.txt'];
    const manifest = {
      ...build(),
      staticFiles: Object.fromEntries(names.map((name) => [name, file])),
    };

    for (const name of names) {
      const asked = pathOf(fileRequestPathOf(manifest, name));

      expect(staticFileKey(manifest, asked)).toBe(name);
    }
  });
});

describe('isExactPathname', () => {
  /**
   * A guard, which keeps a dynamic class's shell from a pathname Next.js resolves exactly: found as
   * a route is, so a member's escaped slash is part of its value (`/c%2Fd` is not the member
   * `/c/d`), and a page of its own is found decoded whole (`/api/a%2Fb` is the page `/api/a/b`).
   */
  it('finds an exact pathname as a route is found', () => {
    const manifest = buildProjectManifest({
      projectId: 'site1',
      runId: 'run1',
      generatedAt: OBSERVED_AT,
      originHost: 'example.com',
      deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
      routes: [ENTRY],
      app: APP,
      exactPathnames: ['/a%2Fb', '/c/d', '/記事', '/api/a/b'],
      dynamicRoutes: [{ sourceRegex: '^/([^/]+?)(?:/)?$' }, { sourceRegex: '^/c/(.+?)(?:/)?$' }],
      filesystemPages: [],
    });

    expect(isExactPathname(manifest, '/a%2Fb')).toBe(true);
    expect(isExactPathname(manifest, '/a%2fb')).toBe(true);
    expect(isExactPathname(manifest, '/c%2Fd')).toBe(false);
    expect(isExactPathname(manifest, '/%E8%A8%98%E4%BA%8B')).toBe(true);
    expect(isExactPathname(manifest, '/api/a%2Fb')).toBe(true);
    expect(isExactPathname(manifest, '/e%2Ff')).toBe(false);
  });
});

describe('staticFileStatus', () => {
  /** Next.js names its error documents under the basePath, as everything of a build. */
  it('reads the status off an error document, under the basePath', () => {
    expect(staticFileStatus('/404')).toBe(404);
    expect(staticFileStatus('/500')).toBe(500);
    expect(staticFileStatus('/docs/404', '/docs')).toBe(404);
    expect(staticFileStatus('/docs/500', '/docs')).toBe(500);
    // Without the basePath, `/docs/404` is a public file of that name.
    expect(staticFileStatus('/docs/404')).toBe(200);
    expect(staticFileStatus('/404', '/docs')).toBe(200);
    expect(staticFileStatus('/robots.txt')).toBe(200);
  });

  /**
   * A `trailingSlash` build writes its error document a second time, as `404/index.html`, and that
   * is the spelling a visitor who types the path is served. The same page under a 200 would be a
   * soft 404; Next.js's own server answers either spelling with the status it stands for.
   */
  it('reads it off the spelling a trailingSlash build serves as well', () => {
    expect(staticFileStatus('/404/')).toBe(404);
    expect(staticFileStatus('/500/')).toBe(500);
    expect(staticFileStatus('/docs/404/', '/docs')).toBe(404);
    // The site's root is not an error document, however a build spells it.
    expect(staticFileStatus('/')).toBe(200);
    expect(staticFileStatus('/docs/', '/docs')).toBe(200);
  });
});
