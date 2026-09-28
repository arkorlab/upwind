import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Print a test application's own environment, as Next.js itself reads it.
 *
 * A child process, and `@next/env` resolved from the application rather than from this repository: the
 * application is a copy the suite's harness made somewhere under the temporary directory, with its own
 * `next` installed, and which `.env` files count for a production build is that version's question to
 * answer. This tool depends on no Next.js of its own.
 *
 *   node read-env.ts <application directory>
 */

interface NextEnv {
  loadEnvConfig(
    dir: string,
    dev: boolean,
    log: { info: (message: string) => void; error: (message: string) => void },
    forceReload: boolean,
  ): { combinedEnv: Record<string, string | undefined> };
}

const given = process.argv[2];
if (given === undefined) {
  throw new Error('usage: node read-env.ts <application directory>');
}
// Absolute, because `createRequire` takes nothing else, and because a relative path would be read
// against this process's own directory rather than the application's.
const appDir = path.resolve(given);

function silent(): void {
  // The parent reads only the JSON on standard output.
}

// Through `next` rather than straight from the application: `@next/env` is a dependency of Next.js, not
// of the application, and an installer that does not hoist — pnpm — leaves it reachable only from where
// `next` itself is. So resolve `next` from the application, and `@next/env` from there.
const fromApp = createRequire(path.join(appDir, 'package.json'));
const nextEnv = createRequire(fromApp.resolve('next/package.json'))('@next/env') as NextEnv;
const loaded = nextEnv.loadEnvConfig(appDir, false, { info: silent, error: silent }, true);
process.stdout.write(JSON.stringify(loaded.combinedEnv));
