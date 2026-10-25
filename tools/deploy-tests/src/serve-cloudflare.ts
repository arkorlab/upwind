import { readFileSync } from 'node:fs';

import { startStack } from '@stayingupwind/local';

import { CLOUDFLARE_SERVING } from './local-protocol.ts';

/**
 * A fixture's build served on Cloudflare's runtime, on this machine: the local stack `upwind preview`
 * serves a build on — the edge, the runtime cache, the prefetch Worker and the build's Functions under
 * one Miniflare, on workerd — with images transformed, as an edge bound to Cloudflare Images does.
 *
 * Started by the deploy hook as a process of its own (`local-server.ts`), which outlives the hook: it
 * says where it serves on standard output, and lets its stack go on SIGTERM or SIGINT.
 *
 *   node src/serve-cloudflare.ts <bundle directory> <environment file>
 */

const [bundleDir, envFile] = process.argv.slice(2);
if (bundleDir === undefined || envFile === undefined) {
  throw new Error('usage: node src/serve-cloudflare.ts <bundle directory> <environment file>');
}

// The application's environment — its `.env` files and the suite's variables — as the deploy hook
// wrote it for this process alone (`local-server.ts`).
const env = JSON.parse(readFileSync(envFile, 'utf8')) as Record<string, string>;
const stack = await startStack({
  bundleDir,
  port: 0,
  env,
  images: true,
  signals: 'caller',
  log: (message) => {
    process.stderr.write(`${message}\n`);
  },
});
console.log(`${CLOUDFLARE_SERVING}${stack.url.href}`);

await new Promise<void>((resolve) => {
  process.once('SIGTERM', resolve);
  process.once('SIGINT', resolve);
});
await stack.dispose();
// Ended rather than left to wind down: a stack let go may hold a socket or a timer a moment longer,
// and the cleanup hook is waiting on this process to end.
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- see above.
process.exit(0);
