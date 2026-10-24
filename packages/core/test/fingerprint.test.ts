import { describe, expect, it } from 'vitest';

import {
  BUILD_ID_SCAN_LIMIT,
  compareFingerprints,
  extractBuildIdFromContinuation,
  extractShellFingerprint,
  fingerprintId,
} from '../src/deployment/fingerprint.ts';
import { concatBytes, decodeUtf8, encodeUtf8 } from '../src/util/bytes.ts';
import { buildPprDocument } from './fixtures/partial-prerender-document.ts';

const OBSERVED_AT = '2026-09-15T00:00:00.000Z';
const KIB = 1024;

function inlineFlight(...chunks: string[]): Uint8Array {
  return encodeUtf8(
    chunks
      .map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk)}])</script>`)
      .join(''),
  );
}

function rawFlight(row: string): Uint8Array {
  return encodeUtf8(row);
}

describe('extractShellFingerprint', () => {
  it('reads the deployment id from the html attribute', async () => {
    const document = buildPprDocument({ dplId: 'dpl_123' });
    const fingerprint = await extractShellFingerprint({
      shell: document.shell,
      observedAt: OBSERVED_AT,
    });

    expect(fingerprint.dplId).toBe('dpl_123');
    expect(fingerprint.assetSetHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('hashes the referenced asset set deterministically', async () => {
    const a = await extractShellFingerprint({
      shell: buildPprDocument().shell,
      observedAt: OBSERVED_AT,
    });
    const b = await extractShellFingerprint({
      shell: buildPprDocument({ staticText: 'other' }).shell,
      observedAt: OBSERVED_AT,
    });

    expect(a.dplId).toBeUndefined();
    expect(a.assetSetHash).toBe(b.assetSetHash);
  });

  /**
   * The flight data repeats every asset URL escaped, as `\"/_next/static/…\"`. Reading the
   * backslash as part of the path makes one asset look like two, and the same document then
   * fingerprints differently depending on how much of its flight data was read.
   */
  it('reads an escaped reference as the same asset as the plain one', async () => {
    const plain = '<html><body><link href="/_next/static/immutable/chunks/a.css"/></body></html>';
    // The same URL as the flight data writes it, where every quote is escaped.
    const inFlight = String.raw`<script>self.__next_f.push([1,'\"/_next/static/immutable/chunks/a.css\"'])</script>`;
    const escaped = `${plain}${inFlight}`;
    const one = await extractShellFingerprint({
      shell: encodeUtf8(plain),
      observedAt: OBSERVED_AT,
    });
    const both = await extractShellFingerprint({
      shell: encodeUtf8(escaped),
      observedAt: OBSERVED_AT,
    });

    expect(both.assetSetHash).toBe(one.assetSetHash);
  });

  it('falls back to the response header for the deployment id', async () => {
    const headers = new Headers({ 'x-nextjs-deployment-id': 'dpl_header' });
    const fingerprint = await extractShellFingerprint({
      shell: buildPprDocument().shell,
      responseHeaders: headers,
      observedAt: OBSERVED_AT,
    });

    expect(fingerprint.dplId).toBe('dpl_header');
  });

  /**
   * Skew Protection names the deployment on every asset reference too, as `?dpl=`: a tag that does
   * not carry the attribute still has the id beside it.
   */
  it('reads the deployment id off an asset reference when the tag carries none', async () => {
    const html = '<html><head><script src="/_next/static/chunks/a.js?dpl=dpl_query"></script>';
    const fingerprint = await extractShellFingerprint({
      shell: encodeUtf8(html),
      observedAt: OBSERVED_AT,
    });

    expect(fingerprint.dplId).toBe('dpl_query');
  });

  /**
   * A `?dpl=` counts on a reference's own path and nowhere before it. Where a `?` ended the URL's
   * authority first, everything after it is that URL's query — written by whoever wrote the page,
   * about something else — however much of it reads like `/_next/static/`.
   */
  it('reads no deployment id from a query that ended the authority first', async () => {
    const forged = [
      '<img src="https://cdn.example?dpl=dpl_forged/_next/static/media/a.png">',
      '<script src="https://cdn.example?next=/_next/static/chunks/a.js?dpl=dpl_forged"></script>',
    ].join('');
    const real = '<script src="/_next/static/chunks/b.js?dpl=dpl_real"></script>';
    const headers = new Headers({ 'x-nextjs-deployment-id': 'dpl_header' });
    const behind = await extractShellFingerprint({
      shell: encodeUtf8(`<html><body>${forged}${real}`),
      observedAt: OBSERVED_AT,
    });
    const alone = await extractShellFingerprint({
      shell: encodeUtf8(`<html><body>${forged}`),
      responseHeaders: headers,
      observedAt: OBSERVED_AT,
    });

    expect(behind.dplId).toBe('dpl_real');
    expect(alone.dplId).toBe('dpl_header');
  });

  /**
   * Each `<html` is read to the end of its own tag, and the next is looked for after it: one inside
   * a script's string has no say over the document's own.
   */
  it('reads the attribute off the tag that carries it, past one that does not', async () => {
    const html = '<script>const shell = "<html>";</script><html lang="en" data-dpl-id="dpl_attr">';
    const fingerprint = await extractShellFingerprint({
      shell: encodeUtf8(html),
      observedAt: OBSERVED_AT,
    });

    expect(fingerprint.dplId).toBe('dpl_attr');
  });
});

