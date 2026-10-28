import { sha256Hex } from '@stayingupwind/core/artifact';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import { NEXT_RESUME_HEADER } from '@stayingupwind/core/request';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { type CspNonceMode, DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { buildRecoveryHtml } from '@stayingupwind/host/splice';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { noncedBody } from '../src/handlers/csp-nonce.ts';
import { handleDocument } from '../src/handlers/document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { htmlResponse } from './helpers/site.ts';

/**
 * A document of a project that handed CSP nonces to the edge, its shell served by the edge and the
 * rest rendered for the request by the deployment's Function: the nonce on the scripts of the
 * shell, which the edge wrote, and on what the render wrote itself, which Next.js gives the nonce
 * it reads off the request it renders — and on nothing a visitor put in the page.
 */

const CSP = 'content-security-policy';
const REPORT_ONLY = 'content-security-policy-report-only';
const SITE = 'https://site.example';
const HTML = 'text/html; charset=utf-8';
/** The shell as Next.js prerenders one: a script's preload, the script, the data it inlines. */
const SHELL =
  `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>` +
  `<link rel="preload" as="script" fetchPriority="low" href="/_next/static/chunks/webpack.js"/>` +
  `<script src="/_next/static/chunks/main.js" async=""></script></head><body>` +
  `<main><!--$?--><template id="B:0"></template><p>Loading…</p><!--/$--></main>` +
  `<script>(self.__next_f=self.__next_f||[]).push([0])</script>`;
/** What a visitor put in the page, reflected into the part rendered for them: another host's script. */
const INJECTED = '<script src="https://elsewhere.example/x.js"></script>';
/** Where the part rendered for the request begins. */
const RENDERED_FROM = '<div hidden id="S:0">';

const NONCE_SOURCE = "'nonce-";

/**
 * The nonce Next.js renders with, read as it reads one (`getScriptNonceFromHeader`): the first
 * `script-src` names in the request's policy.
 */
function nonceRenderedWith(request: Request): string | undefined {
  const policy = request.headers.get(CSP) ?? request.headers.get(REPORT_ONLY) ?? '';
  const directive = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src'));
  const source = directive?.split(' ').find((part) => part.startsWith(NONCE_SOURCE));
  return source?.slice(NONCE_SOURCE.length, -1);
}

/**
 * The part a resume renders, as Next.js renders it: what the visitor put in the page as they put it,
 * and the scripts it writes itself with the nonce it was told (`nonceRenderedWith`) — or `own`, as
 * a page does that hands its components a nonce of its own.
 */
function rendered(request: Request, own?: string): string {
  const nonce = own ?? nonceRenderedWith(request);
  const attribute = nonce === undefined ? '' : ` nonce="${nonce}"`;
  return (
    `${RENDERED_FROM}<p>Hello ${INJECTED}</p></div>` +
    `<script${attribute}>self.__next_f.push([1,"a"])</script>` +
    `<script${attribute}>$RC("B:0","S:0")</script></body></html>`
  );
}

interface Options {
  /** The route's own policy, as the build recorded it. */
  readonly policy?: string;
  readonly mode?: CspNonceMode;
  readonly strictDynamic?: boolean;
  /** The visitor's request headers, beside a navigation's. */
  readonly headers?: Readonly<Record<string, string>>;
  /** What the middleware the edge ran set, on the request and on the response. */
  readonly middleware?: {
    readonly request: Readonly<Record<string, string>>;
    readonly response: Readonly<Record<string, string>>;
  };
  /** The route was finished whole by the build: nothing resumes it. */
  readonly complete?: boolean;
  /** How the Function answers the resume: with the rendered part, unless this says otherwise. */
  readonly resume?: (request: Request) => Promise<Response>;
}

interface Served {
  readonly response: Response;
  /** What the deployment's Function was asked, by the edge, to resume. */
  readonly resumes: readonly Request[];
  readonly ctx: ExecutionContext;
}

/** The middleware's answer as the edge holds it once the request goes on. */
function continued(
  middleware: NonNullable<Options['middleware']>,
): Extract<MiddlewareResult, { kind: 'continue' }> {
  return {
    kind: 'continue',
    url: new URL(`${SITE}/`),
    rewritten: false,
    requestHeaders: new Headers({ accept: HTML, ...middleware.request }),
    responseHeaders: new Headers(middleware.response),
    setCookie: undefined,
  };
}

/** The document the edge composes of the route, its shell in hand and its Function as `options`. */
async function served(options: Options = {}): Promise<Served> {
  const shell = encodeUtf8(options.complete === true ? `${SHELL}</body></html>` : SHELL);
  const entry: RouteEntry = {
    pathname: '/',
    status: 200,
    headers: { 'content-type': HTML, [CSP]: options.policy ?? "script-src 'self'" },
    prerenderId: '/',
    shell: {
      sha256: await sha256Hex(shell),
      byteLength: shell.byteLength,
      contentType: HTML,
      encoding: 'identity',
    },
    cache: {
      entryId: 'entry-index',
      kind: 'app-page',
      delivery: options.complete === true ? 'complete' : 'resume',
    },
  };
  const manifest = buildProjectManifest({
    projectId: 'nonced',
    runId: 'run',
    originHost: 'site.example',
    generatedAt: '2026-10-28T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-28T00:00:00.000Z' },
    app: { deploymentId: 'dpl_site', scriptName: 'site-app' },
    routes: [entry],
  });
  const resumes: Request[] = [];
  const ctx = createExecutionContext();
  const edge: EdgeContext = {
    env,
    ctx,
    runtime: standaloneRuntime(env, {
      memory: createEdgeMemory(() => 0),
      dispatchApp: (_script, request) => {
        if (request.headers.get(NEXT_RESUME_HEADER) !== '1') {
          return Promise.reject(new Error('only a resume is asked of the Function'));
        }
        resumes.push(request);
        return options.resume?.(request) ?? Promise.resolve(htmlResponse(rendered(request)));
      },
    }),
    host: standaloneHost(env),
    forwarding: { previewDomain: 'example', previewHost: 'site.example', clientIp: undefined },
    app: manifest.app,
    originalUrl: undefined,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: true,
    cspNonceMode: options.mode ?? 'enforce',
    cspStrictDynamic: options.strictDynamic ?? false,
    cacheApi: false,
    assetMaxBytes: 1_000_000,
    projectId: manifest.projectId,
    manifestId: 'manifest-nonced',
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: undefined, manifestMs: undefined, middlewareMs: undefined },
  };
  const request: IncomingRequest = new Request(`${SITE}/`, {
    headers: { accept: HTML, 'accept-encoding': 'identity', ...options.headers },
  });
  const response = await handleDocument({
    request,
    entry,
    manifest,
    edge,
    resolved: {
      policy: DEFAULT_DELIVERY_POLICY,
      shell: { id: 'kv', getShell: () => Promise.reject(new Error('the shell is in hand')) },
      assets: {
        id: 'passthrough',
        handle: () => Promise.reject(new Error('no asset is requested')),
      },
    },
    middleware: options.middleware === undefined ? undefined : continued(options.middleware),
    shellRead: Promise.resolve({
      kind: 'ok',
      read: { bytes: shell, source: 'memory', latencyMs: 0 },
    }),
    generation: undefined,
    passthrough: () => Promise.reject(new Error('the edge composes this document itself')),
  });
  return { response, resumes, ctx };
}

