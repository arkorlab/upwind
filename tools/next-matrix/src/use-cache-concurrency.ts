import type { DeploymentBundle } from '@stayingupwind/core/bundle';
import type { Miniflare } from 'miniflare';

import { functionWorker } from './function-worker.ts';

/**
 * Two requests for one `"use cache"` entry, in one isolate, the second while the first is still
 * reading it: what the `use-cache-cross-request` patch is for, run in workerd rather than read.
 *
 * The fixture's cache host tells this of every read before it answers it, through a binding given
 * the Function, with the key and the request the read is for, and goes on only once this answers
 * (`fixtures/next-use-cache-concurrency/cache-host.mjs`). The runtime keeps nothing it wrote, so
 * every request reads the entry from the host. One request fills the entry, its reads let through.
 * Then reads are held: the first request is sent, the second only once the first's read has begun,
 * and the second's own read of the same key is waited for while the first's is still held. Only
 * then are both let go on, and both requests have to be answered from the entry.
 *
 * Without the patch, Next.js from 16.3 has the second request join the first's invocation rather
 * than read: no read of its own begins, and once the first's is let go it tees the body the first
 * read, which workerd refuses — "Cannot perform I/O on behalf of a different request … (I/O type:
 * ReadableStreamSource)" — and it is answered 500.
 *
 * Nothing here waits for a time it hopes is long enough. A pass is a run in which the second
 * request's read was seen to begin while the first's was held, which is the overlap the patch is
 * for; a run that cannot show that fails. The bounds below only end a wait for what is not coming.
 */

const ENTRY_URL = 'http://use-cache-concurrency.test/api/shared';
/** The binding the cache host tells of its reads through (`READS` there). */
const READS_BINDING = 'UPWIND_MATRIX_READS';
/** The header each request is named by, which the cache host reads back for every read. */
const REQUEST_HEADER = 'x-next-matrix-request';
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a request sent while reads are held has to begin a read of its own. A warm isolate
 * routes one to its read in milliseconds; a build without the patch waits all of this for the
 * second request, which joins the first instead of reading.
 */
const READ_WAIT_MS = 10_000;
const MS_PER_SECOND = 1000;
/** How much of a failed answer's body a problem quotes: enough for the reason a runtime gives. */
const BODY_EXCERPT = 200;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

/** A request this sends: the name the cache host reads back, and how a problem says it. */
interface Sent {
  readonly name: string;
  readonly says: string;
}

const FILL: Sent = { name: 'fill', says: 'the request that fills the entry' };
const FIRST: Sent = { name: 'first', says: 'the first request' };
const SECOND: Sent = { name: 'second', says: 'the second request' };

/** What a request came to: its status and body, or, never answered, what kept it from one. */
type Answer =
  | { readonly status: number; readonly body: string }
  | { readonly status: undefined; readonly failure: string };

/** What the cache host says of a read as it begins. */
interface Told {
  readonly key: string;
  readonly request?: string;
}

/** A read the cache host began: its key, the request it is for, and what lets it go on. */
interface Read {
  readonly key: string;
  readonly request: string | undefined;
  readonly release: () => void;
}

/**
 * The cache host's reads, as its binding hears of them. Each goes on at once until `hold`, and from
 * then on only at `releaseAll`, after which every read goes on at once again: nothing is left
 * waiting on a run that has stopped watching.
 */
class Reads {
  readonly #begun: Read[] = [];
  readonly #awaited = new Map<string, PromiseWithResolvers<Read>>();
  #holding = false;

  /** What hands `request`'s first read to a wait for it, made by whichever of the two comes first. */
  #of(request: string): PromiseWithResolvers<Read> {
    let awaited = this.#awaited.get(request);
    if (awaited === undefined) {
      awaited = Promise.withResolvers();
      this.#awaited.set(request, awaited);
    }
    return awaited;
  }

  /** One read beginning: settles once it may go on. */
  async begin({ key, request }: Told): Promise<void> {
    const released: PromiseWithResolvers<void> = Promise.withResolvers();
    const read: Read = { key, request, release: released.resolve };
    this.#begun.push(read);
    if (request !== undefined) {
      // The first read of a request is the one waited for; settling it again changes nothing.
      this.#of(request).resolve(read);
    }
    if (!this.#holding) {
      released.resolve();
    }
    await released.promise;
  }

  /** The first read `request` began, once it has. */
  of(request: string): Promise<Read> {
    return this.#of(request).promise;
  }

  /** How many reads named no request: reads nothing here can say whose they were. */
  get unnamed(): number {
    return this.#begun.filter((read) => read.request === undefined).length;
  }

  hold(): void {
    this.#holding = true;
  }

  releaseAll(): void {
    this.#holding = false;
    for (const read of this.#begun) {
      read.release();
    }
  }
}

