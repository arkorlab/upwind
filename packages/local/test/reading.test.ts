import { createHash } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- what a browser accepts, zstd among it
import { brotliCompressSync, gzipSync, zstdCompressSync } from 'node:zlib';

import { RECOVERY_MARKER } from '@stayingupwind/core/request';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { undoneUnlessStored } from '../src/answers.ts';
import { read } from '../src/reading.ts';

/** A document streamed in pieces, its recovery marker split across two of them. */
const SPLIT_AT = 9;
const PIECES = [
  '<!DOCTYPE html><html><head></head><body><main>shell</main>',
  RECOVERY_MARKER.slice(0, SPLIT_AT),
  `${RECOVERY_MARKER.slice(SPLIT_AT)}<script>recover()</script>`,
  '</body></html>\n',
];
const DOCUMENT = PIECES.join('');
/** A body longer than a copy's way holds at once, which the copy has to wait to drain for. */
const LONG_PIECE = 'y'.repeat(64 * 1024);
const LONG_PIECES = 32;
const TRANSPORT_COOKIE = 'session=loopback-only';
const TRANSPORT_AUTHORIZATION = 'Bearer loopback-only';
const TRANSPORT_HOST = 'logical.example:443';

/** The actual socket that received a request, apart from the logical Host it carried. */
function transportVisit(request: IncomingMessage) {
  return {
    method: request.method,
    pathname: request.url,
    host: request.headers.host,
    cookie: request.headers.cookie,
    authorization: request.headers.authorization,
    port: request.socket.localPort,
  };
}

const viaVisits: ReturnType<typeof transportVisit>[] = [];
const otherVisits: ReturnType<typeof transportVisit>[] = [];
/** A second loopback authority makes a mistaken protocol-relative parse observable without DNS. */
const otherServer = createServer((request, response) => {
  otherVisits.push(transportVisit(request));
  response.end('other loopback authority');
});

function sha256Of(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The document in the codings an answer may name, the last applied last. */
const CODED: Readonly<Record<string, readonly [string, Buffer]>> = {
  '/br': ['br', brotliCompressSync(DOCUMENT)],
  '/gzip': ['gzip', gzipSync(DOCUMENT)],
  // As a browser asking for every coding at once may be answered by an application.
  '/zstd': ['zstd', zstdCompressSync(DOCUMENT)],
  // Brotli over brotli, as the edge layers a shell's own rendering under the rest of a document.
  '/layered': ['br, br', brotliCompressSync(brotliCompressSync(DOCUMENT))],
  // LZW, which no browser has undone in decades, nor the check.
  '/unknown': ['compress', Buffer.from(DOCUMENT)],
};

/** When the server's answer to `/unknown-open` was let go of: told `true`. */
const letGo = Promise.withResolvers<boolean>();
/** When its answer to `/corrupt-open`, in a coding of bytes that do not undo, was let go of. */
const corruptLetGo = Promise.withResolvers<boolean>();
/** Header-only answers send no body byte, and end only when the reader closes them. */
const headersClosed = new Map<string, () => void>();
const fullHeaders = Promise.withResolvers<true>();
const fullBody = {
  finish(): void {
    throw new Error('the delayed body fixture has not started');
  },
};

/** Header-only streams stay empty; the whole-body control ends only when its test releases it. */
function headerFixture(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.url?.startsWith('/headers-only-') === true) {
    response.writeHead(request.url.endsWith('redirect') ? 307 : 200, {
      location: '/plain',
      'set-cookie': 'seen=1; Path=/',
      'content-encoding': 'compress',
      'x-copy': '1',
    });
    response.on('close', () => {
      headersClosed.get(request.url ?? '')?.();
    });
    response.flushHeaders();
    return true;
  }
  if (request.url === '/full-after-headers') {
    response.writeHead(200);
    fullBody.finish = () => {
      response.end(DOCUMENT);
    };
    response.flushHeaders();
    return true;
  }
  return false;
}

/** The transport fixture takes precedence over the existing header-only fixtures. */
function responseFixture(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.headers['x-transport-test'] === '1') {
    viaVisits.push(transportVisit(request));
    response.end('via loopback authority');
    return true;
  }
  return headerFixture(request, response);
}

