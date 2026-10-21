import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildProjectManifest, type StaticFileEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CheckedStack } from '../src/answers.ts';
import { rangeFormsFailure, resumedRangeFailure } from '../src/ranges.ts';
import type { Reading } from '../src/reading.ts';

const AT = '2026-10-19T00:00:00.000Z';
const TEXT = 'text/plain';
const ORIGINAL = 'kept bytes';
const LONG = 'a'.repeat(256);
const CONTENTS: Readonly<Record<string, string>> = {
  '/a.txt': ORIGINAL,
  '/b.txt': 'another file',
  '/404': 'not here',
  '/418': 'no coffee',
  '/long.txt': LONG,
};

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function fileOf(body: string, status = 200): StaticFileEntry {
  return {
    sha256: digest(body),
    byteLength: Buffer.byteLength(body),
    contentType: TEXT,
    immutable: false,
    status,
  };
}

const ORIGINAL_FILE = fileOf(ORIGINAL);
const FILES: Readonly<Record<string, StaticFileEntry>> = {
  '/a.txt': ORIGINAL_FILE,
  '/b.txt': fileOf('another file'),
  '/404': fileOf('not here', 404),
  '/418': fileOf('no coffee', 418),
  '/long.txt': fileOf(LONG),
};

interface Reply {
  readonly etag?: string;
  readonly rewrite?: string;
  readonly partialOnMismatch?: boolean;
  readonly wholeStatus?: number;
  readonly wholeBody?: string;
  readonly corruptOpenEnded?: boolean;
}

const fixture = {
  reply: {} as Reply,
  origin: new URL('http://127.0.0.1'),
  bundleDir: '',
};
const requestedRanges: string[] = [];
const requestedValidators: (string | undefined)[] = [];

function capturedDecision(): { readonly status: number; readonly headers: string[][] } {
  const headers = [['x-middleware-next', '1']];
  if (fixture.reply.etag !== undefined) headers.push(['etag', fixture.reply.etag]);
  if (fixture.reply.rewrite !== undefined) {
    headers.push(['x-middleware-rewrite', fixture.reply.rewrite]);
  }
  return { status: 200, headers };
}

function answerBackstage(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ decision: capturedDecision(), regenerated: null }));
    return;
  }
  response.writeHead(204).end();
}

