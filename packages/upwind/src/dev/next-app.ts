import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type createNextServer from 'next';

import { packageVersion } from '../manifest.ts';
import { installNextResourceCacheLoader } from '../resources/next-cache-loader.ts';

/**
 * Next.js's development server, run the way Next.js documents a custom server: `next({ dev: true })`,
 * `prepare()`, then a request handler this process calls for anything the front door does not answer
 * itself.
 *
 * That API is a thin wrapper over the same `getRequestHandlers` the `next dev` worker runs, so the
 * dev bundler, HMR and the error overlay are the ones Next.js would have used — in this process, on
 * this port, with no second server and no proxy hop in between. What it does not bring is the work
 * `next dev`'s *parent* does: the banner, and restarting on a config change or on the overlay's
 * request. Those are `banner.ts`, `config-watch.ts` and `supervise.ts` here.
 *
 * Everything is resolved from the project rather than from this package: the Next.js that runs an
 * application must be the copy the application itself depends on, whatever `upwind` is installed
 * beside.
 */

/**
 * `next`'s own default export — the factory a custom server calls.
 *
 * Imported for its type only. The module itself is loaded from the project at startup, so the types
 * come from whichever copy this package was installed beside and the code from the project's own.
 */
type NextFactory = typeof createNextServer;
type NextApp = ReturnType<NextFactory>;
/** What Next.js hands back to answer a request with. */
export type NextHandler = ReturnType<NextApp['getRequestHandler']>;

export interface RunningNext {
  readonly handle: NextHandler;
  readonly version: string | undefined;
  close: () => Promise<void>;
}

/**
 * Resolve a module as the project would, or nothing when the project has no such package.
 *
 * Rooted at the project's `package.json` so resolution starts in the project directory even when
 * `upwind` was invoked from somewhere else.
 */
export function resolveFromProject(projectDir: string, specifier: string): string | undefined {
  try {
    return createRequire(path.join(projectDir, 'package.json')).resolve(specifier);
  } catch {
    return undefined;
  }
}

export async function startNextApp(options: {
  readonly projectDir: string;
  readonly hostname: string | undefined;
  readonly port: number;
  readonly httpServer: Server;
}): Promise<RunningNext> {
  const entry = resolveFromProject(options.projectDir, 'next');
  if (entry === undefined) {
    // No prefix: one place prints these, and it is the one that says whose message it is (`cli.ts`).
    throw new Error(
      `no \`next\` is installed in ${options.projectDir} — \`upwind dev\` runs the project's own Next.js, so install it there first`,
    );
  }
  installNextResourceCacheLoader();
  const module = (await import(pathToFileURL(entry).href)) as { default: NextFactory };
  const app = module.default({
    dev: true,
    dir: options.projectDir,
    port: options.port,
    // Handed over so Next.js puts its own `upgrade` listener on this server: HMR and the error
    // overlay speak over a WebSocket, and that connection is Next.js's to answer. Nothing of
    // `/__upwind` is served over one, which is why there is no second listener competing for it.
    httpServer: options.httpServer,
    // Neither the bundler nor the environment is named here, because neither needs to be. The factory
    // sets `TURBOPACK` to `auto` for a custom server, which is Next 16's own default, and Next.js sets
    // `NODE_ENV` itself: with `NODE_ENV` unset in the environment, an `upwind dev` and a `next dev` in
    // the same project both report `development` and Turbopack to the application. Forcing either would
    // only take the choice away from a project that had made it.
    ...(options.hostname !== undefined && { hostname: options.hostname }),
  });
  await app.prepare();
  const manifest = resolveFromProject(options.projectDir, 'next/package.json');
  return {
    handle: app.getRequestHandler(),
    version: manifest === undefined ? undefined : await packageVersion(manifest),
    close: async () => app.close(),
  };
}
