import { describe, expect, it } from 'vitest';

import {
  buildProjectManifest,
  parseProjectManifest,
  serializeManifest,
} from '../src/manifest/manifest.ts';
import {
  MANIFEST_SCHEMA_VERSION,
  type RouteEntry,
  type StaticFileEntry,
  staticFileEntrySchema,
} from '../src/manifest/schema.ts';
import { fromStoredManifest } from '../src/manifest/stored.ts';

/**
 * The headers a shipped file is stored with (`StaticFileEntry.headers`): what the unconditional
 * rules of `next.config` set on it, for a build whose rules the edge does not judge on each request.
 * Most files share one set — every `public/` file under a catch-all policy — so a stored manifest
 * holds each set once, in the table its routes' headers are held in, and a file names its set by
 * its place there, as a route does.
 */

const OBSERVED_AT = '2026-11-17T00:00:00.000Z';
const POLICY = {
  'content-security-policy': "default-src 'self'; script-src 'self'",
  'x-content-type-options': 'nosniff',
};
const ROUTE: RouteEntry = {
  pathname: '/',
  status: 200,
  shell: {
    sha256: '0'.repeat(64),
    byteLength: 12,
    contentType: 'text/html; charset=utf-8',
    encoding: 'identity',
  },
  headers: { 'content-type': 'text/html; charset=utf-8' },
};

function file(seed: string, headers?: Readonly<Record<string, string>>): StaticFileEntry {
  return {
    sha256: seed.repeat(64),
    byteLength: 10,
    contentType: 'text/plain',
    immutable: false,
    ...(headers !== undefined && { headers }),
  };
}

function site(staticFiles: Record<string, StaticFileEntry>) {
  return buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: OBSERVED_AT,
    originHost: 'site.example',
    deployment: { assetSetHash: 'h', observedAt: OBSERVED_AT },
    routes: [ROUTE],
    app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
    staticFiles,
  });
}

const FILES = site({
  '/a.txt': file('a', POLICY),
  '/b.txt': file('b', POLICY),
  '/c.txt': file('c', { 'x-frame-options': 'DENY' }),
  '/d.txt': file('d'),
});

interface Stored {
  readonly schemaVersion: number;
  readonly staticFileHeaders?: true;
  readonly tables: { readonly headers: readonly unknown[] };
  readonly staticFiles: Record<string, Record<string, unknown>>;
}

const PLAIN = site({ '/a.txt': file('a'), '/d.txt': file('d') });