/** The nonce the response's policies name, the trial's where the enforcing one names none. */
function nonceOf(response: Response): string | undefined {
  const policies = `${response.headers.get(CSP) ?? ''}, ${response.headers.get(REPORT_ONLY) ?? ''}`;
  return /'nonce-([^']+)'/u.exec(policies)?.[1];
}

/** How many times `text` names `nonce` on an element; a nonce never minted, never. */
function named(text: string, nonce = '(none)'): number {
  return text.split(` nonce="${nonce}"`).length - 1;
}

/** The body read whole, and the part of it the shell is and the part the render is. */
async function parts(document: Served): Promise<{ shell: string; rest: string; body: string }> {
  const body = await document.response.text();
  await waitOnExecutionContext(document.ctx);
  const at = body.indexOf(RENDERED_FROM);
  return at === -1
    ? { shell: body, rest: '', body }
    : { shell: body.slice(0, at), rest: body.slice(at), body };
}

describe('the nonce of a document a resume completes', () => {
  it('is handed to the resume as the policy Next.js reads it from', async () => {
    const document = await served();
    await parts(document);
    const nonce = nonceOf(document.response);

    expect(nonce).toBeDefined();
    expect(document.resumes).toHaveLength(1);
    expect(document.resumes[0]?.headers.get(CSP)).toBe(`script-src 'nonce-${nonce ?? ''}'`);
    expect(document.resumes[0]?.headers.has(REPORT_ONLY)).toBe(false);
  });

  it('replaces whatever policy the visitor sent with the request', async () => {
    const document = await served({
      headers: {
        [CSP]: "script-src 'nonce-chosen-by-the-visitor'",
        [REPORT_ONLY]: "script-src 'nonce-chosen-as-well'",
      },
    });
    const { rest } = await parts(document);
    const nonce = nonceOf(document.response);

    expect(document.resumes[0]?.headers.get(CSP)).toBe(`script-src 'nonce-${nonce ?? ''}'`);
    expect(document.resumes[0]?.headers.has(REPORT_ONLY)).toBe(false);
    expect(rest).not.toContain('chosen');
  });

  it('is stamped on the shell’s scripts and preloads, and nowhere past the shell', async () => {
    const document = await served();
    const { shell, rest } = await parts(document);
    const nonce = nonceOf(document.response);

    // The preload, the script it preloads and the data the shell inlines: all the edge's to stamp.
    expect(named(shell, nonce)).toBe(3);
    // The rest exactly as the Function rendered it: its own two scripts named by the nonce it was
    // handed, and the script the visitor put in the page named by none.
    expect(rest).toBe(rendered(document.resumes[0] ?? new Request(SITE)));
    expect(named(rest, nonce)).toBe(2);
    expect(rest).toContain(`<p>Hello ${INJECTED}</p>`);
  });

  it('is put on nothing past the shell that named another', async () => {
    const own = 'bm9uY2Ugb2YgaXRzIG93bg==';
    const document = await served({
      resume: (request) => Promise.resolve(htmlResponse(rendered(request, own))),
    });
    const { rest } = await parts(document);

    expect(named(rest, own)).toBe(2);
    expect(named(rest, nonceOf(document.response))).toBe(0);
  });

  it('goes out as far as the shell’s end before the resume answers', async () => {
    const answer = Promise.withResolvers<Response>();
    const document = await served({ resume: () => answer.promise });
    const nonce = nonceOf(document.response);
    const reader = document.response.body?.pipeThrough(new TextDecoderStream()).getReader();
    let read = '';
    while (!read.includes('push([0])</script>')) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      read += chunk.value;
    }

    expect(named(read, nonce)).toBe(3);
    expect(read).not.toContain(RENDERED_FROM);

    const continuation = rendered(document.resumes[0] ?? new Request(SITE));
    answer.resolve(htmlResponse(continuation));
    let rest = '';
    for (;;) {
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) break;
      rest += chunk.value;
    }
    await waitOnExecutionContext(document.ctx);

    expect(rest).toBe(continuation);
  });

  it('is given to the recovery script the edge appends where the resume fails', async () => {
    const document = await served({
      resume: () => Promise.reject(new Error('the Function is unreachable')),
    });
    const { body } = await parts(document);
    const nonce = nonceOf(document.response);

    expect(body.endsWith(buildRecoveryHtml({ nonce }))).toBe(true);
    expect(body).toContain(`<script nonce="${nonce ?? ''}">(function(){`);
  });

  it('is handed to the resume in Report Only, as the trial names it', async () => {
    const document = await served({ mode: 'report-only' });
    const { shell, rest } = await parts(document);
    const nonce = nonceOf(document.response);

    expect(document.response.headers.get(CSP)).toBe("script-src 'self'");
    expect(document.response.headers.get(REPORT_ONLY)).toBe(
      `script-src 'self' 'nonce-${nonce ?? ''}'`,
    );
    expect(document.resumes[0]?.headers.get(CSP)).toBe(`script-src 'nonce-${nonce ?? ''}'`);
    expect(named(shell, nonce)).toBe(3);
    expect(named(rest, nonce)).toBe(2);
  });

  it("is handed to the resume without the 'strict-dynamic' the response carries beside it", async () => {
    const document = await served({ strictDynamic: true });
    await parts(document);
    const nonce = nonceOf(document.response);

    expect(document.response.headers.get(CSP)).toBe(
      `script-src 'self' 'nonce-${nonce ?? ''}' 'strict-dynamic'`,
    );
    expect(document.resumes[0]?.headers.get(CSP)).toBe(`script-src 'nonce-${nonce ?? ''}'`);
  });

  it('replaces the policy a middleware put on the request with the response’s own', async () => {
    const theirs = 'bWlkZGxld2FyZSdzIG93bg==';
    const document = await served({
      middleware: {
        request: { [CSP]: `script-src 'nonce-${theirs}'`, 'x-nonce': theirs },
        response: { [CSP]: `script-src 'self' 'nonce-${theirs}'` },
      },
    });
    const { rest } = await parts(document);
    const nonce = nonceOf(document.response);

    expect(nonce).not.toBe(theirs);
    expect(document.response.headers.get(CSP)).toBe(`script-src 'self' 'nonce-${nonce ?? ''}'`);
    expect(document.resumes[0]?.headers.get(CSP)).toBe(`script-src 'nonce-${nonce ?? ''}'`);
    expect(named(rest, nonce)).toBe(2);
  });

  it.each([
    [
      'the middleware gives a policy somewhere for one',
      "frame-ancestors 'none'",
      "script-src 'self'",
    ],
    ['the middleware takes it away', "script-src 'self'", "frame-ancestors 'none'"],
  ])('is minted by the policy the response carries, where %s', async (_where, policy, theirs) => {
    const document = await served({
      policy,
      middleware: { request: {}, response: { [CSP]: theirs } },
    });
    const { shell } = await parts(document);
    const nonce = nonceOf(document.response);
    const minted = theirs.startsWith('script-src');

    expect(nonce !== undefined).toBe(minted);
    expect(document.resumes[0]?.headers.get(CSP) ?? null).toBe(
      minted ? `script-src 'nonce-${nonce ?? ''}'` : null,
    );
    expect(named(shell, nonce)).toBe(minted ? 3 : 0);
  });
});

