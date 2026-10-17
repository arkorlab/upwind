import type { EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import { handleStandalone, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

const FILE = '/manual.txt';
const BODY = 'the shipped manual';
/** When a rule of `next.config` says the dated file was last modified. */
const LAST_MODIFIED = 'Tue, 15 Nov 1994 12:45:26 GMT';
const DAY_BEFORE = 'Mon, 14 Nov 1994 12:45:26 GMT';
const DAY_AFTER = 'Wed, 16 Nov 1994 12:45:26 GMT';

/** What a standalone edge, its pointer pinned and its files in `bucket`, answers a request with. */
async function serve(
  pointer: EdgePointer,
  path: string,
  init: RequestInit = {},
  bucket: R2Bucket = env.ARTIFACTS,
): Promise<{ readonly response: Response; readonly body: string }> {
  const site = { ...env, POINTER: JSON.stringify(pointer), ARTIFACTS: bucket };
  const ctx = createExecutionContext();
  const runtime = standaloneRuntime(site, { memory: createEdgeMemory(() => Date.now()) });
  const response = await handleStandalone(navigation(path, init), site, ctx, runtime);
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

/** A site shipping `files`, and the entity tag each is answered under. */
async function shipping(
  files: Readonly<Record<string, string>>,
  headerRules?: SiteOptions['headerRules'],
): Promise<{ readonly pointer: EdgePointer; readonly tagOf: (path: string) => string }> {
  const { manifest, pointer } = await seedSite({ document: pprDocument(), files, headerRules });
  return { pointer, tagOf: (path) => `"${manifest.staticFiles?.[path]?.sha256 ?? ''}"` };
}

/** The real bucket, writing down the key of every object read from it. */
function recordingBucket(keys: string[]): R2Bucket {
  const bucket = {
    get: (key: string, options?: R2GetOptions) => {
      keys.push(key);
      return env.ARTIFACTS.get(key, options);
    },
  };
  return bucket as unknown as R2Bucket;
}

/**
 * The edge is a shipped file's origin, as Next.js's file server is (`send`): a precondition the file
 * fails is answered 412 before anything else the request asks is judged (RFC 9110 §13.2.2), rather
 * than with the file — or a part of it a client resuming a download would splice onto another's
 * bytes (Codex, upwind#179).
 */
describe('a shipped file asked under a precondition', () => {
  it('answers 412 to an If-Match naming another entity, whatever else the request asks', async () => {
    const { pointer, tagOf } = await shipping({ [FILE]: BODY });
    const ask = (headers: Record<string, string>, method = 'GET') =>
      serve(pointer, FILE, { method, headers });

    const answers = [
      await ask({ 'if-match': '"another"' }),
      await ask({ 'if-match': '"another"', range: 'bytes=0-3' }),
      await ask({ 'if-match': '"another"', 'if-none-match': tagOf(FILE) }),
      await ask({ 'if-match': '"another"' }, 'HEAD'),
    ];

    for (const { response, body } of answers) {
      expect([response.status, body]).toStrictEqual([412, '']);
      expect(response.headers.get('etag')).toBe(tagOf(FILE));
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.has('content-length')).toBe(false);
    }
  });

  it('serves the file to an If-Match naming it, weakly or with `*`, and a range of it', async () => {
    const { pointer, tagOf } = await shipping({ [FILE]: BODY });
    const ask = (headers: Record<string, string>) => serve(pointer, FILE, { headers });

    const answers = [
      await ask({ 'if-match': tagOf(FILE) }),
      await ask({ 'if-match': `"another", W/${tagOf(FILE)}` }),
      await ask({ 'if-match': '*' }),
      await ask({ 'if-match': '' }),
    ];
    const resumed = await ask({ 'if-match': tagOf(FILE), range: 'bytes=4-10' });

    for (const { response, body } of answers) {
      expect([response.status, body]).toStrictEqual([200, BODY]);
    }

    expect([resumed.response.status, resumed.body]).toStrictEqual([206, 'shipped']);
  });

  it('judges If-Unmodified-Since by a Last-Modified the answer carries, and only without If-Match', async () => {
    const { pointer, tagOf } = await shipping(
      { '/dated.txt': 'dated', '/undated.txt': 'undated' },
      [{ sourceRegex: String.raw`^/dated\.txt$`, headers: { 'last-modified': LAST_MODIFIED } }],
    );
    const ask = (path: string, headers: Record<string, string>) =>
      serve(pointer, path, { headers });

    const changed = await ask('/dated.txt', { 'if-unmodified-since': DAY_BEFORE });
    const unchanged = await ask('/dated.txt', { 'if-unmodified-since': LAST_MODIFIED });
    const undated = await ask('/undated.txt', { 'if-unmodified-since': DAY_BEFORE });
    const matched = await ask('/dated.txt', {
      'if-match': tagOf('/dated.txt'),
      'if-unmodified-since': DAY_BEFORE,
    });

    expect([changed.response.status, changed.body]).toStrictEqual([412, '']);
    expect([unchanged.response.status, unchanged.body]).toStrictEqual([200, 'dated']);
    expect([undated.response.status, undated.body]).toStrictEqual([200, 'undated']);
    expect([matched.response.status, matched.body]).toStrictEqual([200, 'dated']);
  });

  /**
   * A client that asks by date, with no `If-None-Match`, already holds a file whose `Last-Modified`
   * — a rule's here, storage keeping no date of its own — is no later than the date it names: it is
   * answered 304 from the manifest, as Next.js's file server answers it (`isFresh`), and nothing is
   * read from storage (greptile and Codex, upwind#179).
   */
  it('answers 304 to an If-Modified-Since a Last-Modified the answer carries meets, reading nothing', async () => {
    const { pointer, tagOf } = await shipping(
      { '/dated.txt': 'dated', '/undated.txt': 'undated' },
      [{ sourceRegex: String.raw`^/dated\.txt$`, headers: { 'last-modified': LAST_MODIFIED } }],
    );
    const keys: string[] = [];
    const bucket = recordingBucket(keys);
    const ask = (path: string, headers: Record<string, string>, method = 'GET') =>
      serve(pointer, path, { method, headers }, bucket);
    const fileReads = (): string[] => keys.filter((key) => key.startsWith('blobs/'));

    const held = [
      await ask('/dated.txt', { 'if-modified-since': LAST_MODIFIED }),
      await ask('/dated.txt', { 'if-modified-since': DAY_AFTER }),
      await ask('/dated.txt', { 'if-modified-since': LAST_MODIFIED }, 'HEAD'),
    ];
    const readForHeld = fileReads();
    const changed = await ask('/dated.txt', { 'if-modified-since': DAY_BEFORE });
    const undated = await ask('/undated.txt', { 'if-modified-since': DAY_AFTER });
    const tagged = await ask('/dated.txt', {
      'if-none-match': '"another"',
      'if-modified-since': LAST_MODIFIED,
    });

    for (const { response, body } of held) {
      expect([response.status, body]).toStrictEqual([304, '']);
      expect(response.headers.get('etag')).toBe(tagOf('/dated.txt'));
      expect(response.headers.get('last-modified')).toBe(LAST_MODIFIED);
    }

    expect(readForHeld).toStrictEqual([]);
    expect([changed.response.status, changed.body]).toStrictEqual([200, 'dated']);
    expect([undated.response.status, undated.body]).toStrictEqual([200, 'undated']);
    // A client that names the tags it holds is judged by them alone (RFC 9110 §13.1.3).
    expect([tagged.response.status, tagged.body]).toStrictEqual([200, 'dated']);
  });

  /**
   * A client resuming a download by date is given the range where the date is the `Last-Modified`
   * the answer carries — a rule's here, storage keeping no date of its own — in whichever form it
   * writes it, as RFC 9110 has an origin judge an `If-Range` date (§13.1.5) and as Next.js's file
   * server resumes on it too (`isRangeFresh`, in `send`). Any other date, one that is no date, or a
   * file no rule dates, is answered whole (Codex, upwind#179).
   */
  it('resumes a range on an If-Range naming the Last-Modified the answer carries', async () => {
    const { pointer } = await shipping(
      { '/dated.txt': 'dated file', '/undated.txt': 'undated file' },
      [{ sourceRegex: String.raw`^/dated\.txt$`, headers: { 'last-modified': LAST_MODIFIED } }],
    );
    const ask = (path: string, ifRange: string) =>
      serve(pointer, path, { headers: { range: 'bytes=0-4', 'if-range': ifRange } });

    const resumed = [
      await ask('/dated.txt', LAST_MODIFIED),
      await ask('/dated.txt', 'Tue Nov 15 12:45:26 1994'),
    ];
    const whole = [
      await ask('/dated.txt', DAY_BEFORE),
      await ask('/dated.txt', DAY_AFTER),
      await ask('/dated.txt', 'yesterday'),
      await ask('/undated.txt', LAST_MODIFIED),
    ];

    for (const { response, body } of resumed) {
      expect([response.status, body]).toStrictEqual([206, 'dated']);
      expect(response.headers.get('content-range')).toBe('bytes 0-4/10');
    }

    expect(whole.map(({ response, body }) => [response.status, body])).toStrictEqual([
      [200, 'dated file'],
      [200, 'dated file'],
      [200, 'dated file'],
      [200, 'undated file'],
    ]);
  });

  /** An error document answers a request for something else, which judges no precondition (§13.2.1). */
  it('answers an error document whole, whatever If-Match the request carries', async () => {
    const { pointer } = await shipping({ '/404': '<p>not found</p>' });

    const { response, body } = await serve(pointer, '/404', {
      headers: { 'if-match': '"another"' },
    });

    expect([response.status, body]).toStrictEqual([404, '<p>not found</p>']);
  });
});