const server = createServer((request, response) => {
  if (responseFixture(request, response)) return;
  const coded = Object.hasOwn(CODED, request.url ?? '') ? CODED[request.url ?? ''] : undefined;
  if (coded !== undefined) {
    const [coding, bytes] = coded;
    response.writeHead(200, { 'content-encoding': coding, 'x-copy': '1' });
    response.end(bytes);
    return;
  }
  if (request.url === '/stored-br') {
    // A precompressed file of the build, served as stored: its bytes are its coded ones.
    response.writeHead(200, {
      'content-encoding': 'br',
      'x-arkor-edge': 'static;src=bucket;policy=default',
    });
    response.end(CODED['/br']?.[1]);
    return;
  }
  if (request.url === '/layered-broken') {
    // Brotli over brotli, its connection lost partway through the body, as a network fails.
    const [coding, bytes] = CODED['/layered'] ?? ['br, br', Buffer.alloc(0)];
    response.writeHead(200, { 'content-encoding': coding });
    response.write(bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
    setTimeout(() => {
      response.socket?.destroy();
    }, 20);
    return;
  }
  if (request.url === '/corrupt-open') {
    // Named gzip, and no gzip at all, in a body that never ends; told when it is let go of.
    response.writeHead(200, { 'content-encoding': 'gzip' });
    response.write('this is not gzip, and it goes on'.repeat(64));
    response.on('close', () => {
      corruptLetGo.resolve(true);
    });
    return;
  }
  if (request.url === '/unknown-open') {
    // A coding the check does not undo, in a body that never ends; told when it is let go of.
    response.writeHead(200, { 'content-encoding': 'compress' });
    response.write('x'.repeat(64));
    response.on('close', () => {
      letGo.resolve(true);
    });
    return;
  }
  if (request.url === '/plain') {
    response.end('<html><body>plain</body></html>');
    return;
  }
  if (request.url === '/copy') {
    // A copy's answer: what it was sent, by its digest and length.
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const sent = Buffer.concat(chunks);
      response.end(`${sha256Of(sent)} ${sent.byteLength}`);
    });
    return;
  }
  if (request.url === '/long') {
    response.writeHead(200, { 'x-copy': '1' });
    for (let piece = 0; piece < LONG_PIECES; piece += 1) {
      response.write(LONG_PIECE);
    }
    response.end();
    return;
  }
  if (request.url === '/endless') {
    // A stream that never ends, as a catch-all of an application's may answer with.
    response.write('x'.repeat(4096));
    return;
  }
  if (request.url === '/endless-copied') {
    response.writeHead(200, { 'x-copy': '1' });
    response.write('x'.repeat(4096));
    return;
  }
  response.writeHead(200, { 'x-copy': '1' });
  for (const piece of PIECES) {
    response.write(piece);
  }
  response.end();
});

