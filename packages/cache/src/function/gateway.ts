import { sha256Hex } from '@stayingupwind/core/artifact';
import { TEST_CLOCK_HEADER } from '@stayingupwind/core/paas';
import { isDeadlineError, toBase64, withDeadline } from '@stayingupwind/core/util';
import {
  ARTIFACT_ENCODING_HEADER,
  ARTIFACT_ROLE_HEADER,
  CACHE_SCOPE_HEADER,
  type CommitRequest,
  type CommitResponse,
  commitResponseSchema,
  type DataGetRequest,
  type DataGetResponse,
  dataGetResponseSchema,
  type DataSetRequest,
  type DataSetResponse,
  dataSetResponseSchema,
  deltaMovesOn,
  type TagsGetResponse,
  tagsGetResponseSchema,
  type FailRequest,
  type FailResponse,
  failResponseSchema,
  FENCING_TOKEN_HEADER,
  gatewayErrorSchema,
  gatewayScopePath,
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type InvalidateRequest,
  type InvalidateResponse,
  invalidateResponseSchema,
  NO_SUCH_ENDPOINT,
  type StartAttemptRequest,
  type StartAttemptResponse,
  startAttemptResponseSchema,
  type TagRevision,
  tagRevisionSchema,
  type TagsDeltaResponse,
  tagsDeltaResponseSchema,
  uploadArtifactsResponseSchema,
} from '@stayingupwind/host/cache';
import {
  type ArtifactUpload,
  CacheHostError,
  type FetchLike,
  nativeFetch,
  requestClock,
  type UploadedArtifact,
} from '@stayingupwind/runtime/cache-host';

import { ArtifactCopies, type FunctionCacheNaming } from './artifacts.ts';

/**
 * The cache gateway as this Worker speaks to it: every route under the deployment's own scope,
 * every request carrying the scope's token. Nothing here runs on a visitor's path through the
 * edge; a regeneration, a data-cache read or an invalidation is what reaches it.
 */

export interface GatewayOptions {
  /** What the host names the artifacts' copies by (`ArtifactCopies`). */
  readonly naming: FunctionCacheNaming;
  readonly gatewayUrl: string;
  readonly readGatewayUrl?: string | undefined;
  readonly scopeId: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike | undefined;
  /**
   * How the read gateway is reached, when there is one.
   *
   * It travels separately from `fetchImpl` because the two are separate Workers and a deployment
   * may be given a service binding to one and a URL for the other: the read gateway asks for no
   * placement and is safe to bind under any circumstance, where the authority's own gateway may be
   * placed and has more to lose. Inheriting the authority's transport here would send the read to
   * the authority carrying the read gateway's URL — which it would answer, from wherever it is
   * placed, correctly and far too late. So this is left out only together with `readGatewayUrl`,
   * where reads go to the authority because that is genuinely where they go; a `readGatewayUrl`
   * given without it is refused.
   */
  readonly readFetchImpl?: FetchLike | undefined;
}

const HTTP_NOT_FOUND = 404;
const JSON_TYPE = 'application/json';
/**
 * How long a render waits for a value of the data cache, or for the invalidations of its tags,
 * before it goes on without them.
 *
 * Both are one read of KV in the render's own data center, through a Worker that runs where its
 * caller does: a few milliseconds when KV holds the key there, and on the order of a hundred when
 * it reads it from further up — Cloudflare reported 250 ms at p99 for reads that reach its storage
 * (changelog, 2025-08-22). A read the gateway is still on past this is one the render stops waiting
 * for and fails, which the runtime takes for a miss that is not remembered: the render makes the
 * value itself, as it would with no cache at all, rather than wait on a read that may not come.
 */
const READ_DEADLINE_MS = 300;
/**
 * The same wait where there is no read gateway and reads go to the authority itself
 * (`readGatewayUrl` left out): a placed Worker answering from its own region, so a read from across
 * the world spends a round trip of up to a few hundred milliseconds before the authority reads
 * anything. Held to the local read's 300 ms, every such read there would be a miss.
 */