/** The selected bytes use the fixture's existing range language and framing. */
function answerPart(
  response: ServerResponse,
  range: string,
  bytes: Buffer,
  headers: Readonly<Record<string, string>>,
): void {
  const [, first = '', last = ''] = /^bytes=(\d*)-(\d*)$/u.exec(range) ?? [];
  const start = first === '' ? Math.max(0, bytes.length - Number(last)) : Number(first);
  const end = last === '' || first === '' ? bytes.length - 1 : Number(last);
  const part = Buffer.from(bytes.subarray(start, end + 1));
  if (range === 'bytes=1-' && fixture.reply.corruptOpenEnded === true) {
    part[100] = 0x58;
  }
  response.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${bytes.length}`,
    'content-length': part.length,
  });
  response.end(part);
}

/** The HTTP fixture implements the independently specified strong If-Range selection. */
function answerFile(request: IncomingMessage, response: ServerResponse): void {
  const pathname = fixture.reply.rewrite ?? new URL(request.url ?? '/', fixture.origin).pathname;
  const file = FILES[pathname];
  const content = CONTENTS[pathname];
  if (file === undefined || content === undefined) throw new Error('unknown fixture file');
  const tag = fixture.reply.etag ?? `"${file.sha256}"`;
  const range = request.headers.range ?? '';
  const received = request.headers['if-range'];
  const validator = Array.isArray(received) ? received.join(',') : received;
  requestedRanges.push(range);
  requestedValidators.push(validator);
  const mismatch =
    validator !== undefined &&
    (validator !== tag || validator.startsWith('W/') || tag.startsWith('W/'));
  const bytes = Buffer.from(fixture.reply.wholeBody ?? content);
  const headers = {
    'content-type': TEXT,
    'cache-control': 'private, max-age=0, must-revalidate',
    'accept-ranges': file.status === 200 ? 'bytes' : 'none',
    etag: tag,
    'x-arkor-edge': 'static;src=bucket;policy=default;mw=hit',
  };
  if (file.status === 200 && (!mismatch || fixture.reply.partialOnMismatch === true)) {
    answerPart(response, range, bytes, headers);
    return;
  }
  response.writeHead(fixture.reply.wholeStatus ?? file.status ?? 200, {
    ...headers,
    'content-length': bytes.length,
  });
  response.end(bytes);
}

const server = createServer((request, response) => {
  if (request.url?.startsWith('/_backstage/') === true) {
    answerBackstage(request, response);
    return;
  }
  answerFile(request, response);
});

function stackOf(): CheckedStack {
  const site = new URL('https://site.example');
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    generatedAt: AT,
    originHost: site.hostname,
    deployment: { assetSetHash: digest('assets'), observedAt: AT },
    app: { deploymentId: 'dpl_site', scriptName: 'app', middlewareScriptName: 'app' },
    routes: [],
    staticFiles: { ...FILES },
  });
  return {
    url: fixture.origin,
    site,
    backstage: new URL('/_backstage/', fixture.origin),
    functions: [],
    bundleDir: fixture.bundleDir,
    deploymentId: 'dpl_site',
    manifest,
    app: manifest.app,
    policy: { ...DEFAULT_DELIVERY_POLICY, id: 'default' },
    cspNonce: undefined,
    dispose: () => Promise.resolve(),
    bundle: {
      v: 1,
      deploymentId: 'dpl_site',
      nextVersion: '16.4.2',
      buildId: 'build',
      projectDir: '.',
      generatedAt: AT,
      config: {
        basePath: '',
        trailingSlash: false,
        skipTrailingSlashRedirect: true,
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
          header: 'rsc',
          varyHeader: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          didPostponeHeader: 'x-nextjs-postponed',
          contentTypeHeader: 'text/x-component',
          suffix: '.rsc',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
          prefetchSegmentSuffix: '.segment.rsc',
          prefetchSegmentDirSuffix: '.segments',
        },
      },
      entrypoints: [],
      prerenders: [],
      staticFiles: [],
      middleware: { matchers: [{ sourceRegex: '^.*$' }] },
      functions: {
        app: {
          mainModule: 'index.mjs',
          modules: [],
          compatibilityDate: AT.slice(0, 10),
          compatibilityFlags: [],
        },
      },
    },
  };
}

function wholeAnswer(text = ORIGINAL): Reading {
  const body = Buffer.from(text);
  return {
    status: 200,
    headers: {},
    length: body.length,
    sha256: digest(text),
    head: body,
    tail: body,
    marked: false,
    truncated: false,
  };
}

async function resumed(): Promise<string | undefined> {
  const stack = stackOf();
  return resumedRangeFailure(stack, new URL('/a.txt', stack.site), {
    file: ORIGINAL_FILE,
    headers: {},
    answer: wholeAnswer(),
    etag: `"${ORIGINAL_FILE.sha256}"`,
  });
}

async function forms(pathname = '/a.txt'): Promise<string | undefined> {
  const stack = stackOf();
  const file = FILES[pathname];
  const text = CONTENTS[pathname];
  if (file === undefined || text === undefined) throw new Error('unknown range subject');
  return rangeFormsFailure(stack, new URL(pathname, stack.site), {
    file,
    headers: {},
    answer: wholeAnswer(text),
  });
}

const LARGE_REQUESTS = [
  {
    name: 'original',
    pathname: '/long.txt',
    reply: {},
    ranges: ['bytes=-64', 'bytes=1-'],
  },
  {
    name: 'rewritten',
    pathname: '/a.txt',
    reply: { rewrite: '/long.txt' },
    ranges: ['bytes=-10', 'bytes=1-'],
  },
];

describe('range follow-ups select the representation of their own request', () => {
  beforeAll(async () => {
    fixture.bundleDir = mkdtempSync(path.join(tmpdir(), 'upwind-range-followups-'));
    mkdirSync(path.join(fixture.bundleDir, 'blobs'));
    for (const body of Object.values(CONTENTS)) {
      writeFileSync(path.join(fixture.bundleDir, 'blobs', digest(body)), body);
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no fixture socket');
    fixture.origin = new URL(`http://127.0.0.1:${String(address.port)}`);
  });

  beforeEach(() => {
    fixture.reply = {};
    requestedRanges.length = 0;
    requestedValidators.length = 0;
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
    rmSync(fixture.bundleDir, { recursive: true, force: true });
  });

  it('accepts the whole file when middleware changes the strong tag', async () => {
    fixture.reply = { etag: '"next-tag"' };
    const failure = await resumed();

    expect(failure).toBeUndefined();
    expect(requestedValidators).toStrictEqual([`"${ORIGINAL_FILE.sha256}"`]);
  });

  it('rejects a partial response on a tag that no longer matches', async () => {
    fixture.reply = { etag: '"next-tag"', partialOnMismatch: true };
    const failure = await resumed();

    expect(failure).toContain('answered 206, not 200');
  });

  it('still verifies the whole body when a changed tag requires it', async () => {
    fixture.reply = { etag: '"next-tag"', wholeBody: 'wrong body' };
    const failure = await resumed();

    expect(failure).toContain('bytes other than its own');
  });

  it('accepts a whole different file selected by a follow-up rewrite', async () => {
    fixture.reply = { rewrite: '/b.txt' };
    const failure = await resumed();

    expect(failure).toBeUndefined();
  });

  it('does not resume on a weak tag selected by middleware', async () => {
    fixture.reply = { etag: `W/"${ORIGINAL_FILE.sha256}"` };
    const failure = await resumed();

    expect(failure).toBeUndefined();
  });

  it('keeps requiring and validating a partial response on the matching strong tag', async () => {
    const failure = await resumed();

    expect(failure).toBeUndefined();
    expect(requestedRanges).toStrictEqual(['bytes=1-9']);
  });

  it.each(['/404', '/418'])(
    'accepts the whole error file %s for both suffix and open-ended rewrites',
    async (rewrite) => {
      fixture.reply = { rewrite };
      const failure = await forms();

      expect(failure).toBeUndefined();
      expect(requestedRanges).toStrictEqual(['bytes=-10', 'bytes=1-']);
    },
  );

  it('rejects the wrong whole status after an error-file rewrite', async () => {
    fixture.reply = { rewrite: '/404', wholeStatus: 200 };
    const failure = await forms();

    expect(failure).toContain('answered 200, not 404');
  });

  it('rejects wrong whole bytes after an error-file rewrite', async () => {
    fixture.reply = { rewrite: '/404', wholeBody: 'wrong error body' };
    const failure = await forms();

    expect(failure).toContain('bytes other than its own');
  });

  it.each(LARGE_REQUESTS)('accepts the complete $name open-ended range', async (example) => {
    fixture.reply = example.reply;
    const failure = await forms(example.pathname);

    expect(failure).toBeUndefined();
    expect(requestedRanges).toStrictEqual(example.ranges);
  });

  it.each(LARGE_REQUESTS)('rejects corruption beyond the $name range prefix', async (example) => {
    fixture.reply = { ...example.reply, corruptOpenEnded: true };
    const failure = await forms(example.pathname);

    expect(failure).toContain("answered bytes=1- with other bytes than the file's");
    expect(requestedRanges).toStrictEqual(example.ranges);
  });
});
