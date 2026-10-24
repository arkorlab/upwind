import { encodeUtf8 } from '@stayingupwind/core/util';

export interface PprDocumentOptions {
  readonly buildId?: string | undefined;
  readonly dplId?: string | undefined;
  readonly dynamicText?: string | undefined;
  readonly staticText?: string | undefined;
  /** Leave the build id out of the flight row, as Next.js does once the app has a deployment id. */
  readonly omitBuildId?: boolean | undefined;
}

export interface PprDocument {
  readonly shell: Uint8Array;
  readonly suffix: Uint8Array;
  readonly shellText: string;
  readonly suffixText: string;
}

/**
 * Synthetic Next.js 16 PPR output: the shell is the Fizz prelude without `</body></html>` and with a
 * pending Suspense boundary; the resumed suffix carries the flight data (with the build id row), the
 * completed boundary and the closing tags.
 */
export function buildPprDocument(options: PprDocumentOptions = {}): PprDocument {
  const buildId = options.buildId ?? 'AbCdEf123456';
  const dpl = options.dplId === undefined ? '' : `?dpl=${options.dplId}`;
  const dplAttribute = options.dplId === undefined ? '' : ` data-dpl-id="${options.dplId}"`;
  const staticText = options.staticText ?? 'Static header';
  const shellText =
    `<!DOCTYPE html><html lang="en"${dplAttribute}><head><meta charSet="utf-8"/>` +
    `<link rel="stylesheet" href="/_next/static/css/app-def456.css${dpl}" data-precedence="next"/>` +
    `<script src="/_next/static/chunks/main-abc123.js${dpl}" async=""></script>` +
    `</head><body><div id="__next"><header>${staticText}</header>` +
    `<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main></div>`;
  const dynamicText = options.dynamicText ?? 'Hello dynamic';
  const buildIdField = options.omitBuildId === true ? '' : `"b":"${buildId}",`;
  const flightRow = JSON.stringify(
    `0:{"P":null,${buildIdField}"p":"","c":["",""],"i":false,"f":[[]],"m":"","G":[]}\n`,
  );
  const suffixText =
    `<script>(self.__next_f=self.__next_f||[]).push([0])</script>` +
    `<script>self.__next_f.push([1,${flightRow}])</script>` +
    `<div hidden id="S:0"><p>${dynamicText}</p></div>` +
    `<script>$RC("B:0","S:0")</script>` +
    `</body></html>`;
  return { shell: encodeUtf8(shellText), suffix: encodeUtf8(suffixText), shellText, suffixText };
}

/** An origin document response (`text/html`, 200) built from the given byte chunks. */
export function htmlResponse(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  const queue = [...chunks];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  headers.set('x-vercel-cache', 'PRERENDER');
  headers.set('x-vercel-id', 'iad1::abc-123');
  headers.set('server', 'Vercel');
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A promise that never settles (exercises timeouts). */
export function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally never settles.
  });
}

/** An origin response whose body stalls after the first chunk and whose `cancel()` never settles. */