const AUTHORITY_READ_DEADLINE_MS = 1000;

/**
 * `read`, given up once it has taken `deadlineMs`, and the request under it with it: it rejects
 * with the deadline's error, and the signal it was handed is aborted, so a gateway that has not
 * answered holds no connection of the render's. The race is what bounds the wait, whatever the
 * transport makes of the signal.
 */
async function readWithin<T>(
  what: string,
  deadlineMs: number,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await withDeadline(read(controller.signal), deadlineMs, what);
  } catch (error) {
    if (isDeadlineError(error)) {
      controller.abort(error);
    }
    throw error;
  }
}

interface Envelope {
  readonly ok?: unknown;
  readonly result?: unknown;
}

/** What a result is checked against: the contract's zod schema, by the one method used of it. */
interface Schema<T> {
  parse(input: unknown): T;
}

export class Gateway {
  readonly #base: string;
  readonly #readBase: string;
  readonly #token: string;
  readonly #scopeId: string;
  readonly #fetch: FetchLike;
  readonly #readFetch: FetchLike;
  /** How long a read waits: on a read gateway beside the render, or on the authority itself. */
  readonly #readDeadlineMs: number;
  readonly #artifacts: ArtifactCopies;

  constructor(options: GatewayOptions) {
    if (options.readGatewayUrl !== undefined && options.readFetchImpl === undefined) {
      throw new Error('a read gateway URL needs a transport of its own (`readFetchImpl`)');
    }
    this.#base = `${options.gatewayUrl.replace(/\/$/u, '')}${gatewayScopePath(options.scopeId)}`;
    this.#readBase = `${(options.readGatewayUrl ?? options.gatewayUrl).replace(/\/$/u, '')}${gatewayScopePath(options.scopeId)}`;
    this.#token = options.token;
    this.#scopeId = options.scopeId;
    this.#fetch = options.fetchImpl ?? ((request) => nativeFetch(request));
    this.#readFetch = options.readFetchImpl ?? this.#fetch;
    this.#readDeadlineMs =
      options.readGatewayUrl === undefined ? AUTHORITY_READ_DEADLINE_MS : READ_DEADLINE_MS;
    this.#artifacts = new ArtifactCopies(
      options.scopeId,
      (artifactId, signal) => this.#artifactFromAuthority(artifactId, signal),
      options.naming,
    );
  }

  #headers(extra: Record<string, string> = {}): Headers {
    const headers = new Headers(extra);
    headers.set('authorization', `Bearer ${this.#token}`);
    headers.set(CACHE_SCOPE_HEADER, this.#scopeId);
    const clock = requestClock();
    if (clock !== undefined) {
      headers.set(TEST_CLOCK_HEADER, String(clock));
    }
    return headers;
  }

  async #send(path: string, init: RequestInit, local = false): Promise<Response> {
    const send = local ? this.#readFetch : this.#fetch;
    return send(new Request(`${local ? this.#readBase : this.#base}${path}`, init));
  }

  /** The result of a call, checked against its schema; a refusal becomes a `CacheHostError`. */
  async #result<T>(response: Response, schema: Schema<T>): Promise<T> {
    const body = (await response.json()) as Envelope;
    if (!response.ok || body.ok !== true) {
      throw this.#refusal(response, body);
    }
    return schema.parse(body.result);
  }

  /**
   * A response already known to have failed, as the error it stands for. Read separately from
   * `#result` for the calls whose success is bytes rather than an envelope: there is no result
   * schema to hand such a call, and passing an unrelated one only to reach this path made the
   * schema look load-bearing.
   */
  async #throwFailure(response: Response): Promise<never> {
    throw await this.#failureOf(response);
  }

  /** A response already known to have failed, as the error it stands for (`#throwFailure`). */
  async #failureOf(response: Response): Promise<CacheHostError> {
    let body: Envelope = {};
    try {
      body = (await response.json()) as Envelope;
    } catch {
      // A refusal with no JSON body says only its status, which is what the fallback below says.
    }
    return this.#refusal(response, body);
  }

  #refusal(response: Response, body: Envelope): CacheHostError {
    const refusal = gatewayErrorSchema.safeParse(body);
    return new CacheHostError(
      refusal.success ? refusal.data.error.message : `cache gateway answered ${response.status}`,
      { code: refusal.success ? refusal.data.error.code : 'internal', status: response.status },
    );
  }

  async #json<T>(
    method: 'POST' | 'PUT',
    path: string,
    payload: unknown,
    schema: Schema<T>,
  ): Promise<T> {
    const response = await this.#send(path, {
      method,
      headers: this.#headers({ 'content-type': JSON_TYPE }),
      body: JSON.stringify(payload),
    });
    return this.#result(response, schema);
  }

  /** An artifact's bytes as the authority answers them: `undefined` when it holds none. */
  async #artifactFromAuthority(
    artifactId: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    const response = await this.#send(`/artifacts/${artifactId}`, {
      method: 'GET',
      headers: this.#headers(),
      ...(signal !== undefined && { signal }),
    });
    if (response.status === HTTP_NOT_FOUND) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await this.#throwFailure(response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  startAttempt(request: StartAttemptRequest): Promise<StartAttemptResponse> {
    return this.#json('POST', '/attempts', request, startAttemptResponseSchema);
  }

  async uploadArtifact(upload: ArtifactUpload): Promise<UploadedArtifact> {
    const sha256 = await sha256Hex(upload.bytes);
    const response = await this.#send(`/attempts/${upload.attemptId}/artifacts/${sha256}`, {
      method: 'PUT',
      headers: this.#headers({
        'content-type': upload.contentType,
        [ARTIFACT_ROLE_HEADER]: upload.role,
        [ARTIFACT_ENCODING_HEADER]: 'identity',
        [FENCING_TOKEN_HEADER]: String(upload.fencingToken),
      }),
      body: upload.bytes as BodyInit,
    });
    if (!response.ok) {
      await this.#throwFailure(response);
    }
    return { sha256, byteLength: upload.bytes.byteLength };
  }

  /**
   * Several of one attempt's artifacts in one request (`uploadArtifactsRequestSchema`), answered in
   * their order; a gateway from before the call throws `unsupported`, as `CacheHost` says, and the
   * runtime uploads each on its own.
   */
  async uploadArtifacts(uploads: readonly ArtifactUpload[]): Promise<UploadedArtifact[]> {
    const [first] = uploads;
    if (first === undefined) {
      return [];
    }
    const artifacts = await Promise.all(
      uploads.map(async (upload) => {
        return {
          role: upload.role,
          sha256: await sha256Hex(upload.bytes),
          contentType: upload.contentType,
          bytes: toBase64(upload.bytes),
        };
      }),
    );
    const response = await this.#send(`/attempts/${first.attemptId}/artifacts`, {
      method: 'POST',
      headers: this.#headers({ 'content-type': JSON_TYPE }),
      body: JSON.stringify({ fencingToken: first.fencingToken, artifacts }),
    });
    // Its status before its body, which a gateway's answer may not have as JSON. A gateway from
    // before the call has no such route — its answer to one it does not have, or a 404 with no
    // envelope from whatever stands in front of it — and the runtime is told so as the contract
    // says (`unsupported`), where a `not_found` of the attempt is the attempt's to fail on.
    if (!response.ok) {
      const failure = await this.#failureOf(response);
      const noSuchRoute =
        response.status === HTTP_NOT_FOUND &&
        (failure.code === 'internal' || failure.message === NO_SUCH_ENDPOINT);
      throw noSuchRoute
        ? new CacheHostError('the gateway takes no batch of uploads', {
            code: 'unsupported',
            status: response.status,
          })
        : failure;
    }
    return (await this.#result(response, uploadArtifactsResponseSchema)).artifacts;
  }

  /** Say the attempt is still going, so the authority does not give its lease to someone else. */
  heartbeat(attemptId: string, fencingToken: number): Promise<HeartbeatResponse> {
    return this.#json(
      'POST',
      `/attempts/${attemptId}/heartbeat`,
      { fencingToken },
      heartbeatResponseSchema,
    );
  }

  commit(attemptId: string, request: CommitRequest): Promise<CommitResponse> {
    return this.#json('POST', `/attempts/${attemptId}/commit`, request, commitResponseSchema);
  }

  fail(attemptId: string, request: FailRequest): Promise<FailResponse> {
    return this.#json('POST', `/attempts/${attemptId}/fail`, request, failResponseSchema);
  }

  /**
   * The delivery record of an entry, as the edge reads it; `undefined` when there is none. Called
   * off, its body and all, once `signal` aborts.
   */
  async readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    const response = await this.#send(
      `/entries/${entryId}/record`,
      { method: 'GET', headers: this.#headers(), ...(signal !== undefined && { signal }) },
      true,
    );
    if (response.status === HTTP_NOT_FOUND) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await this.#throwFailure(response);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * A value of the data cache, or `undefined` for none; given up past `READ_DEADLINE_MS`, or past
   * `AUTHORITY_READ_DEADLINE_MS` where reads go to the authority itself.
   */
  getData(request: DataGetRequest): Promise<DataGetResponse | undefined> {
    return readWithin(
      'data read',
      this.#readDeadlineMs,
      async (signal): Promise<DataGetResponse | undefined> => {
        const response = await this.#send(
          '/data/get',
          {
            method: 'POST',
            headers: this.#headers({ 'content-type': JSON_TYPE }),
            body: JSON.stringify(request),
            signal,
          },
          true,
        );
        if (response.status === HTTP_NOT_FOUND) {
          await response.body?.cancel();
          return undefined;
        }
        return this.#result(response, dataGetResponseSchema);
      },
    );
  }

  setData(request: DataSetRequest): Promise<DataSetResponse> {
    return this.#json('PUT', '/data', request, dataSetResponseSchema);
  }

  /**
   * The invalidations recorded against these tags; given up past `READ_DEADLINE_MS`. A failure,
   * and never an empty answer: an empty one would say none of them was invalidated.
   */
  getTags(tags: readonly string[]): Promise<TagsGetResponse> {
    return readWithin('tag read', this.#readDeadlineMs, async (signal) => {
      const response = await this.#send(
        '/tags/get',
        {
          method: 'POST',
          headers: this.#headers({ 'content-type': JSON_TYPE }),
          body: JSON.stringify({ tags }),
          signal,
        },
        true,
      );
      return this.#result(response, tagsGetResponseSchema);
    });
  }

  /**
   * The bytes of an artifact by reference: a generation's output beside its record, or a data value
   * too large to travel inline. Only the authority's storage has them, and the read gateway none, so
   * this isolate holds what it read and its data center keeps a copy (`artifacts.ts`).
   */
  readArtifact(artifactId: string): Promise<Uint8Array | undefined> {
    return this.#artifacts.read(artifactId);
  }

  /** Where the scope's tags stand, as the authority says now (`/tags/revision`). */
  async tagRevision(): Promise<TagRevision> {
    const response = await this.#send('/tags/revision', {
      method: 'GET',
      headers: this.#headers(),
    });
    return this.#result(response, tagRevisionSchema);
  }

  async tagsDelta(since: number): Promise<TagsDeltaResponse> {
    const response = await this.#send(`/tags/delta?since=${since}`, {
      method: 'GET',
      headers: this.#headers(),
    });
    const delta = await this.#result(response, tagsDeltaResponseSchema);
    // Asked for again, such a page would be answered the same, and its reader would never be done.
    if (!deltaMovesOn(since, delta)) {
      throw new CacheHostError(`the delta from revision ${since} does not move past it`, {
        code: 'internal',
        status: response.status,
      });
    }
    return delta;
  }

  invalidate(request: InvalidateRequest): Promise<InvalidateResponse> {
    return this.#json('POST', '/invalidations', request, invalidateResponseSchema);
  }
}
