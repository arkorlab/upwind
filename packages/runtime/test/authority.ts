import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  type CachePolicy,
  deriveEntry,
  encodeGenerationPack,
  type GenerationPackHeader,
  type GenerationTag,
  type InvalidationState,
  PACK_SCHEMA_VERSION,
  type PackArtifactRef,
  packBodyDigests,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { fromBase64, toBase64 } from '@stayingupwind/core/util';

import {
  type CommitRequest,
  type FailRequest,
  gatewayScopePath,
} from '../../host/src/cache/index.ts';
import type { FetchLike } from '../src/cache/host.ts';

/**
 * The cache authority as far as a deployment's Worker reaches it, in memory: a lease for every
 * attempt, renewed whenever it beats, the artifacts uploaded to one, a commit laid out as the
 * delivery record the gateway serves for the entry, and nothing else. What the runtime asked of
 * it is kept, so a test can say what was uploaded, committed or given up.
 *
 * The real `apps/cache` Worker is what the Workers-side suites run against, with a fixture's
 * build; this is for what those builds cannot be made to render.
 */

const LEASE_MS = 60_000;
/** What the gateway lets an artifact hold, as `apps/cache/wrangler.jsonc` deploys it. */
const MAX_ARTIFACT_BYTES = 26_214_400;
const ROLES_OF_THE_BODY: ReadonlySet<string> = new Set(['html', 'route-body']);

/** A generation as a record is laid out from it: the seed's and a commit's have this much. */
interface RecordedGeneration {
  readonly cacheTimestamp: number | null;
  readonly policy: CachePolicy;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly tags: readonly GenerationTag[];
  /** The state a page's generation resumes from, packed beside its document. */
  readonly postponed?: Uint8Array | undefined;
  /** The outputs beside the document, keyed as a record lists them (`rsc`, a segment's). */
  readonly stored?: ReadonlyMap<string, Uint8Array> | undefined;
  /** What the host recorded against the generation when one of its tags was invalidated. */
  readonly invalidation?: InvalidationState | undefined;
}

export interface FakeAuthority {
  readonly fetchImpl: FetchLike;
  /** Every call the runtime made, as `METHOD /path` under the scope. */
  readonly calls: string[];
  /** Artifacts uploaded to an attempt, by their SHA-256. */
  readonly uploads: Map<string, Uint8Array>;
  readonly commits: CommitRequest[];
  readonly failures: FailRequest[];
  /**
   * The tags of each invalidation the runtime asked for, a call each, recorded at the authority's
   * next revision, after every record before it. None is condemned here.
   */
  readonly invalidations: string[][];
  /** Make a generation the entry's current one, as the seed or a commit does. */
  record(
    descriptor: RouteEntryDescriptor,
    generation: RecordedGeneration,
    body: Uint8Array,
    source: 'build' | 'runtime',
  ): Promise<void>;
}

function answer(result: unknown): Response {
  return Response.json({ ok: true, result });
}

export interface FakeAuthorityOptions {
  /**
   * Keep what a commit publishes beside its document in the record — its postponed state, its
   * payload and its segments — as the gateway lays a commit out for the edge and the Worker to read
   * (`apps/cache`). Off unless asked for: a record of a commit is its document alone otherwise.
   */
  readonly keepOutputs?: boolean | undefined;
  /**
   * Answer a published commit with the record it laid out (`record`), as the gateway hands one
   * back for the Function to keep. Off unless asked for: a commit is answered without one otherwise.
   */
  readonly handsBackRecords?: boolean | undefined;
}

/** What a commit published beside its document, from the artifacts uploaded under its attempt. */
function committedOutputs(
  request: CommitRequest,
  uploads: ReadonlyMap<string, Uint8Array>,
): Pick<RecordedGeneration, 'postponed' | 'stored'> {
  const stored = new Map<string, Uint8Array>();
  let postponed: Uint8Array | undefined;
  for (const output of request.generation.outputs) {
    for (const artifact of output.artifacts) {
      const bytes = uploads.get(artifact.sha256);
      if (bytes === undefined) {
        continue;
      }
      if (artifact.role === 'postponed') {
        postponed = bytes;
      } else if (artifact.role === 'rsc' || artifact.role === 'segment') {
        stored.set(output.representationKey, bytes);
      }
    }
  }
  return { postponed, stored };
}

