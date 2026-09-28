import { setTimeout as sleepFor } from 'node:timers/promises';

import type { DeploymentBundle } from '@stayingupwind/core/bundle';

import type { Config } from './config.ts';
import { asRecord, asString, asStrings, optionalRecord, optionalString } from './shapes.ts';

/**
 * The host's public API, as much of it as deploying a fixture takes: six calls, a bearer token, and
 * the two retries the protocol asks for.
 *
 * Deliberately not a restatement of the API's contract. The platform publishes an OpenAPI document and
 * a typed client of its own; this reads the handful of fields it acts on and nothing else, so that a
 * field added, renamed or reordered upstream is not a thing this has to be taught.
 */

const USER_AGENT = 'upwind-deploy-tests/1.0';

/**
 * How a refusal for going too fast is waited out.
 *
 * The API turns away a flood before it reaches anything expensive: a fixed number of requests per
 * minute, per token and per address. A deployment is the one thing a client does that is naturally a
 * burst — a bundle may name thousands of blobs, and each is a request — so a deployer that treated a
 * `429` as a failure would turn a large first deployment into a manual retry loop. It is not an error;
 * it is the API asking for a moment.
 *
 * No `retry-after` comes back, so the wait is this side's guess: it starts under the window, doubles,
 * and stops growing well inside it, because the counter is a rolling minute and a longer sleep buys
 * nothing.
 */
const RATE_LIMIT_ATTEMPTS = 8;
const RATE_LIMIT_FIRST_WAIT_MS = 2000;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/**
 * How a call that never reached the API is made again.
 *
 * `fetch` reports everything below HTTP as a `TypeError` — a name that did not resolve, a connection
 * that timed out, a socket that closed part way through an answer. None of that is the API refusing
 * anything, and every one of these calls may be made twice without harm: a deployment is named by an
 * id this side minted, a blob is its own digest, and a finalize that arrives after the deployment
 * began answers with what began. So the call is simply made again — a few times, briefly, since a
 * network that is down stays down and somebody is waiting.
 */
const NETWORK_ATTEMPTS = 4;
const NETWORK_FIRST_WAIT_MS = 500;

/**
 * How a failure of the platform's own is waited out.
 *
 * A `5xx` says nothing about what was asked, and every call here may be made twice without harm for
 * the same reasons a network retry is safe: a deployment is named by an id this side minted, a blob is
 * its own digest, a finalize after the fact answers with what began, and reading is reading. A run of
 * this suite is hours long and deploys hundreds of times; losing one fixture to one bad gateway is a
 * failure of this tool's making, not an observation about the adapter.
 *
 * Fewer attempts and a shorter first wait than a rate limit, which is a refusal with a window behind
 * it. This is either a moment or a real fault, and a real fault should be reported rather than sat on.
 */
const SERVER_ATTEMPTS = 4;
const SERVER_FIRST_WAIT_MS = 1000;
const SERVER_MAX_WAIT_MS = 8000;
const SERVER_ERROR = 500;

export interface ApiErrorOptions extends ErrorOptions {
  readonly code: string;
  readonly status: number;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, options);
    this.name = 'ApiError';
    this.code = options.code;
    this.status = options.status;
  }
}

/** What a project's own answer says, of the parts a deployment is judged by. */
export interface ProjectDetail {
  readonly id: string;
  /** The hostname the host serves this project on; where the suite sends its requests. */
  readonly previewUrl: string;
  /** Which deployment the project answers with, and whether it answers at all. */
  readonly active: { readonly deploymentId: string | undefined; readonly mode: string } | undefined;
}

export interface EnvEntry {
  readonly name: string;
  /** `null` for a value the API will not read back; putting `null` back keeps what is stored. */
  readonly value: string | null;
  readonly secret: boolean;
}

export interface DeploymentDetail {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly errorMessage: string | undefined;
  /** The step it is on, or nothing between steps: progress, for the wait to be judged by. */
  readonly currentStep: string | undefined;
}

export interface Client {
  getProject(): Promise<ProjectDetail>;
  getEnv(): Promise<EnvEntry[]>;
  putEnv(env: readonly EnvEntry[]): Promise<void>;
  /** Registers the bundle; answers the digests the host does not already hold. */
  createDeployment(bundle: DeploymentBundle): Promise<string[]>;
  putBlob(deploymentId: string, sha256: string, bytes: Uint8Array): Promise<void>;
  finalize(deploymentId: string): Promise<string>;
  getDeployment(deploymentId: string): Promise<DeploymentDetail>;
}

export interface ClientOptions {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'rate_limited';
}

/**
 * `fetch` wraps what actually went wrong as the `cause` of a `TypeError`. A `TypeError` without one is
 * this file's own bug, and repeating a bug four times is not a retry.
 */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && error.cause !== undefined;
}

function isServerFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status >= SERVER_ERROR;
}

async function retrying<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  options: { attempts: number; first: number; max: number; retry: (error: unknown) => boolean },
): Promise<T> {
  let wait = options.first;
  for (let attempt = 1; attempt < options.attempts; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (!options.retry(error)) {
        throw error;
      }
      await sleep(wait);
      wait = Math.min(wait * 2, options.max);
    }
  }
  // The last attempt is outside the loop so that what reaches the caller is the failure itself, rather
  // than a sentence of this file's invention about how many tries it had.
  return call();
}