describe('extractBuildIdFromContinuation', () => {
  const transports = [rawFlight, inlineFlight];

  it('reads the build id from the inlined flight row', () => {
    const document = buildPprDocument({ buildId: 'Bu1ldId_-99' });

    expect(extractBuildIdFromContinuation(document.suffix)).toBe('Bu1ldId_-99');
    expect(extractBuildIdFromContinuation(document.shell)).toBeUndefined();
  });

  /**
   * The parser scans a whole document, so it must distinguish the flight row's root property from
   * the application's own data. Taking application data as the deployment's
   * identity makes every later comparison a comparison against nothing.
   */
  it('ignores an application property called b', () => {
    const document = buildPprDocument({ buildId: 'Bu1ldId_-99' });
    const decoy = encodeUtf8('<script>window.__data={"b":"abcdef123456"}</script>');
    const full = concatBytes([document.shell, decoy, document.suffix]);

    expect(extractBuildIdFromContinuation(full)).toBe('Bu1ldId_-99');
    expect(extractBuildIdFromContinuation(decoy)).toBeUndefined();
  });

  /**
   * `resolveOrigin` and the monitor's fingerprint probe pass a whole document, where the row sits
   * wherever the shell ends. Scanning only the first window would leave `buildId` undefined for a
   * large shell, and a server-only deploy that reuses its client assets would compare as unchanged.
   */
  it('finds the row past a shell larger than one scan window', () => {
    const document = buildPprDocument({ buildId: 'Bu1ldId_-99' });
    const padding = encodeUtf8(`<!--${'x'.repeat(200 * KIB)}-->`);
    const full = concatBytes([document.shell, padding, document.suffix]);

    expect(extractBuildIdFromContinuation(full)).toBe('Bu1ldId_-99');
  });

  /**
   * `generateBuildId` returns whatever the app asked for: a version string with dots, a short tag,
   * a long hash. An id the parser cannot read leaves the deployment identified by its asset set
   * alone — which a server-only deploy leaves untouched, so the shell from before it keeps serving.
   */
  it.each(['v1.2.3', 'rc', 'build+2026.09.16', 'a'.repeat(100)])(
    'reads a custom build id (%s)',
    (buildId) => {
      const document = buildPprDocument({ buildId });

      expect(extractBuildIdFromContinuation(document.suffix)).toBe(buildId);
    },
  );

  it('finds a row that straddles a window boundary', () => {
    const document = buildPprDocument({ buildId: 'Bu1ldId_-99' });
    // Split the id itself across the first window boundary, where a scan without overlapping
    // windows sees only half of it on either side. The fixture is ASCII, so index is byte offset.
    const idOffset = decodeUtf8(document.suffix).indexOf('Bu1ldId_-99');
    const padSize = 64 * KIB - document.shell.byteLength - idOffset - 4;
    const full = concatBytes([document.shell, encodeUtf8('y'.repeat(padSize)), document.suffix]);

    expect(extractBuildIdFromContinuation(full)).toBe('Bu1ldId_-99');
  });

  it.each(transports)(
    'reads the Next.js 16.3 build id after a large nested route tree (%s)',
    (encode) => {
      const root = {
        P: null,
        f: [[{ children: ['products', { b: 'product-code', text: 'x'.repeat(4500) }] }]],
        G: ['$1', []],
        b: 'current-build',
      };
      const bytes = encode(`1:I[123,[],"default"]\n0:${JSON.stringify(root)}\n`);

      expect(extractBuildIdFromContinuation(bytes)).toBe('current-build');
    },
  );

  it.each(transports)('ignores nested build-id names and other Flight rows (%s)', (encode) => {
    const root = { f: [[{ b: 'application-data', text: '0:{"b":"not-a-row"}' }]], G: [] };
    const bytes = encode(`10:{"b":"other-row"}\n0:${JSON.stringify(root)}\n1:{"b":"later-row"}\n`);

    expect(extractBuildIdFromContinuation(bytes)).toBeUndefined();
  });

  it('does not interpret page text as raw Flight when scanning HTML', () => {
    const html = encodeUtf8('<html><body><pre>\n0:{"b":"example-build"}\n</pre>');
    const flight = inlineFlight('0:{"b":"actual-build"}\n');

    expect(extractBuildIdFromContinuation(concatBytes([html, flight]))).toBe('actual-build');
    expect(extractBuildIdFromContinuation(html)).toBeUndefined();
  });

  it.each(transports)('decodes JSON escapes in a custom build id (%s)', (encode) => {
    const buildId = 'release-"quoted"\\日本語-😀\n';
    const bytes = encode(
      `0:${JSON.stringify({ f: [[{ text: '}],"b":"nested"' }]], b: buildId })}\n`,
    );

    expect(extractBuildIdFromContinuation(bytes)).toBe(buildId);
  });

  it('decodes Unicode escapes in both the root property and the inline transport', () => {
    const row = String.raw`0:{"f":[[{"b":"nested"}]],"\u0062":"release-\u65e5\u672c-<tag>"}`;
    const html = decodeUtf8(inlineFlight(row)).replaceAll('<tag>', String.raw`\u003ctag\u003e`);

    expect(extractBuildIdFromContinuation(encodeUtf8(html))).toBe('release-日本-<tag>');
  });

  it('joins a root row split across inline scripts, including its key and escaped value', () => {
    const buildId = String.raw`release-"one"\two-😀`;
    const row = `0:${JSON.stringify({ f: [[{ b: 'nested' }]], b: buildId })}\n`;
    // Split every UTF-16 unit, including surrogate pairs and the halves of each JSON escape.
    const chunks = Array.from({ length: row.length }, (_, index) => row.slice(index, index + 1));
    const bytes = inlineFlight(...chunks);

    expect(extractBuildIdFromContinuation(bytes)).toBe(buildId);
  });

  it.each(transports)('skips nested values larger than the decode window (%s)', (encode) => {
    const bytes = encode(
      `0:${JSON.stringify({ f: [{ text: 'x'.repeat(3 * BUILD_ID_SCAN_LIMIT) }], b: 'late-build' })}\n`,
    );

    expect(extractBuildIdFromContinuation(bytes)).toBe('late-build');
    // The edge still fails closed when the marker is absent from its bounded admission prefix.
    expect(extractBuildIdFromContinuation(bytes.subarray(0, BUILD_ID_SCAN_LIMIT))).toBeUndefined();
  });

  it('preserves UTF-8 characters split by the decode window', () => {
    const data = inlineFlight(`0:${JSON.stringify({ b: '日本語-build' })}\n`);
    const firstCharacter = decodeUtf8(data).indexOf('日本語');
    const padding = `<!--${'x'.repeat(BUILD_ID_SCAN_LIMIT - firstCharacter - 8)}-->`;
    const bytes = concatBytes([encodeUtf8(padding), data]);

    expect(extractBuildIdFromContinuation(bytes)).toBe('日本語-build');
  });

  it.each(transports)('does not accept an incomplete or non-string build id (%s)', (encode) => {
    expect(extractBuildIdFromContinuation(encode('0:{"f":[],"b":"unfinished'))).toBeUndefined();
    expect(extractBuildIdFromContinuation(encode('0:{"b":{"b":"nested"}}\n'))).toBeUndefined();
    expect(extractBuildIdFromContinuation(encode('0:{"b":123}\n'))).toBeUndefined();
    expect(extractBuildIdFromContinuation(encode('0:{"b":""}\n'))).toBeUndefined();
  });

  it.each(transports)('bounds memory retained for a build-id string (%s)', (encode) => {
    const bytes = encode(`0:${JSON.stringify({ b: 'x'.repeat(BUILD_ID_SCAN_LIMIT + 1) })}\n`);

    expect(extractBuildIdFromContinuation(bytes)).toBeUndefined();
  });
});

