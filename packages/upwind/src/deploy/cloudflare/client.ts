/**
 * Cloudflare's API, as a deploy calls it: `fetch` against `api.cloudflare.com/client/v4`, a token
 * in a header, and the envelope every answer comes in.
 *
 * Called directly rather than through a CLI of Cloudflare's: neither wrangler, which is to be
 * replaced, nor `cf`, which is in beta and changing, is something a deploy should be pinned to. What
 * a deploy does is a dozen of the API's operations, and those are the API's to keep stable.
 *
 * Every answer but an object's bytes is the envelope: `success`, `errors` (each with a `code` and a
 * `message`), and the `result`. A failure keeps all of it, so a message can say what Cloudflare
 * said rather than what status it chose. A request Cloudflare asks to be made again — 429, or a 5xx
 * — is made again, after the `Retry-After` it gave or a growing wait, when making it twice cannot do
 * twice what once would: every read, and a write that names what it writes. A `POST` that creates
 * is made once unless the caller says it may be repeated.
 */

/** Where the API is; a test points a client somewhere else. */
export const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/** How long a read may take, answer included. */
export const READ_TIMEOUT_MS = 10_000;
/** How long an upload may take — ten minutes: a Function can be tens of megabytes. */
export const UPLOAD_TIMEOUT_MS = 600_000;

const MAX_ATTEMPTS = 5;
const FIRST_WAIT_MS = 1000;
const MAX_WAIT_MS = 30_000;
/** How far a wait is moved either way, so that runs started together do not retry together. */
const JITTER = 0.2;

const SECOND_MS = 1000;

const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR = 500;
const NOT_FOUND = 404;

/** One of the reasons Cloudflare gives for refusing a request. */
export interface ApiMessage {
  readonly code: number;
  readonly message: string;
}

/** A request Cloudflare refused, or answered with something other than what it says it answers. */
export class CloudflareApiError extends Error {
  readonly status: number;
  readonly codes: readonly number[];

  constructor(
    message: string,
    options: ErrorOptions & { readonly status: number; readonly codes: readonly number[] },
  ) {
    super(message, options);
    this.name = 'CloudflareApiError';
    this.status = options.status;
    this.codes = options.codes;
  }

  /** Whether Cloudflare said the thing asked about is not there. */
  get notFound(): boolean {
    return this.status === NOT_FOUND;
  }
}

/** The page a listed answer was, as Cloudflare numbers it. */
export interface ResultInfo {
  readonly page?: number | undefined;
  readonly per_page?: number | undefined;
  readonly total_pages?: number | undefined;
  readonly count?: number | undefined;
  readonly total_count?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface Answer<T> {
  readonly result: T;
  readonly resultInfo: ResultInfo | undefined;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>> | undefined;
  /** JSON, a form, or bytes. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  /** Whether making the request twice does no more than making it once; only reads are, unless said. */
  readonly repeatable?: boolean | undefined;
}

export interface CloudflareClientOptions {
  readonly apiToken: string;
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  /** What a retry waits with; a test makes it instant. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly random?: (() => number) | undefined;
}

export interface CloudflareClient {
  /** A request whose answer is the envelope, and its `result`. */
  request<T>(method: string, path: string, options?: RequestOptions): Promise<Answer<T>>;
  /** A request whose answer is not the envelope — an object's bytes — or nothing where it is absent. */
  raw(method: string, path: string, options?: RequestOptions): Promise<Response | undefined>;
}

interface Envelope {
  readonly success?: boolean;
  readonly errors?: readonly ApiMessage[];
  readonly result?: unknown;
  readonly result_info?: ResultInfo;
}

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The URL of a path, with its query, each value given only where it is set. */
function urlOf(base: string, path: string, query: RequestOptions['query']): string {
  const url = new URL(`${base}${path}`);
  if (query !== undefined) {
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
  }
  return url.href;
}

/** A body as `fetch` takes it, and the content type it is: JSON for anything that is not already a body. */
function bodyOf(body: unknown): {
  readonly body: BodyInit | undefined;
  readonly type: string | undefined;
} {
  if (body === undefined) {
    return { body: undefined, type: undefined };
  }
  if (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof Blob
  ) {
    // A form says its own boundary; bytes and text say nothing and are sent as they are.
    return { body: body as BodyInit, type: undefined };
  }
  return { body: JSON.stringify(body), type: 'application/json' };
}

/** How long Cloudflare asked to be left alone, in milliseconds, if it said. */
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * SECOND_MS;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function describe(
  method: string,
  path: string,
  status: number,
  errors: readonly ApiMessage[],
): string {
  const said = errors.map((error) => `${error.message} (${error.code})`).join('; ');
  const answered = `Cloudflare answered ${method} ${path} with ${status}`;
  return said === '' ? answered : `${answered}: ${said}`;
}

async function envelopeOf(response: Response): Promise<Envelope | undefined> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function createCloudflareClient(options: CloudflareClientOptions): CloudflareClient {
  const base = options.baseUrl ?? API_BASE_URL;
  const send = options.fetch ?? fetch;
  const sleep = options.sleep ?? waitFor;
  const random = options.random ?? Math.random;

  function waitBefore(attempt: number, response: Response | undefined): number {
    const asked = response === undefined ? undefined : retryAfter(response);
    const grown = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (attempt - 1));
    const wait = asked ?? grown;
    return Math.round(wait * (1 + (random() * 2 - 1) * JITTER));
  }

