import { encodeUtf8 } from '../../src/util/bytes.ts';

export interface PprDocumentOptions {
  readonly buildId?: string | undefined;
  readonly dplId?: string | undefined;
  readonly dynamicText?: string | undefined;
  readonly staticText?: string | undefined;
  readonly extraShellBytes?: number | undefined;
}

export interface PprDocument {
  readonly shell: Uint8Array;
  readonly suffix: Uint8Array;
  readonly shellText: string;
  readonly suffixText: string;
}

/**
 * Synthetic Next.js 16 PPR output: the shell is the Fizz prelude without `</body></html>` and with a
 * pending Suspense boundary; the resumed suffix carries the inlined flight data (including the
 * build id row), the completed boundary and the closing tags moved to the very end.
 */
export function buildPprDocument(options: PprDocumentOptions = {}): PprDocument {
  const buildId = options.buildId ?? 'AbCdEf123456';
  const dpl = options.dplId === undefined ? '' : `?dpl=${options.dplId}`;
  const dplAttribute = options.dplId === undefined ? '' : ` data-dpl-id="${options.dplId}"`;
  const staticText = options.staticText ?? 'Static header';
  const padding = 'x'.repeat(options.extraShellBytes ?? 600);
  const shellText =
    `<!DOCTYPE html><html lang="en"${dplAttribute}><head><meta charSet="utf-8"/>` +
    `<link rel="stylesheet" href="/_next/static/css/app-def456.css${dpl}" data-precedence="next"/>` +
    `<script src="/_next/static/chunks/main-abc123.js${dpl}" async=""></script>` +
    `<script src="/_next/static/chunks/app/layout-0123456789abcdef.js${dpl}" async=""></script>` +
    `</head><body><div id="__next"><header>${staticText}</header><!-- ${padding} -->` +
    `<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main></div>`;
  const dynamicText = options.dynamicText ?? 'Hello dynamic';
  const flightRow = JSON.stringify(
    `0:{"P":null,"b":"${buildId}","p":"","c":["",""],"i":false,"f":[[]],"m":"","G":[]}\n`,
  );
  const suffixText =
    `<script>(self.__next_f=self.__next_f||[]).push([0])</script>` +
    `<script>self.__next_f.push([1,${flightRow}])</script>` +
    `<div hidden id="S:0"><p>${dynamicText}</p></div>` +
    `<script>$RC=function(b,c,e){var d=document.getElementById(c);d.parentNode.removeChild(d)};$RC("B:0","S:0")</script>` +
    `</body></html>`;
  return { shell: encodeUtf8(shellText), suffix: encodeUtf8(suffixText), shellText, suffixText };
}

interface ChunkPlan {
  readonly bytes: Uint8Array;
  /** Virtual milliseconds to advance before this chunk is delivered. */
  readonly delayMs: number;
}

/** Virtual clock shared between a fake origin and the code under test. */
export class VirtualClock {
  #nowMs = 0;

  now = (): number => this.#nowMs;

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

export interface FakeOriginOptions {
  readonly status?: number | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly chunks: readonly ChunkPlan[];
  readonly clock: VirtualClock;
  readonly headerDelayMs?: number | undefined;
}

/** A Response whose body delivers chunks while advancing the virtual clock. */
export function fakeOriginResponse(options: FakeOriginOptions): Response {
  const queue = [...options.chunks];
  options.clock.advance(options.headerDelayMs ?? 5);
  // highWaterMark 0: chunks are produced only on read demand, so the virtual clock advances exactly
  // when the consumer observes the chunk (mirrors network arrival timing).
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          controller.close();
          return;
        }
        options.clock.advance(next.delayMs);
        controller.enqueue(next.bytes);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-vercel-cache': 'PRERENDER',
      'x-vercel-id': 'iad1::abc-123',
      server: 'Vercel',
      'cache-control': 'private, no-cache, no-store, max-age=0, must-revalidate',
      ...options.headers,
    },
  });
}

/** Split bytes into `count` roughly equal chunks (for multi-chunk shells). */
export function splitBytes(bytes: Uint8Array, count: number): Uint8Array[] {
  const size = Math.ceil(bytes.byteLength / count);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    parts.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return parts;
}

/** A Response whose body delivers the given chunks and then fails with a network-style error. */
export function failingOriginResponse(chunks: readonly Uint8Array[], error: Error): Response {
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          controller.error(error);
          return;
        }
        controller.enqueue(next);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * Like `stallingOriginResponse`, but `cancel()` never settles either, like a socket that never
 * acknowledges the cancel: anything that awaits releasing this body hangs forever.
 */
export function unreleasableOriginResponse(
  chunks: readonly Uint8Array[],
  init: { status?: number | undefined; headers?: Record<string, string> | undefined } = {},
): Response {
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          await neverSettles<never>();
          return;
        }
        controller.enqueue(next);
      },
      cancel: () => neverSettles<never>(),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers },
  });
}

/** Explicit no-op for strategy stubs (an empty body would trip `no-empty-function`). */

/** A promise that never settles (exercises timeouts). */
export function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally never settles.
  });
}

/** A Response that delivers the given chunks and then never yields again. */
export function stallingOriginResponse(chunks: readonly Uint8Array[]): Response {
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<undefined> | undefined {
        const next = queue.shift();
        if (next === undefined) {
          return neverSettles<undefined>();
        }
        controller.enqueue(next);
        return undefined;
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Counts how many chunks the consumer has actually pulled, to observe backpressure. */
export interface CountingOrigin {
  readonly response: Response;
  readonly pulled: () => number;
  /** Why the consumer let go of the body, if it did. */
  readonly cancelled: () => string | undefined;
}

/**
 * With `thenStall`, the body never yields again once the chunks are out, rather than ending; with a
 * `status` other than 200, the answer is one the splice refuses.
 */
export function countingOriginResponse(
  chunks: readonly Uint8Array[],
  {
    thenStall = false,
    status = 200,
  }: { readonly thenStall?: boolean; readonly status?: number } = {},
): CountingOrigin {
  const queue = [...chunks];
  let pulled = 0;
  let cancelled: string | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller): Promise<undefined> | undefined {
        const next = queue.shift();
        if (next === undefined) {
          if (thenStall) {
            return neverSettles<undefined>();
          }
          controller.close();
          return undefined;
        }
        pulled += 1;
        controller.enqueue(next);
        return undefined;
      },
      cancel(reason) {
        cancelled = String(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return {
    response: new Response(body, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    pulled: () => pulled,
    cancelled: () => cancelled,
  };
}