/**
 * One request, named for the cache host. It never rejects: a request that fails while another is
 * waited for would reject with nothing listening yet, and Node ends the process for that.
 */
async function send(runtime: Miniflare, which: Sent): Promise<Answer> {
  try {
    const response = await runtime.dispatchFetch(ENTRY_URL, {
      headers: { [REQUEST_HEADER]: which.name },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: undefined, failure: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whichever came first of a request's read beginning and its answer, told apart by the `status`
 * only an answer has; `undefined` for neither within `READ_WAIT_MS`.
 */
async function readOrAnswer(
  read: Promise<Read>,
  answer: Promise<Answer>,
): Promise<Read | Answer | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const lapsed = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, READ_WAIT_MS);
  });
  try {
    return await Promise.race([read, answer, lapsed]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a request sent while reads were held showed no read of its own: it was answered first, or
 * nothing came of it within `READ_WAIT_MS`. A read that named no request may have been its own,
 * which is said rather than left to look like no read at all.
 */
function unread(which: Sent, answered: boolean, reads: Reads, during: string): string {
  if (answered) {
    return `${which.says} was answered before a read of its own began${during}`;
  }
  const unnamed =
    reads.unnamed === 0
      ? ''
      : `; ${String(reads.unnamed)} read(s) named no request, and whose they were is not known`;
  const waited = `${String(READ_WAIT_MS / MS_PER_SECOND)} s`;
  return `${which.says} began no read of its own in ${waited}${during}${unnamed}`;
}

/** What is wrong with one answer, given the entry the fill was answered with, where there is one. */
function problemsOf(which: Sent, answer: Answer, filled?: string): string[] {
  if (answer.status === undefined) {
    return [`${which.says} was not answered: ${answer.failure}`];
  }
  if (answer.status !== HTTP_OK) {
    const said = answer.body.trim().slice(0, BODY_EXCERPT);
    const why = said === '' ? '' : `: ${said}`;
    return [`${which.says} was answered ${String(answer.status)}${why}`];
  }
  return filled === undefined || answer.body === filled
    ? []
    : [`${which.says} was answered ${answer.body}, not the entry the fill wrote`];
}

async function race(runtime: Miniflare, reads: Reads): Promise<string[]> {
  const filled = await send(runtime, FILL);
  if (filled.status !== HTTP_OK) {
    return problemsOf(FILL, filled);
  }
  reads.hold();
  const first = send(runtime, FIRST);
  const firstRead = await readOrAnswer(reads.of(FIRST.name), first);
  if (firstRead === undefined || 'status' in firstRead) {
    reads.releaseAll();
    return [
      unread(FIRST, firstRead !== undefined, reads, ''),
      ...problemsOf(FIRST, await first, filled.body),
    ];
  }
  const second = send(runtime, SECOND);
  const secondRead = await readOrAnswer(reads.of(SECOND.name), second);
  const overlap: string[] = [];
  if (secondRead === undefined || 'status' in secondRead) {
    const during = " while the first request's read was held";
    overlap.push(unread(SECOND, secondRead !== undefined, reads, during));
  } else if (secondRead.key !== firstRead.key) {
    overlap.push(`${SECOND.says} read another key than the first request's held read`);
  }
  reads.releaseAll();
  return [
    ...overlap,
    ...problemsOf(FIRST, await first, filled.body),
    ...problemsOf(SECOND, await second, filled.body),
  ];
}

export async function useCacheConcurrencyHolds(
  bundle: DeploymentBundle,
  _dependencies: unknown,
  out: string,
): Promise<string[]> {
  const { Miniflare, Response } = await import('miniflare');
  const reads = new Reads();
  const runtime = new Miniflare({
    workers: [
      await functionWorker('use-cache-concurrency', bundle.functions.app, out, {
        [READS_BINDING]: {
          type: 'fetcher',
          handler: async (request) => {
            await reads.begin((await request.json()) as Told);
            return new Response(null, { status: HTTP_NO_CONTENT });
          },
        },
      }),
    ],
  });
  try {
    return await race(runtime, reads);
  } finally {
    // A read still held is a request still under way: let every one go before the runtime does.
    reads.releaseAll();
    await runtime.dispose();
  }
}
