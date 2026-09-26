import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  isUpwindInternalPath,
  UPWIND_DEV_ADDRESS_ENV,
  UPWIND_INTERNAL_PREFIX,
} from '@stayingupwind/core/paas';

import { answerInternal } from '../internal/router.ts';
import { ownVersion } from '../manifest.ts';
import { installAdapterPath } from './adapter.ts';
import { displayAddress, internalAddress } from './address.ts';
import { printListening, printReady } from './banner.ts';
import { type StopWatching, watchConfigFiles } from './config-watch.ts';
import { setEnv } from './env.ts';
import { listen } from './listen.ts';
import { type NextHandler, type RunningNext, startNextApp } from './next-app.ts';
import { reachable } from './probe.ts';
import { createSession } from './session.ts';

/**
 * One `upwind dev` run: upwind holds the port, and Next.js is behind it.
 *
 * The order matters. The socket is bound first, so `/__upwind` answers from the first moment there is
 * anything to ask — including while Next.js is still starting, and including if it never does.
 * Next.js is then started with the port that was actually bound, and everything that is not
 * `/__upwind` waits for it.
 *
 * `/__upwind` is answered here rather than handed to Next.js and rewritten back out. That is the whole
 * arrangement: the prefix never enters the application's router, so no page, middleware or rewrite of
 * the project's can answer for it, shadow it, or see it.
 */

export interface DevOptions {
  readonly projectDir: string;
  readonly hostname: string | undefined;
  readonly port: number;
}

const STATUS_INTERNAL_ERROR = 500;

/**
 * The pathname a request names, whatever form its target took, and `/` for one that parses as none.
 *
 * An origin-form target is a path even when it begins with `//`, so it is read as one: resolved against
 * a base, `//docs/__upwind` is a *scheme-relative* URL whose authority is `docs`, and the pathname that
 * falls out of it — `/__upwind` — is not the path anybody asked for. Next.js keeps the slashes and
 * canonicalises towards `/docs/__upwind`, which is the application's.
 */