  /** The request, made again as long as Cloudflare asks and it may be. */
  async function exchange(
    method: string,
    path: string,
    request: RequestOptions,
  ): Promise<Response> {
    const { body, type } = bodyOf(request.body);
    const repeatable = request.repeatable ?? (method === 'GET' || method === 'HEAD');
    for (let attempt = 1; ; attempt += 1) {
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${options.apiToken}`);
      if (type !== undefined) {
        headers.set('content-type', type);
      }
      let response: Response;
      try {
        response = await send(urlOf(base, path, request.query), {
          method,
          headers,
          body: body ?? null,
          signal: AbortSignal.timeout(request.timeoutMs ?? READ_TIMEOUT_MS),
        });
      } catch (error) {
        // A connection that failed, or a deadline that passed: nothing was answered, so a request
        // that may be made again is.
        if (!repeatable || attempt >= MAX_ATTEMPTS) {
          throw new CloudflareApiError(
            `${method} ${path} did not reach Cloudflare: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error, status: 0, codes: [] },
          );
        }
        await sleep(waitBefore(attempt, undefined));
        continue;
      }
      const again = response.status === TOO_MANY_REQUESTS || response.status >= SERVER_ERROR;
      if (repeatable && again && attempt < MAX_ATTEMPTS) {
        // Read and dropped: an answer left unread holds its connection.
        await response.body?.cancel();
        await sleep(waitBefore(attempt, response));
        continue;
      }
      return response;
    }
  }

  return {
    async request<T>(
      method: string,
      path: string,
      request: RequestOptions = {},
    ): Promise<Answer<T>> {
      const response = await exchange(method, path, request);
      const envelope = await envelopeOf(response);
      const errors = envelope?.errors ?? [];
      if (!response.ok || envelope?.success !== true) {
        throw new CloudflareApiError(describe(method, path, response.status, errors), {
          status: response.status,
          codes: errors.map((error) => error.code),
        });
      }
      return { result: envelope.result as T, resultInfo: envelope.result_info };
    },
    async raw(
      method: string,
      path: string,
      request: RequestOptions = {},
    ): Promise<Response | undefined> {
      const response = await exchange(method, path, request);
      if (response.status === NOT_FOUND) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) {
        const envelope = await envelopeOf(response);
        const errors = envelope?.errors ?? [];
        throw new CloudflareApiError(describe(method, path, response.status, errors), {
          status: response.status,
          codes: errors.map((error) => error.code),
        });
      }
      return response;
    },
  };
}

/** Every item of a listed answer, page by page, as Cloudflare numbers pages. */
export async function listPages<T>(
  client: CloudflareClient,
  path: string,
  options: { readonly perPage: number; readonly query?: RequestOptions['query'] },
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const answer = await client.request<T[]>('GET', path, {
      query: { ...options.query, page, per_page: options.perPage },
    });
    items.push(...answer.result);
    const pages = answer.resultInfo?.total_pages;
    const done = pages === undefined ? answer.result.length < options.perPage : page >= pages;
    if (done) {
      return items;
    }
  }
}

/** `undefined` where Cloudflare says what was asked about is not there, and the answer otherwise. */
export async function unlessMissing<T>(asking: Promise<T>): Promise<T | undefined> {
  try {
    return await asking;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.notFound) {
      return undefined;
    }
    throw error;
  }
}