describe('the nonce of a document complete in itself', () => {
  it('is stamped on all of it, as nothing resumes it', async () => {
    const document = await served({ complete: true });
    const { body } = await parts(document);
    const nonce = nonceOf(document.response);

    expect(document.resumes).toHaveLength(0);
    expect(named(body, nonce)).toBe(3);
    expect(body.endsWith('</body></html>')).toBe(true);
  });
});

/** What follows a shell, as a stream of one chunk. */
function behind(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeUtf8(text));
      controller.close();
    },
  });
}

describe('a shell stamped on its own, what follows it behind', () => {
  const nonce = 'c2hlbGwgbm9uY2U=';

  it('leaves a start tag the shell ends inside unnamed: refused, never trusted', async () => {
    const cut = noncedBody(
      encodeUtf8('<p>static</p><script src="/a.js"'),
      HTML,
      nonce,
      behind(' async=""></script>'),
    );

    await expect(new Response(cut).text()).resolves.toBe(
      '<p>static</p><script src="/a.js" async=""></script>',
    );
  });

  it('reads what follows a chunk ahead from the start, whatever the shell waits on', () => {
    let queue: ReadableStreamDefaultController<Uint8Array> | undefined;
    const rest = new ReadableStream<Uint8Array>({
      start(controller) {
        queue = controller;
        // As the splice opens where the shell goes ahead of it: with nothing, which fills its queue.
        controller.enqueue(new Uint8Array());
      },
    });
    noncedBody(encodeUtf8(SHELL), HTML, nonce, rest);

    // The splice reads the resume only while its queue has room, so the room is made at once.
    expect(queue?.desiredSize).toBe(1);
  });

  it('lets what follows go with a reader that leaves before the shell has gone out', async () => {
    const cancelled = Promise.withResolvers<unknown>();
    // A resume not yet answered, as the splice holds one: nothing to read, and a cancel to hear.
    const rest = new ReadableStream<Uint8Array>({ cancel: cancelled.resolve });
    const body = noncedBody(encodeUtf8(SHELL), HTML, nonce, rest);
    await body.cancel('client left');

    await expect(cancelled.promise).resolves.toBe('client left');
  });
});
