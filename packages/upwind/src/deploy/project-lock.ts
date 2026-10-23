import {
  CloudflareApiError,
  type CloudflareClient,
  type RequestOptions,
} from './cloudflare/client.ts';
import type { AccountScope } from './cloudflare/workers.ts';
import type { ProjectNames } from './names.ts';
import { AGENT_PATHS } from './workers/protocol.ts';

const CLIENT_ERROR = 400;
const SERVER_ERROR = 500;

/**
 * Only a project's account-changing commands use this bucket. It is never bound to a Worker, and
 * never holds objects. R2's REST create refuses an existing name: a successful create owns the
 * exclusion until its one delete. Both requests must be made once, since retrying an uncertain
 * delete could remove a later run's bucket.
 *
 * A write with an unknown outcome also keeps the lock: a rejected promise does not prove the
 * server stopped writing. The guarded account client and agent fetch record these even where a
 * caller catches the failure (such as agent cleanup), and refuse subsequent writes and retries.
 *
 * There is no timeout or takeover. A lost create answer or a stopped process leaves the bucket for
 * an operator to remove, after every command using it has stopped. A read of its presence cannot
 * establish ownership, so an unsuccessful create never releases it.
 */

/** Double hyphens keep this apart from every derived project and application store name. */
export function projectLockBucket(names: ProjectNames): string {
  return `upwind--${names.project}--deploy-lock`;
}

function recovery(bucket: string): string {
  return `after confirming every deploy, rollback and destroy of this project has stopped and any uncertain provider-side mutation has settled, delete the empty R2 bucket ${bucket} by hand before running one again; never delete it while a command may still be running`;
}

/** A write may still be running on the provider, and must not be blindly retried. */
export class ProjectWriteUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectWriteUncertainError';
  }
}

export interface LockedProject {
  readonly scope: AccountScope;
  /** The agent's requests, observed even when its caller catches a failed write. */
  readonly fetch: typeof fetch;
}

function writes(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

function unknownOutcome(error: unknown): boolean {
  return (
    !(error instanceof CloudflareApiError) ||
    error.status === 0 ||
    error.status >= SERVER_ERROR ||
    error.status < CLIENT_ERROR
  );
}

function writeOptions(
  method: string,
  options: RequestOptions | undefined,
): RequestOptions | undefined {
  return writes(method) ? { ...options, repeatable: false } : options;
}

/**
 * Watch every write under the exclusion, including errors a caller handles itself. A negative
 * follow-up read cannot establish that an earlier timed-out mutation will never commit.
 */
function guardedProject(
  scope: AccountScope,
  send: typeof fetch,
  uncertain: Set<string>,
): LockedProject {
  const refuseAfterUncertainty = (): void => {
    if (uncertain.size > 0) {
      throw new ProjectWriteUncertainError(
        'an earlier project write has an unknown outcome; no further writes are made',
      );
    }
  };
  const guard = async <T>(method: string, path: string, call: () => Promise<T>): Promise<T> => {
    const write = writes(method);
    if (write) {
      refuseAfterUncertainty();
    }
    try {
      return await call();
    } catch (error) {
      if (write && unknownOutcome(error)) {
        uncertain.add(`${method} ${path}`);
      }
      throw error;
    }
  };
  const client: CloudflareClient = {
    request: <T>(method: string, path: string, options?: RequestOptions) =>
      guard(method, path, () =>
        scope.client.request<T>(method, path, writeOptions(method, options)),
      ),
    raw: (method, path, options) =>
      guard(method, path, () => scope.client.raw(method, path, writeOptions(method, options))),
  };
  const observed: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    // This POST asks only which blobs are missing. Every other non-read agent route mutates.
    const write =
      writes(request.method) &&
      !(request.method === 'POST' && url.pathname === AGENT_PATHS.missing);
    if (write) {
      refuseAfterUncertainty();
    }
    let response: Response;
    try {
      response = await send(request);
    } catch (error) {
      if (!write) {
        throw error;
      }
      const operation = `${request.method} ${url.host}${url.pathname}`;
      uncertain.add(operation);
      throw new ProjectWriteUncertainError(`${operation} has an unknown outcome`, { cause: error });
    }
    if (write && response.status >= SERVER_ERROR) {
      const operation = `${request.method} ${url.host}${url.pathname}`;
      uncertain.add(operation);
      try {
        await response.body?.cancel();
      } catch {
        // Failure to discard the answer does not make the already uncertain write safe to retry.
      }
      throw new ProjectWriteUncertainError(
        `${operation} answered ${response.status} with an unknown outcome`,
      );
    }
    return response;
  };
  return { scope: { ...scope, client }, fetch: observed };
}

/** Run with account-wide exclusion for this project, before reading its account or stores. */
export async function withProjectLock<T>(
  scope: AccountScope,
  names: ProjectNames,
  run: (held: LockedProject) => Promise<T>,
  io: { readonly fetch?: typeof fetch | undefined } = {},
): Promise<T> {
  const bucket = projectLockBucket(names);
  const path = `/accounts/${encodeURIComponent(scope.accountId)}/r2/buckets`;
  try {
    // https://github.com/cloudflare/workers-sdk/blob/55b3d470da1a8ab32ae9317043dbfbfe73cef00e/packages/wrangler/src/r2/helpers/bucket.ts#L185-L190
    await scope.client.request('POST', path, {
      body: { name: bucket },
      repeatable: false,
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not acquire the project lock ${bucket}: ${why}. Another command may hold it, or an interrupted command may have left it; ${recovery(bucket)}`,
      { cause: error },
    );
  }
  const uncertain = new Set<string>();
  const held = guardedProject(scope, io.fetch ?? fetch, uncertain);
  try {
    return await run(held);
  } finally {
    if (uncertain.size > 0) {
      console.warn(
        `upwind: retained the project lock ${bucket}: a mutating request may still be running (${[...uncertain].join('; ')}). Confirm its provider-side outcome has settled before manual recovery; a negative read is not proof that it finished; ${recovery(bucket)}`,
      );
    } else {
      try {
        await scope.client.request('DELETE', `${path}/${encodeURIComponent(bucket)}`, {
          repeatable: false,
        });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        console.warn(
          `upwind: could not release the project lock ${bucket}: ${why}; ${recovery(bucket)}`,
        );
      }
    }
  }
}