/** A refusal, with the code it carries and nothing else of what it said. */
function refusalOf(status: number, body: string): ApiError {
  let code = 'unknown';
  try {
    const error = optionalRecord(asRecord(JSON.parse(body))['error']);
    code = error === undefined ? code : (optionalString(error['code']) ?? code);
  } catch {
    // A body that is not the API's shape says nothing beyond the status, which is enough to act on.
  }
  return new ApiError(`HTTP ${String(status)} (${code})`, { code, status });
}

export function createClient(config: Config, options: ClientOptions = {}): Client {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number): Promise<void> => sleepFor(ms));

  async function once(
    method: string,
    path: string,
    body?: BodyInit,
    contentType?: string,
  ): Promise<unknown> {
    const response = await fetchImpl(new URL(path, config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        'user-agent': USER_AGENT,
        ...(contentType !== undefined && { 'content-type': contentType }),
      },
      ...(body !== undefined && { body }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw refusalOf(response.status, text);
    }
    return text === '' ? {} : (JSON.parse(text) as unknown);
  }

  function request(
    method: string,
    path: string,
    body?: BodyInit,
    contentType?: string,
  ): Promise<unknown> {
    function arrived(): Promise<unknown> {
      return retrying(() => once(method, path, body, contentType), sleep, {
        attempts: NETWORK_ATTEMPTS,
        first: NETWORK_FIRST_WAIT_MS,
        max: NETWORK_FIRST_WAIT_MS * 2 ** NETWORK_ATTEMPTS,
        retry: isNetworkFailure,
      });
    }
    function answered(): Promise<unknown> {
      return retrying(arrived, sleep, {
        attempts: SERVER_ATTEMPTS,
        first: SERVER_FIRST_WAIT_MS,
        max: SERVER_MAX_WAIT_MS,
        retry: isServerFailure,
      });
    }
    // Innermost first: a call that never arrived has not used the API's patience at all, a `5xx` has
    // used none of its window either, and a rate limit is the one that wants the longest wait — so it
    // is the budget the other two spend inside.
    return retrying(answered, sleep, {
      attempts: RATE_LIMIT_ATTEMPTS,
      first: RATE_LIMIT_FIRST_WAIT_MS,
      max: RATE_LIMIT_MAX_WAIT_MS,
      retry: isRateLimited,
    });
  }

  const project = `/v1/projects/${config.projectId}`;
  return {
    async getProject(): Promise<ProjectDetail> {
      const answer = asRecord(await request('GET', project));
      const detail = asRecord(answer['project']);
      const active = optionalRecord(answer['active']);
      return {
        id: asString(detail['id']),
        previewUrl: asString(detail['previewUrl']),
        active:
          active === undefined
            ? undefined
            : {
                deploymentId: optionalString(optionalRecord(active['app'])?.['deploymentId']),
                mode: optionalString(active['mode']) ?? 'unknown',
              },
      };
    },
    async getEnv(): Promise<EnvEntry[]> {
      const answer = asRecord(await request('GET', `${project}/env`));
      const entries = answer['env'];
      if (!Array.isArray(entries)) {
        throw new TypeError('the API answered no environment');
      }
      return entries.map((entry) => {
        const record = asRecord(entry);
        return {
          name: asString(record['name']),
          value: optionalString(record['value']) ?? null,
          secret: record['secret'] === true,
        };
      });
    },
    async putEnv(env: readonly EnvEntry[]): Promise<void> {
      await request('PUT', `${project}/env`, JSON.stringify({ env }), 'application/json');
    },
    async createDeployment(bundle: DeploymentBundle): Promise<string[]> {
      const answer = asRecord(
        await request('POST', `${project}/deployments`, JSON.stringify(bundle), 'application/json'),
      );
      return asStrings(answer['missing']);
    },
    async putBlob(deploymentId: string, sha256: string, bytes: Uint8Array): Promise<void> {
      // The content type a blob is served under comes from the bundle, which the host already holds;
      // what travels here is the bytes.
      await request(
        'PUT',
        `${project}/deployments/${deploymentId}/blobs/${sha256}`,
        bytes as BodyInit,
        'application/octet-stream',
      );
    },
    async finalize(deploymentId: string): Promise<string> {
      const answer = asRecord(
        await request('POST', `${project}/deployments/${deploymentId}/finalize`),
      );
      return asString(asRecord(answer['run'])['id']);
    },
    async getDeployment(deploymentId: string): Promise<DeploymentDetail> {
      const answer = asRecord(await request('GET', `${project}/deployments/${deploymentId}`));
      const detail = asRecord(answer['deployment']);
      const run = optionalRecord(answer['run']);
      return {
        id: asString(detail['id']),
        projectId: asString(detail['projectId']),
        status: asString(detail['status']),
        errorMessage: optionalString(optionalRecord(detail['error'])?.['message']),
        currentStep: optionalString(run?.['currentStep']),
      };
    },
  };
}