describe("a shipped file's stored headers", () => {
  it('read back as built, beside a file that has none', () => {
    expect(parseProjectManifest(serializeManifest(FILES))).toStrictEqual(FILES);
  });

  it('are held once, in the table the routes name their headers from', () => {
    const stored = JSON.parse(serializeManifest(FILES)) as Stored;

    // The route's headers first, then the files' two sets in the order the files are listed in.
    expect(stored.tables.headers).toStrictEqual([
      ROUTE.headers,
      POLICY,
      { 'x-frame-options': 'DENY' },
    ]);
    expect(stored.staticFiles['/a.txt']?.['headers']).toBe(1);
    expect(stored.staticFiles['/b.txt']?.['headers']).toBe(1);
    expect(stored.staticFiles['/c.txt']?.['headers']).toBe(2);
    expect(stored.staticFiles['/d.txt']).not.toHaveProperty('headers');
    expect(serializeManifest(FILES).split('nosniff')).toHaveLength(2);
  });

  /** The edge's own reading, which takes a digest for the schema (`vouchedManifest`). */
  it('are one object for every file sharing them, read without the schema', () => {
    const read = fromStoredManifest(JSON.parse(serializeManifest(FILES))) as typeof FILES;

    expect(read.staticFiles?.['/a.txt']?.headers).toStrictEqual(POLICY);
    expect(read.staticFiles?.['/a.txt']?.headers).toBe(read.staticFiles?.['/b.txt']?.headers);
  });

  /**
   * The manifest says its files name headers by place (`staticFileHeaders`), which is all its reading
   * asks before it looks at a file: one that does not say so — whose files store none — has not one
   * of its files looked at, nor copied. A place left on such a file, which no writer leaves, is not
   * even seen, which is how this shows the files were not read.
   */
  it('are said to be there by the manifest, and its files unread where it does not say so', () => {
    const stored = JSON.parse(serializeManifest(FILES)) as Stored;
    const plain = JSON.parse(serializeManifest(PLAIN)) as Stored;
    plain.staticFiles['/a.txt'] = { ...plain.staticFiles['/a.txt'], headers: 9 };

    const read = fromStoredManifest(plain) as { readonly staticFiles: unknown };

    expect(stored.staticFileHeaders).toBe(true);
    expect(plain).not.toHaveProperty('staticFileHeaders');
    expect(read.staticFiles).toBe(plain.staticFiles);
  });

  /**
   * Not a schema version: a reader from before the field reads a manifest with it as it read one
   * without. Every object of a manifest drops a key it does not name rather than refusing it, as
   * the manifest and the entry do here a key no reader yet names — so a reader before them drops the
   * word and the files' places alike — and the edge's reading without the schema puts back only what
   * it knows, leaving a place no code of such a reader looks at.
   */
  it('need no version a reader from before them does not read', () => {
    const stored = JSON.parse(serializeManifest(FILES)) as Stored;
    const entry = { ...file('a'), notYetNamed: 3 };
    const unknown = JSON.stringify({ ...JSON.parse(serializeManifest(PLAIN)), notYetNamed: true });

    expect(stored.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(staticFileEntrySchema.parse(entry)).toStrictEqual(file('a'));
    expect(parseProjectManifest(unknown)).toStrictEqual(PLAIN);
  });

  /** A manifest whose files carry none stores its files as they are, byte for byte as before. */
  it('leave a manifest without any as it was stored', () => {
    const stored = JSON.parse(serializeManifest(PLAIN)) as Stored;

    expect(stored.staticFiles).toStrictEqual(PLAIN.staticFiles);
    expect(stored.tables.headers).toStrictEqual([ROUTE.headers]);
    expect(stored).not.toHaveProperty('staticFileHeaders');
  });

  /** One that carries them without saying so, which no build writes, keeps them where they are. */
  it('stay on the file in a manifest that does not say it has them', () => {
    const unsaid = { ...FILES };
    delete unsaid.staticFileHeaders;
    const stored = JSON.parse(serializeManifest(unsaid)) as Stored;

    expect(stored.staticFiles['/a.txt']?.['headers']).toStrictEqual(POLICY);
    expect(stored.tables.headers).toStrictEqual([ROUTE.headers]);
    expect(parseProjectManifest(serializeManifest(unsaid))).toStrictEqual(unsaid);
  });

  /**
   * The set a file's spelling under the asset prefix is given where it differs from its own name's
   * (`assetPrefixHeaders`) is held in the same table, after the file's own, and read back as built —
   * and a manifest says its files store headers for a file that stores only that one.
   */
  it("hold a file's prefixed spelling's set in the same table", () => {
    const own = { 'x-canonical': 'yes' };
    const prefixed = { 'x-prefixed': 'yes' };
    const two = site({
      '/_next/static/a.js': { ...file('a', own), assetPrefixHeaders: prefixed },
      '/_next/static/b.js': { ...file('b'), assetPrefixHeaders: {} },
    });
    const stored = JSON.parse(serializeManifest(two)) as Stored;

    expect(two.staticFileHeaders).toBe(true);
    expect(stored.tables.headers).toStrictEqual([ROUTE.headers, own, prefixed, {}]);
    expect(stored.staticFiles['/_next/static/a.js']).toMatchObject({
      headers: 1,
      assetPrefixHeaders: 2,
    });
    expect(stored.staticFiles['/_next/static/b.js']).toMatchObject({ assetPrefixHeaders: 3 });
    expect(parseProjectManifest(serializeManifest(two))).toStrictEqual(two);
  });

  it('refuse a file that names a place its table does not hold', () => {
    const stored = JSON.parse(serializeManifest(FILES)) as Stored;
    stored.staticFiles['/a.txt'] = { ...stored.staticFiles['/a.txt'], headers: 9 };

    expect(() => fromStoredManifest(stored)).toThrow(/headers 9/u);
  });
});