describe('an answer read as it streams', () => {
  const state: { url?: URL; other?: URL } = {};

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    state.url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await new Promise<void>((resolve) => {
      otherServer.listen(0, '127.0.0.1', resolve);
    });
    state.other = new URL(`http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`);
  });

  beforeEach(() => {
    viaVisits.length = 0;
    otherVisits.length = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      otherServer.close(() => {
        resolve();
      });
    });
  });

  it.each(['/.//', '/..//', '/%2e//', '/%2e%2e//'])(
    'keeps a same-origin %s hop and its cookies on the selected via socket',
    async (prefix) => {
      const other = new URL('/', state.other);
      const url = new URL(
        `${prefix}${other.host}/kept%2Fpath?one=1&one=2&next=%2F%2Felsewhere#not-sent`,
        other,
      );
      const via = new URL('/discarded/base?discarded=1#discarded', state.url);
      const original = [url.href, via.href];
      const reading = await read(url, {
        via,
        headers: {
          host: TRANSPORT_HOST,
          cookie: TRANSPORT_COOKIE,
          authorization: TRANSPORT_AUTHORIZATION,
          'x-transport-test': '1',
        },
        deadlineMs: 5000,
      });

      expect(url.origin).toBe(other.origin);
      expect(url.pathname).toBe(`//${other.host}/kept%2Fpath`);
      expect(viaVisits).toStrictEqual([
        {
          method: 'GET',
          pathname: `//${other.host}/kept%2Fpath?one=1&one=2&next=%2F%2Felsewhere`,
          host: TRANSPORT_HOST,
          cookie: TRANSPORT_COOKIE,
          authorization: TRANSPORT_AUTHORIZATION,
          port: Number(via.port),
        },
      ]);
      expect(otherVisits).toStrictEqual([]);
      expect(reading.sha256).toBe(sha256Of('via loopback authority'));
      expect([url.href, via.href]).toStrictEqual(original);
    },
  );

  it('preserves a literal double-slash pathname without interpreting it as an authority', async () => {
    const other = new URL('/', state.other);
    const url = new URL('/before', other);
    url.pathname = `//${other.host}/literal`;
    url.search = '?next=%2F%2Felsewhere&empty=';
    const via = new URL('/discarded/base?discarded=1', state.url);
    const reading = await read(url, {
      via,
      headers: { cookie: TRANSPORT_COOKIE, 'x-transport-test': '1' },
      deadlineMs: 5000,
    });

    expect(viaVisits).toStrictEqual([
      {
        method: 'GET',
        pathname: `//${other.host}/literal?next=%2F%2Felsewhere&empty=`,
        host: via.host,
        cookie: TRANSPORT_COOKIE,
        authorization: undefined,
        port: Number(via.port),
      },
    ]);
    expect(otherVisits).toStrictEqual([]);
    expect(reading.sha256).toBe(sha256Of('via loopback authority'));
  });

  it.each([
    '/ordinary?one=1&one=2&empty=',
    '/escaped%2fpath/%23literal?next=%2F%2Felsewhere&space=+&space=%20',
    '/path:with-colon/%40name?encoded=%3F%23%26&bare',
  ])('preserves the exact path and query spelling of %s via the stack', async (pathname) => {
    const url = new URL(pathname, state.other);
    const via = new URL('/discarded/base?discarded=1#discarded', state.url);
    const original = [url.href, via.href];
    const reading = await read(url, {
      via,
      headers: { host: TRANSPORT_HOST, 'x-transport-test': '1' },
      deadlineMs: 5000,
    });

    expect(viaVisits).toStrictEqual([
      {
        method: 'GET',
        pathname,
        host: TRANSPORT_HOST,
        cookie: undefined,
        authorization: undefined,
        port: Number(via.port),
      },
    ]);
    expect(otherVisits).toStrictEqual([]);
    expect(reading.sha256).toBe(sha256Of('via loopback authority'));
    expect([url.href, via.href]).toStrictEqual(original);
  });

  it('keeps a HEAD with a double-slash pathname on the via socket as well', async () => {
    const other = new URL('/', state.other);
    const url = new URL(`/.//${other.host}/head?kept=%2F`, other);
    const via = new URL('/', state.url);
    const reading = await read(url, {
      via,
      method: 'HEAD',
      headers: {
        host: TRANSPORT_HOST,
        cookie: TRANSPORT_COOKIE,
        authorization: TRANSPORT_AUTHORIZATION,
        'x-transport-test': '1',
      },
      deadlineMs: 5000,
    });

    expect(viaVisits).toStrictEqual([
      {
        method: 'HEAD',
        pathname: `//${other.host}/head?kept=%2F`,
        host: TRANSPORT_HOST,
        cookie: TRANSPORT_COOKIE,
        authorization: TRANSPORT_AUTHORIZATION,
        port: Number(via.port),
      },
    ]);
    expect(otherVisits).toStrictEqual([]);
    expect(reading).toHaveLength(0);
    expect(reading.sha256).toBe(sha256Of(''));
  });

  it('uses the URL own authority unchanged when no via socket was selected', async () => {
    const url = new URL('/direct%2Fpath?one=1&one=2#not-sent', state.other);
    const original = url.href;
    const reading = await read(url, {
      headers: { cookie: TRANSPORT_COOKIE, authorization: TRANSPORT_AUTHORIZATION },
      deadlineMs: 5000,
    });

    expect(viaVisits).toStrictEqual([]);
    expect(otherVisits).toStrictEqual([
      {
        method: 'GET',
        pathname: '/direct%2Fpath?one=1&one=2',
        host: url.host,
        cookie: TRANSPORT_COOKIE,
        authorization: TRANSPORT_AUTHORIZATION,
        port: Number(url.port),
      },
    ]);
    expect(reading.sha256).toBe(sha256Of('other loopback authority'));
    expect(url.href).toBe(original);
  });

  it.each(['redirect', 'page'])('reads a flushed %s without waiting for its body', async (kind) => {
    const pathname = `/headers-only-${kind}`;
    const closed = Promise.withResolvers<true>();
    headersClosed.set(pathname, () => {
      closed.resolve(true);
    });
    let copied = false;
    let decoded = false;
    const reading = await read(new URL(pathname, state.url), {
      headers: {},
      headersOnly: true,
      headBytes: 15,
      deadlineMs: 5000,
      copyTo: () => {
        copied = true;
        return new URL('/copy', state.url);
      },
      decode: () => {
        decoded = true;
        return true;
      },
    });

    expect({
      status: reading.status,
      cookies: reading.headers['set-cookie'],
      location: reading.headers.location,
      length: reading.length,
      sha256: reading.sha256,
      head: reading.head.toString(),
      tail: reading.tail.toString(),
      truncated: reading.truncated,
      copied: reading.copied,
      copyStarted: copied,
      decodeStarted: decoded,
    }).toStrictEqual({
      status: kind === 'redirect' ? 307 : 200,
      cookies: ['seen=1; Path=/'],
      location: '/plain',
      length: 0,
      sha256: sha256Of(''),
      head: '',
      tail: '',
      truncated: true,
      copied: undefined,
      copyStarted: false,
      decodeStarted: false,
    });

    await closed.promise;
  });

  it('keeps a whole-body read open after the headers until its delayed body ends', async () => {
    let settled = false;
    const answer = (async () => {
      const reading = await read(new URL('/full-after-headers', state.url), {
        headers: {},
        deadlineMs: 5000,
        decode: () => {
          fullHeaders.resolve(true);
          return false;
        },
      });
      settled = true;
      return reading;
    })();
    await fullHeaders.promise;

    try {
      expect(settled).toBe(false);
    } finally {
      fullBody.finish();
    }
    const reading = await answer;

    expect(reading.truncated).toBe(false);
    expect(reading).toHaveLength(Buffer.byteLength(DOCUMENT));
    expect(reading.sha256).toBe(sha256Of(DOCUMENT));
  });

  it('keeps its head, its tail, its digest and a marker split across two chunks', async () => {
    const reading = await read(new URL('/document', state.url), {
      headers: {},
      headBytes: 15,
      marker: Buffer.from(RECOVERY_MARKER),
      deadlineMs: 5000,
    });

    expect(reading.status).toBe(200);
    expect(reading.head.toString()).toBe('<!DOCTYPE html>');
    expect(reading.tail.toString().endsWith('</body></html>\n')).toBe(true);
    expect(reading).toHaveLength(Buffer.byteLength(DOCUMENT));
    expect(reading.sha256).toBe(createHash('sha256').update(DOCUMENT).digest('hex'));
    expect(reading.marked).toBe(true);
  });

  it('finds no marker where there is none, and keeps no head it was not asked for', async () => {
    const reading = await read(new URL('/plain', state.url), {
      headers: {},
      marker: Buffer.from(RECOVERY_MARKER),
      deadlineMs: 5000,
    });

    expect(reading.marked).toBe(false);
    expect(reading.head.byteLength).toBe(0);
  });

  it('lets an answer go past a bound, said to be cut short, where only its start is asked of', async () => {
    const reading = await read(new URL('/endless', state.url), {
      headers: {},
      deadlineMs: 5000,
      limitBytes: 1024,
    });

    expect(reading.status).toBe(200);
    expect(reading.truncated).toBe(true);
    expect(reading.length).toBeGreaterThan(1024);
  });

  it('sends a copy of it on as it streams where its headers name somewhere, and keeps the answer', async () => {
    const copyTo = (headers: IncomingHttpHeaders): URL | undefined =>
      headers['x-copy'] === '1' ? new URL('/copy', state.url) : undefined;
    const copied = await read(new URL('/document', state.url), {
      headers: {},
      deadlineMs: 5000,
      copyTo,
    });
    const uncopied = await read(new URL('/plain', state.url), {
      headers: {},
      deadlineMs: 5000,
      copyTo,
    });

    expect(copied.copied).toStrictEqual({
      kind: 'answered',
      status: 200,
      text: `${sha256Of(DOCUMENT)} ${Buffer.byteLength(DOCUMENT)}`,
    });
    expect(uncopied.copied).toBeUndefined();
  });

  it('sends on whole a body longer than the copy takes at once, waiting for it', async () => {
    const reading = await read(new URL('/long', state.url), {
      headers: {},
      deadlineMs: 5000,
      copyTo: () => new URL('/copy', state.url),
    });
    const body = LONG_PIECE.repeat(LONG_PIECES);

    expect(reading).toHaveLength(Buffer.byteLength(body));
    expect(reading.copied).toStrictEqual({
      kind: 'answered',
      status: 200,
      text: `${sha256Of(body)} ${Buffer.byteLength(body)}`,
    });
  });

  it('says why a copy failed, and reads the body all the same', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const nowhere = new URL(`http://127.0.0.1:${(closed.address() as AddressInfo).port}/copy`);
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });
    const reading = await read(new URL('/document', state.url), {
      headers: {},
      deadlineMs: 5000,
      copyTo: () => nowhere,
    });

    expect(reading.sha256).toBe(sha256Of(DOCUMENT));
    expect(reading.copied).toMatchObject({ kind: 'failed' });
  });

  it('keeps no copy of an answer let go of past its bound', async () => {
    const reading = await read(new URL('/endless-copied', state.url), {
      headers: {},
      deadlineMs: 5000,
      limitBytes: 1024,
      copyTo: () => new URL('/copy', state.url),
    });

    expect(reading.truncated).toBe(true);
    expect(reading.copied).toBeUndefined();
  });

  it('keeps what a browser reads of an answer in a coding, where it is undone: each layer, the last first', async () => {
    const undone = async (at: string) => {
      return read(new URL(at, state.url), {
        headers: {},
        headBytes: 15,
        marker: Buffer.from(RECOVERY_MARKER),
        deadlineMs: 5000,
        decode: true,
        copyTo: () => new URL('/copy', state.url),
      });
    };
    const readings = await Promise.all(
      ['/br', '/gzip', '/zstd', '/layered'].map((at) => undone(at)),
    );
    const sent = await read(new URL('/br', state.url), { headers: {}, deadlineMs: 5000 });

    for (const reading of readings) {
      expect(reading.head.toString()).toBe('<!DOCTYPE html>');
      expect(reading.sha256).toBe(sha256Of(DOCUMENT));
      expect(reading.marked).toBe(true);
      // And what is copied on is what was kept.
      expect(reading.copied).toStrictEqual({
        kind: 'answered',
        status: 200,
        text: `${sha256Of(DOCUMENT)} ${Buffer.byteLength(DOCUMENT)}`,
      });
    }

    // As it came, where it is not asked to be undone.
    expect(sent.sha256).toBe(sha256Of(brotliCompressSync(DOCUMENT)));
  });

  it('keeps an answer from storage as it was stored, where it is undone unless stored', async () => {
    const [stored, composed] = await Promise.all(
      ['/stored-br', '/br'].map(async (at) => {
        return read(new URL(at, state.url), {
          headers: {},
          deadlineMs: 5000,
          decode: undoneUnlessStored(true),
        });
      }),
    );

    expect(stored?.sha256).toBe(sha256Of(brotliCompressSync(DOCUMENT)));
    expect(composed?.sha256).toBe(sha256Of(DOCUMENT));
  });

  it('fails an answer in a coding the check does not undo, where it is to be undone', async () => {
    const reading = read(new URL('/unknown', state.url), {
      headers: {},
      deadlineMs: 5000,
      decode: true,
    });

    await expect(reading).rejects.toThrow('answered in compress, a coding the check does not undo');
  });

  it('lets an answer in such a coding go at once, rather than at its deadline', async () => {
    const reading = read(new URL('/unknown-open', state.url), {
      headers: {},
      deadlineMs: 60_000,
      decode: true,
    });

    await expect(reading).rejects.toThrow('a coding the check does not undo');

    const stillOpen = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 2000);
    });

    await expect(Promise.race([letGo.promise, stillOpen])).resolves.toBe(true);
  });

  it('fails an answer in layers of a coding whose connection is lost partway, every layer let go of', async () => {
    const reading = read(new URL('/layered-broken', state.url), {
      headers: {},
      deadlineMs: 5000,
      decode: true,
    });

    // Rejected, not thrown past it: the layers in between fail with the rest, and nothing is left
    // to fail where no one listens.
    await expect(reading).rejects.toThrow('aborted');
  });

  it('lets an answer whose coding does not undo go at once, rather than at its deadline', async () => {
    const reading = read(new URL('/corrupt-open', state.url), {
      headers: {},
      deadlineMs: 60_000,
      decode: true,
    });

    await expect(reading).rejects.toThrow('incorrect header check');

    const stillOpen = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 2000);
    });

    await expect(Promise.race([corruptLetGo.promise, stillOpen])).resolves.toBe(true);
  });
});