export function fakeAuthority(scopeId: string, options: FakeAuthorityOptions = {}): FakeAuthority {
  const prefix = gatewayScopePath(scopeId);
  const calls: string[] = [];
  const uploads = new Map<string, Uint8Array>();
  const commits: CommitRequest[] = [];
  const failures: FailRequest[] = [];
  const invalidations: string[][] = [];
  const records = new Map<string, Uint8Array>();
  const attempts = new Map<string, RouteEntryDescriptor>();
  /** The bytes of the outputs recorded generations hold, by artifact id. */
  const artifacts = new Map<string, Uint8Array>();
  let seq = 0;

  const storedOf = async (generation: RecordedGeneration): Promise<PackArtifactRef[]> => {
    const refs: PackArtifactRef[] = [];
    const stored = generation.stored ?? new Map<string, Uint8Array>();
    for (const [representationKey, bytes] of stored) {
      const artifactId = `artifact-${seq}-${refs.length}`;
      artifacts.set(artifactId, bytes);
      refs.push({
        artifactId,
        sha256: await sha256Hex(bytes),
        byteLength: bytes.byteLength,
        contentType: 'text/x-component',
        encoding: 'identity',
        role: representationKey.startsWith('segment:') ? 'segment' : 'rsc',
        representationKey,
      });
    }
    return refs;
  };

  const record: FakeAuthority['record'] = async (descriptor, generation, body, source) => {
    seq += 1;
    const { entryId } = await deriveEntry(scopeId, descriptor);
    const header: GenerationPackHeader = {
      schemaVersion: PACK_SCHEMA_VERSION,
      scopeId,
      entryId,
      generationId: `generation-${seq}`,
      seq,
      source,
      kind: descriptor.kind,
      route: descriptor.route,
      pathname: descriptor.pathname,
      cacheTimestamp: generation.cacheTimestamp,
      producedAt: generation.cacheTimestamp,
      policy: generation.policy,
      status: generation.status,
      headers: generation.headers,
      tags: [...generation.tags],
      ...(await packBodyDigests(body, generation.postponed)),
      artifacts: await storedOf(generation),
      revision: seq,
      ...(generation.invalidation !== undefined && { invalidation: generation.invalidation }),
    };
    records.set(entryId, encodeGenerationPack(header, body, generation.postponed));
  };

  const commit = async (attemptId: string, request: CommitRequest): Promise<Response> => {
    commits.push(request);
    const descriptor = attempts.get(attemptId);
    const primary = request.generation.outputs
      .flatMap((output) => output.artifacts)
      .find((artifact) => ROLES_OF_THE_BODY.has(artifact.role));
    const body = primary === undefined ? undefined : uploads.get(primary.sha256);
    if (descriptor === undefined || body === undefined) {
      return Response.json(
        { ok: false, error: { code: 'artifact_missing', message: 'nothing to publish' } },
        { status: 409 },
      );
    }
    const kept = options.keepOutputs === true ? committedOutputs(request, uploads) : {};
    await record(descriptor, { ...request.generation, ...kept }, body, 'runtime');
    const laidOut = records.get((await deriveEntry(scopeId, descriptor)).entryId);
    return answer({
      kind: 'published',
      generationId: `generation-${seq}`,
      seq,
      revision: seq,
      condemned: null,
      ...(options.handsBackRecords === true &&
        laidOut !== undefined && { record: toBase64(laidOut) }),
    });
  };

  const lease = async (request: Request): Promise<Response> => {
    const { entry } = (await request.json()) as { entry: RouteEntryDescriptor };
    const attemptId = `attempt-${attempts.size + 1}`;
    attempts.set(attemptId, entry);
    const { entryId } = await deriveEntry(scopeId, entry);
    return answer({
      kind: 'leased',
      attemptId,
      entryId,
      fencingToken: 1,
      dependencyRevision: 0,
      leaseExpiresAt: Date.now() + LEASE_MS,
      current: null,
    });
  };

  const upload = async (request: Request, sha256: string): Promise<Response> => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return Response.json(
        { ok: false, error: { code: 'too_large', message: 'the artifact is too large' } },
        { status: 413 },
      );
    }
    uploads.set(sha256, bytes);
    return answer({});
  };

  /** Several artifacts in one request, kept as one upload each keeps its own. */
  const uploadBatch = async (request: Request): Promise<Response> => {
    const { artifacts: batched } = (await request.json()) as {
      readonly artifacts: readonly { readonly sha256: string; readonly bytes: string }[];
    };
    const answered = batched.map(({ sha256, bytes }) => {
      const decoded = fromBase64(bytes);
      uploads.set(sha256, decoded);
      return { sha256, byteLength: decoded.byteLength };
    });
    return answer({ artifacts: answered });
  };

  const fail = async (request: Request): Promise<Response> => {
    const failed = (await request.json()) as FailRequest;
    failures.push(failed);
    return answer({
      regeneration: failed.outcome === 'failed' ? 'failed' : 'idle',
      nextRetryAt: null,
    });
  };

  /** `/attempts`, and what is done under one: its artifacts, its beats, its commit, its failure. */
  const attempt = async (
    request: Request,
    [id, action, sha256]: readonly (string | undefined)[],
  ): Promise<Response | undefined> => {
    if (id === undefined) {
      return lease(request);
    }
    if (action === 'artifacts') {
      return sha256 === undefined ? uploadBatch(request) : upload(request, sha256);
    }
    if (action === 'heartbeat') {
      return answer({ leaseExpiresAt: Date.now() + LEASE_MS });
    }
    if (action === 'commit') {
      return commit(id, (await request.json()) as CommitRequest);
    }
    return action === 'fail' ? fail(request) : undefined;
  };

  const fetchImpl: FetchLike = async (request) => {
    const path = new URL(request.url).pathname.slice(prefix.length);
    calls.push(`${request.method} ${path}`);
    const [, resource, ...rest] = path.split('/', 5);
    if (resource === 'tags') {
      return answer({ revision: 0, floor: 0, truncated: false, tags: [] });
    }
    if (resource === 'artifacts' && request.method === 'GET') {
      const bytes = artifacts.get(rest[0] ?? '');
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes as BodyInit);
    }
    if (resource === 'entries' && rest[1] === 'record') {
      const stored = records.get(rest[0] ?? '');
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response(stored as BodyInit);
    }
    if (resource === 'invalidations' && request.method === 'POST') {
      const { tags } = (await request.json()) as { readonly tags: readonly { value: string }[] };
      invalidations.push(tags.map((tag) => tag.value));
      seq += 1;
      return answer({ revision: seq, invalidations: [], affectedEntryIds: [] });
    }
    const answered = resource === 'attempts' ? await attempt(request, rest) : undefined;
    return (
      answered ??
      Response.json(
        { ok: false, error: { code: 'not_found', message: `no route for ${path}` } },
        { status: 404 },
      )
    );
  };

  return { fetchImpl, calls, uploads, commits, failures, invalidations, record };
}