function pathnameOf(target = '/'): string {
  try {
    return target.startsWith('/')
      ? new URL(`http://localhost${target}`).pathname
      : new URL(target, 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * The pathname with its escapes read, except for the ones a segment holds as data.
 *
 * `%2F` is not a separator to Next.js: it survives into the route parameter, so `/__upwind%2Freport` is
 * one segment that an application route may own rather than a child of this prefix. Decoding the whole
 * pathname at once would turn it into two segments and hand the application's path to the front door,
 * so each segment is read on its own and a slash that appears inside one is put back as the escape it
 * came from. Nothing, for escapes that are not escapes.
 */
function decodedPathname(pathname: string): string | undefined {
  try {
    return pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment).replaceAll('/', '%2F'))
      .join('/');
  } catch {
    return undefined;
  }
}

/**
 * The internal path a request asks for, in the form this answers it under — or nothing, for a request
 * that is the application's.
 *
 * Both the prefix as written and the prefix as it decodes, because Next.js's own router does not treat
 * them alike: `/%5F%5Fupwind` is matched against the filesystem decoded, where a rewrite's `source` is
 * matched raw. So a path that *means* the prefix would otherwise reach a catch-all route of the
 * project's, past the front door and past the reservation both.
 *
 * `..` needs no handling of its own: `pathnameOf` parses through `URL`, which resolves dot segments
 * before any of this sees them, so `/app/../__upwind` arrives here as `/__upwind`. What is deliberately
 * *not* done is resolving them again after decoding, for the same reason `%2F` is left alone above: the
 * second pass would claim paths the application is meant to answer. Nothing below reads a file or builds
 * a target out of the path either way — the endpoints are a fixed table.
 */
function internalPathname(pathname: string): string | undefined {
  if (isUpwindInternalPath(pathname)) {
    return pathname;
  }
  const decoded = decodedPathname(pathname);
  if (decoded === undefined) {
    return undefined;
  }
  return isUpwindInternalPath(decoded) ? decoded : undefined;
}

/** How far along a run is, for the signal handler to know what there is to close. */
type Phase = 'starting' | 'running' | 'stopping';

export async function serveDev(options: DevOptions): Promise<void> {
  const devSession = createSession({
    projectDir: options.projectDir,
    hostname: options.hostname,
    upwindVersion: await ownVersion(),
  });
  const adapter = installAdapterPath(options.projectDir);
  devSession.adapterPath = adapter.path;

  // What everything but `/__upwind` waits on: the handler itself, once there is one. Rejected if
  // Next.js never starts, so a request that arrived while it was starting is answered — with the 500
  // `answerOrFail` writes — instead of holding a connection that the exit resets under it.
  const nextReady: PromiseWithResolvers<NextHandler> = Promise.withResolvers();

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const internal = internalPathname(pathnameOf(req.url));
    if (internal !== undefined) {
      answerInternal(internal, req, res, devSession);
      return;
    }
    const handle = await nextReady.promise;
    await handle(req, res);
  }

  /** Answers, or says that it could not: what the request listener starts and never has to watch. */
  async function answerOrFail(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await answer(req, res);
    } catch (error) {
      console.error(`upwind: failed to answer ${req.url ?? '(no url)'}`);
      console.error(error);
      if (res.headersSent) {
        // Part of an answer is already on the wire, and its status said this went well. Appending to
        // it would leave a document that says it is complete; breaking the connection is the only
        // thing left that a client will read as the failure it is.
        res.destroy();
        return;
      }
      res.writeHead(STATUS_INTERNAL_ERROR, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
  }

  const server = createServer((req, res) => {
    // A request listener returns nothing, and this promise cannot reject: `answerOrFail` is where a
    // failure becomes a response.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- answered above, not awaited.
    void answerOrFail(req, res);
  });

  const bound = await listen(server, options.port, options.hostname);
  devSession.address = displayAddress(options.hostname, bound.port);
  // The supervisor is told, so that a restart lands on this port rather than on another one the kernel
  // picks for a `--port 0` run, or on a port that has since been taken by something else. `connected`
  // and not just `send`: a supervisor that died leaves the method behind on a channel that refuses,
  // and what it refuses with would end a server that is otherwise fine.
  if (process.connected) {
    process.send?.({ port: bound.port });
  }
  // Where the adapter's reservation sends `/__upwind`, set in the process that loads `next.config` —
  // which is this one, since Next.js runs here. A socket whose address cannot be written as a URL
  // leaves the reservation unmade rather than pointing it somewhere that will not parse; the front
  // door answers the prefix either way.
  const internal = internalAddress(bound, options.hostname);
  // Opened rather than assumed: `internalAddress` answers IPv4 loopback for a wildcard socket because
  // that is what a rewrite destination can spell, and on a host that is not dual-stack the socket is
  // not there. A connection to it settles that in a millisecond.
  const usable = internal !== undefined && (await reachable(internal));
  if (!usable) {
    console.warn(
      `upwind: no address of this socket can be named in a Next.js rewrite, so nothing reserves ${UPWIND_INTERNAL_PREFIX} inside Next.js's own routing — this server still answers it first`,
    );
  }
  // Set for the config load and no longer (`env.ts`). Cleared rather than left alone when there is no
  // address to give: an inherited value names some other run's front door, and the adapter would
  // reserve this project's prefix for a server that is not this one.
  const restoreAddress = setEnv(UPWIND_DEV_ADDRESS_ENV, usable ? internal : undefined);
  printListening(devSession);

  // Installed here, with the port, rather than once Next.js is ready.
  // An interrupt during a long first compile is the same interruption as one a minute later.
  // It has to end the same way, and before there is anything to close, ending is the whole of it.
  //
  // A repeat is ignored, which is why these are `process.on` and not `process.once`.
  // One interactive Ctrl-C arrives twice: from the terminal, and from the supervisor that forwards it.
  // Under `once` the second would find no listener, and the default disposition would kill a shutdown
  // that had only just started. A shutdown that will not finish is bounded by the supervisor instead.
  const stop: PromiseWithResolvers<void> = Promise.withResolvers();
  let phase: Phase = 'starting';
  const onStop = (): void => {
    if (phase === 'stopping') {
      return;
    }
    if (phase === 'starting') {
      process.exit(0);
    }
    phase = 'stopping';
    stop.resolve();
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  // Before Next.js is started, not after: `prepare()` reads `next.config` and can take seconds, and a
  // config written during those seconds would otherwise be one this run never hears about — it would
  // serve the old config until something changed again.
  const stopWatching: StopWatching = await watchConfigFiles(options.projectDir);
  let app: RunningNext;
  try {
    app = await startNextApp({
      projectDir: options.projectDir,
      hostname: options.hostname,
      port: bound.port,
      httpServer: server,
    });
  } catch (error) {
    // Every request already waiting on the handler is told, so it is answered rather than left to a
    // connection that resets under it, and the socket stops taking new ones. The connections it still
    // has are left open long enough for those answers to go out; `cli.ts` ends the process once it has
    // said why. The watch goes with it: a config saved while this was failing would otherwise ask the
    // supervisor to restart a run that is already over.
    nextReady.reject(error);
    stopWatching();
    server.close();
    throw error;
  }
  // Next.js has read the config, and with it the adapter this run named and the address it gave;
  // what is in the environment from here on is the project's own.
  adapter.restore();
  restoreAddress();
  devSession.nextVersion = app.version;
  devSession.readyTick = performance.now();
  nextReady.resolve(app.handle);
  phase = 'running';
  printReady(devSession);

  await stop.promise;
  // A config change is no longer this run's business: the developer asked it to stop, and a restart
  // would start again the server they stopped.
  stopWatching();
  server.close();
  // A keep-alive connection would otherwise hold the close open for as long as a browser felt like.
  server.closeAllConnections();
  await app.close();
  // Next.js's dev bundler keeps handles of its own, so this process would not end on its own. What
  // was asked for is over.
  process.exit(0);
}
