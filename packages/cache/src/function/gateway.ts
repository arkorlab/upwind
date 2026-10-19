import { sha256Hex } from '@stayingupwind/core/artifact';
import { TEST_CLOCK_HEADER } from '@stayingupwind/core/paas';
import { releaseStream, toBase64 } from '@stayingupwind/core/util';
import {
  answersTheRead,
  answersTheTags,
  ARTIFACT_ENCODING_HEADER,
  ARTIFACT_ROLE_HEADER,
  CACHE_SCOPE_HEADER,
  type CommitRequest,
  type CommitResponse,
  commitResponseSchema,
  type CurrentDataRequest,
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
import { requestedEntryId } from './entry-identity.ts';
import {
  DATA_ENVELOPE_BYTES,
  FAILURE_ENVELOPE_BYTES,
  RECORD_ENVELOPE_BYTES,
  withEnvelope,
} from './envelope.ts';
import {
  ArtifactRoom,
  functionReadBudget,
  projectedLength,
  readArtifactWhole,
  readWithin,
  saidLength,
  type ReadBudget,
} from './read-budget.ts';

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
 * How long an artifact read from the authority takes at the most, from the request to its last
 * byte: what a copy of one is read for (`COPY_READ_LIMIT_MS`, `artifacts.ts`). An artifact can be
 * tens of MiB, read from wherever the authority keeps it, so it is given far longer than a value;
 * one whose gateway or body goes quiet past this is given up, and the runtime goes on without the
 * output it could not read rather than holding its render open for as long as the request lasts.
 */
const ARTIFACT_READ_DEADLINE_MS = 10_000;
/**
 * How long a delivery record read takes at the most, from the request to its last byte: what an
 * artifact read is given, as a record may be as long as one. Past it the read is called off, its
 * body with it, and the room it holds goes back whatever its caller handed it. A document stops
 * waiting for its record long before, and calls nothing off as it does: the runtime keeps the read
 * going for the requests after it, as long as a request's work may last behind its response, and a
 * body that stalled with its room taken would hold up every read that does not fit beside it for
 * that long, or for good where its caller hands no signal.
 */
const RECORD_READ_DEADLINE_MS = ARTIFACT_READ_DEADLINE_MS;

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
  /**
   * What this isolate reads of artifacts at once, from the authority and from its data center's
   * copies, of delivery records, from the gateways and from its data center's copies, and of its
   * data center's copies of values, and of record/value envelopes through JSON validation
   * (`reading`): one gateway an isolate.
   */
  readonly #reading = functionReadBudget();

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
      (artifactId, signal, room) => this.#artifactFromAuthority(artifactId, signal, room),
      options.naming,
      this.#reading,
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
  #result<T>(
    response: Response,
    schema: Schema<T>,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!response.ok) {
      return this.#throwFailure(response, signal);
    }
    return limit === undefined
      ? this.#metadataResult(response, schema)
      : this.#envelope(
          response,
          limit,
          (body) => this.#parsedResult(response, body, schema),
          signal,
        );
  }

  /** Metadata-only routes keep their existing success-body contract and parsing path. */
  async #metadataResult<T>(response: Response, schema: Schema<T>): Promise<T> {
    return this.#parsedResult(response, await response.json(), schema);
  }

  #parsedResult<T>(response: Response, value: unknown, schema: Schema<T>): T {
    const body = value as Envelope;
    if (body.ok !== true) {
      throw this.#refusal(response, body);
    }
    return schema.parse(body.result);
  }

  /** Existing data-read deadlines cover room and body too; write responses get the record budget. */
  #envelope<T>(
    response: Response,
    limit: number,
    parse: (body: unknown) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    return signal === undefined
      ? readWithin('gateway envelope read', RECORD_READ_DEADLINE_MS, (asked) =>
          withEnvelope(response, this.#reading, limit, asked, parse),
        )
      : withEnvelope(response, this.#reading, limit, signal, parse);
  }

  /**
   * A data read's answer, refused where it is of another entry than the read asked for: kept as
   * the value of the key asked for, it would be served as that one.
   */
  async #valueOf(
    response: Response,
    request: DataGetRequest,
    signal: AbortSignal,
  ): Promise<DataGetResponse> {
    const answer = await this.#result(response, dataGetResponseSchema, DATA_ENVELOPE_BYTES, signal);
    if (
      !answersTheRead(request, answer) ||
      answer.entryId !== requestedEntryId(this.#scopeId, request)
    ) {
      throw new CacheHostError('the data read was answered with a value of another entry', {
        code: 'internal',
        status: response.status,
      });
    }
    return answer;
  }

  /**
   * A response already known to have failed, as the error it stands for. Read separately from
   * `#result` for the calls whose success is bytes rather than an envelope: there is no result
   * schema to hand such a call, and passing an unrelated one only to reach this path made the
   * schema look load-bearing.
   */
  async #throwFailure(response: Response, signal?: AbortSignal): Promise<never> {
    throw await this.#failureOf(response, signal);
  }

  /** A response already known to have failed, as the error it stands for (`#throwFailure`). */
  async #failureOf(response: Response, signal?: AbortSignal): Promise<CacheHostError> {
    try {
      return await this.#envelope(
        response,
        FAILURE_ENVELOPE_BYTES,
        (body) => this.#refusal(response, body as Envelope),
        signal,
      );
    } catch {
      // A refusal with no JSON body says only its status, which is what the fallback below says.
    }
    return this.#refusal(response, {});
  }

  #refusal(response: Response, body: Envelope): CacheHostError {
    const refusal = gatewayErrorSchema.safeParse(body);
    return new CacheHostError(
      refusal.success ? refusal.data.error.message : `cache gateway answered ${response.status}`,
      { code: refusal.success ? refusal.data.error.code : 'internal', status: response.status },
    );
  }

  // eslint-disable-next-line max-params -- The optional producer bound avoids allocating options on every mutation.
  async #json<T>(
    method: 'POST' | 'PUT',
    path: string,
    payload: unknown,
    schema: Schema<T>,
    limit?: number,
  ): Promise<T> {
    const response = await this.#send(path, {
      method,
      headers: this.#headers({ 'content-type': JSON_TYPE }),
      body: JSON.stringify(payload),
    });
    return this.#result(response, schema, limit);
  }

  /**
   * An artifact's bytes as the authority answers them: `undefined` when it holds none. Given up past
   * `ARTIFACT_READ_DEADLINE_MS`, and called off once `signal` aborts: either, its body and all.
   * Read in `room` where the read is asked beside the artifact's copy (`ArtifactRoom`).
   */
  #artifactFromAuthority(
    artifactId: string,
    signal?: AbortSignal,
    room?: ArtifactRoom,
  ): Promise<Uint8Array | undefined> {
    return readWithin('artifact read', ARTIFACT_READ_DEADLINE_MS, async (deadline) => {
      const asked = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const response = await this.#send(`/artifacts/${artifactId}`, {
        method: 'GET',
        headers: this.#headers(),
        signal: asked,
      });
      if (response.status === HTTP_NOT_FOUND) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        await this.#throwFailure(response, asked);
      }
      return readArtifactWhole(response, asked, room ?? new ArtifactRoom(this.#reading));
    });
  }

  /**
   * The answer's bytes, read whole once the isolate has room for them (`ReadBudget`): the room the
   * artifact's copy holds, where it does, and room of the answer's own otherwise. One given up
   * while it waits for room lets go of its body unread.
   */
  async #readWhole(
    response: Response,
    signal: AbortSignal,
    room: ArtifactRoom,
  ): Promise<Uint8Array> {
    let release: () => void;
    try {
      release = await room.hold(projectedLength(response), signal);
    } catch (error) {
      releaseStream(response.body, 'an artifact read given up before its body');
      throw error;
    }
    try {
      return new Uint8Array(await response.arrayBuffer());
    } finally {
      release();
    }
  }

  /** Both tag metadata reads cross to the authority, regardless of a nearby read gateway. */
  #authorityTagRead<T>(
    path: string,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return readWithin('tag authority read', AUTHORITY_READ_DEADLINE_MS, async (signal) => {
      const response = await this.#send(path, {
        method: 'GET',
        headers: this.#headers(),
        signal,
      });
      if (signal.aborted) {
        releaseStream(response.body, 'tag metadata headers arrived after the deadline');
      }
      signal.throwIfAborted();
      return read(response, signal);
    });
  }

  /**
   * The isolate's room for what it reads whole, for the data center's copies of records and of
   * values to be read in as well (`RecordCopies`, `DataCopies`).
   */
  get reading(): ReadBudget {
    return this.#reading;
  }

  startAttempt(request: StartAttemptRequest): Promise<StartAttemptResponse> {
    return this.#json(
      'POST',
      '/attempts',
      request,
      startAttemptResponseSchema.refine(
        (answer) => answer.entryId === requestedEntryId(this.#scopeId, request.entry),
        { message: 'the attempt was answered for another entry', path: ['entryId'] },
      ),
      RECORD_ENVELOPE_BYTES,
    );
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
    releaseStream(response.body, 'the artifact upload response is not used');
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
    const uploaded = (await this.#result(response, uploadArtifactsResponseSchema)).artifacts;
    if (
      uploaded.length !== artifacts.length ||
      uploaded.some((artifact, index) => {
        return (
          artifact.sha256 !== artifacts[index]?.sha256 ||
          artifact.byteLength !== uploads[index]?.bytes.byteLength
        );
      })
    ) {
      throw new CacheHostError('the upload batch was answered with other artifacts', {
        code: 'internal',
        status: response.status,
      });
    }
    return uploaded;
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
    return this.#json(
      'POST',
      `/attempts/${attemptId}/commit`,
      request,
      commitResponseSchema,
      RECORD_ENVELOPE_BYTES,
    );
  }

  fail(attemptId: string, request: FailRequest): Promise<FailResponse> {
    return this.#json('POST', `/attempts/${attemptId}/fail`, request, failResponseSchema);
  }

  /**
   * The delivery record of an entry, as the edge reads it; `undefined` when there is none. Given up
   * past `RECORD_READ_DEADLINE_MS`, and called off once `signal` aborts: either, its body and all.
   * Read whole in room of its own, as an artifact is (`#readWhole`), where the gateway says how long
   * it is, which both gateways do; an answer that says nothing, a gateway's from before they said
   * it, is read as it always was, in no room.
   */
  readRecord(entryId: string, signal?: AbortSignal): Promise<Uint8Array | undefined> {
    return readWithin('record read', RECORD_READ_DEADLINE_MS, async (deadline) => {
      const asked = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const response = await this.#send(
        `/entries/${entryId}/record`,
        { method: 'GET', headers: this.#headers(), signal: asked },
        true,
      );
      if (response.status === HTTP_NOT_FOUND) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok) {
        await this.#throwFailure(response, asked);
      }
      if (saidLength(response) === undefined) {
        return new Uint8Array(await response.arrayBuffer());
      }
      return this.#readWhole(response, asked, new ArtifactRoom(this.#reading));
    });
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
        return this.#valueOf(response, request, signal);
      },
    );
  }

  /**
   * The value the key holds now, asked of the authority itself rather than of KV (`/data/current`);
   * `undefined` for none, for none later than `than` where it is given, and for an authority from
   * before it answered the route. An authority from before `than` answers with the value whatever
   * its revision. Given up past `AUTHORITY_READ_DEADLINE_MS`, however near a read gateway is: this
   * read always crosses to the authority.
   */
  currentData(request: CurrentDataRequest): Promise<DataGetResponse | undefined> {
    return readWithin(
      'current data read',
      AUTHORITY_READ_DEADLINE_MS,
      async (signal): Promise<DataGetResponse | undefined> => {
        const response = await this.#send('/data/current', {
          method: 'POST',
          headers: this.#headers({ 'content-type': JSON_TYPE }),
          body: JSON.stringify(request),
          signal,
        });
        if (response.status === HTTP_NOT_FOUND) {
          await response.body?.cancel();
          return undefined;
        }
        return this.#valueOf(response, request, signal);
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
      const answer = await this.#result(response, tagsGetResponseSchema, undefined, signal);
      if (!answersTheTags(tags, answer)) {
        throw new CacheHostError('the tag read was answered of a tag it did not ask about', {
          code: 'internal',
          status: response.status,
        });
      }
      return answer;
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

  /** Where the scope's tags stand, read within the authority deadline (`/tags/revision`). */
  tagRevision(): Promise<TagRevision> {
    return this.#authorityTagRead('/tags/revision', (response, signal) =>
      this.#result(response, tagRevisionSchema, undefined, signal),
    );
  }

  /** One delta page, including its body, read within the authority deadline. */
  tagsDelta(since: number): Promise<TagsDeltaResponse> {
    return this.#authorityTagRead(`/tags/delta?since=${since}`, async (response, signal) => {
      const delta = await this.#result(response, tagsDeltaResponseSchema, undefined, signal);
      // A repeated page would leave its reader asking for the same invalidations forever.
      if (!deltaMovesOn(since, delta)) {
        throw new CacheHostError(`the delta from revision ${since} does not move past it`, {
          code: 'internal',
          status: response.status,
        });
      }
      return delta;
    });
  }

  invalidate(request: InvalidateRequest): Promise<InvalidateResponse> {
    return this.#json('POST', '/invalidations', request, invalidateResponseSchema);
  }
}
