import { setTimeout as sleep } from 'node:timers/promises';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import type { Miniflare } from 'miniflare';

import { functionWorker } from './function-worker.ts';

/**
 * Two requests for one `"use cache"` entry, in one isolate, the second while the first is still
 * reading it: what the `use-cache-cross-request` patch is for, run in workerd rather than read.
 *
 * The fixture's cache host takes 1.5 s over every read, and the runtime keeps nothing it wrote
 * (`fixtures/next-use-cache-concurrency/cache-host.mjs`), so every request reads the entry from the
 * host. One request fills the entry. Then one reads it, and another asks for it `GAP_MS` later,
 * while that read is under way. Without the patch, Next.js from 16.3 has the second join the
 * first's invocation and tee the body the first read, which workerd refuses — "Cannot perform I/O
 * on behalf of a different request … (I/O type: ReadableStreamSource)" — and the second request is
 * answered 500. With it, each reads the entry for itself, and both are answered from it. Which of
 * the two leads is beside the point: whichever joins the other is the one that fails.
 */

const ENTRY_URL = 'http://use-cache-concurrency.test/api/shared';
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Long enough for the first request to have registered its read, and well inside the 1.5 s the read
 * takes: neither request has more to do before it asks for the entry than to be routed.
 */
const GAP_MS = 200;
const HTTP_OK = 200;

interface Answer {
  readonly status: number;
  readonly body: string;
}

async function read(runtime: Miniflare): Promise<Answer> {
  const response = await runtime.dispatchFetch(ENTRY_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.text() };
}

/** What is wrong with one of the two answers, given the one that filled the entry. */
function problemsOf(which: string, answer: Answer, filled: Answer): string[] {
  if (answer.status !== HTTP_OK) {
    return [`${which} was answered ${String(answer.status)}`];
  }
  return answer.body === filled.body
    ? []
    : [`${which} was answered ${answer.body}, not the entry the first request filled`];
}

export async function useCacheConcurrencyHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  const { Miniflare } = await import('miniflare');
  const runtime = new Miniflare({
    workers: [await functionWorker('use-cache-concurrency', bundle.functions.app, out)],
  });
  try {
    const filled = await read(runtime);
    if (filled.status !== HTTP_OK) {
      return [`the request that fills the entry was answered ${String(filled.status)}`];
    }
    const meanwhile = async (): Promise<Answer> => {
      await sleep(GAP_MS);
      return read(runtime);
    };
    const [first, second] = await Promise.all([read(runtime), meanwhile()]);
    return [
      ...problemsOf('the request reading the entry', first, filled),
      ...problemsOf('the request that asked for it during that read', second, filled),
    ];
  } finally {
    await runtime.dispose();
  }
}