describe('compareFingerprints', () => {
  /**
   * The asset set is the weakest evidence there is: a server-only deployment reuses every client
   * asset. Falling back to it when an expected id has gone missing would report an unidentifiable
   * response as proof that nothing changed, and activate a shell from before that deployment.
   */
  it('refuses to fall back to the asset set when a marker went missing', () => {
    const assets = { assetSetHash: 'same', observedAt: OBSERVED_AT };

    expect(compareFingerprints({ ...assets, dplId: 'dpl_1' }, assets)).toStrictEqual({
      equal: false,
      via: 'dpl',
    });
    expect(compareFingerprints({ ...assets, buildId: 'Bu1ldId_-99' }, assets)).toStrictEqual({
      equal: false,
      via: 'buildId',
    });
    // And the other way: an origin that starts carrying one is not the deployment that did not.
    expect(compareFingerprints(assets, { ...assets, dplId: 'dpl_1' })).toStrictEqual({
      equal: false,
      via: 'dpl',
    });
  });

  it('prefers deployment ids, then build ids, then asset sets', () => {
    const base = { assetSetHash: 'a', observedAt: OBSERVED_AT };

    expect(
      compareFingerprints(
        { ...base, dplId: '1', buildId: 'x' },
        { ...base, dplId: '1', buildId: 'y' },
      ),
    ).toStrictEqual({ equal: true, via: 'dpl' });
    expect(compareFingerprints({ ...base, buildId: 'x' }, { ...base, buildId: 'y' })).toStrictEqual(
      { equal: false, via: 'buildId' },
    );
    expect(compareFingerprints(base, { ...base, assetSetHash: 'b' })).toStrictEqual({
      equal: false,
      via: 'assetSet',
    });
    expect(fingerprintId(base)).toBe('assets:a');
    expect(fingerprintId({ ...base, buildId: 'x' })).toBe('x');
  });
});
