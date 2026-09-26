import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { isUpwindInternalPath, UPWIND_DEV_ADDRESS_ENV } from '@stayingupwind/core/paas';

import { answerInternal } from '../internal/router.ts';
import { ownVersion } from '../manifest.ts';
import { installAdapterPath } from './adapter.ts';
import { displayAddress, loopbackAddress } from './address.ts';
import { printListening, printReady } from './banner.ts';
import { watchConfigFiles } from './config-watch.ts';
import { listen } from './listen.ts';
import { type NextHandler, type RunningNext, startNextApp } from './next-app.ts';
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

/** The pathname a request names, whatever form its target took, and `/` for one that parses as none. */
function pathnameOf(target: string | undefined): string {
  try {
    return new URL(target ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/** Run until a signal asks otherwise, then let go of the port and the dev server. */
async function untilStopped(server: Server, app: RunningNext): Promise<void> {
  const { promise, resolve }: PromiseWithResolvers<void> = Promise.withResolvers();
  const stop = (): void => {
    resolve();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await promise;
  server.close();
  // A keep-alive connection would otherwise hold the close open for as long as a browser felt like.
  server.closeAllConnections();
  await app.close();
}

export async function serveDev(options: DevOptions): Promise<void> {
  const devSession = createSession({
    projectDir: options.projectDir,
    upwindVersion: await ownVersion(),
  });
  devSession.adapterPath = installAdapterPath(options.projectDir);

  // What everything but `/__upwind` waits on: the handler itself, once there is one. Never rejected —
  // a dev server that cannot start leaves the process (below), and the requests waiting here go with
  // the socket rather than each being told the same thing.
  const nextReady: PromiseWithResolvers<NextHandler> = Promise.withResolvers();

  async function answer(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = pathnameOf(req.url);
    if (isUpwindInternalPath(pathname)) {
      answerInternal(pathname, req, res, devSession);
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
      if (!res.headersSent) {
        res.writeHead(STATUS_INTERNAL_ERROR, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    }
  }

  const server = createServer((req, res) => {
    // A request listener returns nothing, and this promise cannot reject: `answerOrFail` is where a
    // failure becomes a response.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- answered above, not awaited.
    void answerOrFail(req, res);
  });

  const port = await listen(server, options.port, options.hostname);
  devSession.address = displayAddress(options.hostname, port);
  // Where the adapter's reservation sends `/__upwind`, set in the process that loads `next.config` —
  // which is this one, since Next.js runs here.
  process.env[UPWIND_DEV_ADDRESS_ENV] = loopbackAddress(options.hostname, port);
  printListening(devSession);

  try {
    // Before Next.js is started, not after: `prepare()` reads `next.config` and can take seconds, and
    // a config written during those seconds would otherwise be one this run never hears about — it
    // would serve the old config until something changed again.
    await watchConfigFiles(options.projectDir);
    const app: RunningNext = await startNextApp({
      projectDir: options.projectDir,
      hostname: options.hostname,
      port,
      httpServer: server,
    });
    devSession.nextVersion = app.version;
    devSession.readyTick = performance.now();
    nextReady.resolve(app.handle);
    printReady(devSession);
    await untilStopped(server, app);
  } catch (error) {
    // The socket is this process's to let go of. A run that cannot start is over, and a port held by
    // a process on its way out is a port the next attempt has to work around.
    server.close();
    server.closeAllConnections();
    throw error;
  }
  // Next.js's dev bundler keeps handles of its own, so this process would not end on its own. What
  // was asked for is over.
  process.exit(0);
}
