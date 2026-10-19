import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  type CachePolicy,
  type Duration,
  encodeGenerationPack,
  type GenerationPackHeader,
  type GenerationSourceKind,
  type GenerationTag,
  type InvalidationState,
  invalidationStateSchema,
  MAX_PACK_HEADER_BYTES,
  NEXT_ONE_YEAR_SECONDS,
  type OutputSnapshot,
  PACK_SCHEMA_VERSION,
  type PackBodyDigests,
  packBodyDigests,
  packBytesAtMost,
  packHeaderBytes,
  publicArtifactRef,
  routeEntryKindSchema,
} from '@stayingupwind/core/cache';
import { toBase64 } from '@stayingupwind/core/util';
import {
  type DataEntryMetadata,
  dataEntryMetadataSchema,
  MAX_INLINE_DATA_VALUE_BYTES,
} from '@stayingupwind/host/cache';
import { toZod } from '@stayingupwind/host/zod';
import { z } from 'zod';

import { condemnedOf } from './generations.ts';
import type { BlobStore, CarriedValue } from './io.ts';
import {
  type EntryRow,
  generationHeaders,
  generationOutputs,
  type GenerationRow,
  toGeneration,
} from './rows.ts';

/**
 * The records the authority projects out of its tables: the delivery record of an entry (the pack
 * the edge reads, or the data record the gateway reads). Bytes are read back from storage and
 * checked against the digest the generation recorded before they are laid out.
 */

const DATA_RECORD_SCHEMA_VERSION = 1;
/** The roles whose bytes travel inside the record itself; the rest are read through the authority. */
const RECORD_BODY_ROLES: ReadonlySet<string> = new Set(['html', 'route-body']);
const RECORD_STATE_ROLE = 'postponed';
const ROLE_HTML = 'html';
const ROLE_ROUTE_BODY = 'route-body';
const ROLE_POSTPONED = RECORD_STATE_ROLE;
const EMPTY = new Uint8Array(0);
const SHA256_HEX_LENGTH = 64;
/** Every SHA-256 prints at one length, so a digest not yet taken measures as any other. */
const ANY_DIGEST = '0'.repeat(SHA256_HEX_LENGTH);
/** No number prints wider in JSON than this one does: `-1.7976931348623157e+308`. */
const WIDEST_NUMBER = -Number.MAX_VALUE;

const dataValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline'), base64: z.string() }),
  z.object({
    kind: z.literal('ref'),
    artifactId: z.string().min(1),
    storageRef: z.string().min(1),
    byteLength: z.number().int().nonnegative(),
  }),
]);

/** The data-cache record in KV, read by the gateway alone: its storage key never leaves it. */
export const dataRecordSchema = z.object({
  schemaVersion: z.literal(DATA_RECORD_SCHEMA_VERSION),
  scopeId: z.string().min(1),
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  dependencyRevision: z.number().int().nonnegative(),
  entry: toZod(dataEntryMetadataSchema),
  value: dataValueSchema,
  invalidation: toZod(invalidationStateSchema).optional(),
});
export type DataRecord = z.infer<typeof dataRecordSchema>;

export interface RecordDeps {
  readonly blobs: BlobStore;
  readonly scopeId: string;
}

type RecordArtifact = OutputSnapshot['artifacts'][number];

/** The store answered, but not with the artifact a generation names. */
export class InvalidArtifactError extends Error {
  override name = 'InvalidArtifactError';

  readonly artifact: Pick<RecordArtifact, 'sha256' | 'storageRef' | 'byteLength'>;

  constructor(message: string, artifact: RecordArtifact, options?: ErrorOptions) {
    super(message, options);
    this.artifact = artifact;
  }
}

async function verifiedBytes(blobs: BlobStore, artifact: RecordArtifact): Promise<Uint8Array> {
  const bytes = await blobs.read(artifact.storageRef);
  if (bytes === undefined) {
    throw new InvalidArtifactError(
      `artifact ${artifact.sha256} (${artifact.role}) is not in storage`,
      artifact,
    );
  }
  if (bytes.byteLength !== artifact.byteLength) {
    throw new InvalidArtifactError(
      `artifact ${artifact.sha256} (${artifact.role}) has ${bytes.byteLength} bytes, not ${artifact.byteLength}`,
      artifact,
    );
  }
  if ((await sha256Hex(bytes)) !== artifact.sha256) {
    throw new InvalidArtifactError(
      `artifact ${artifact.sha256} (${artifact.role}) does not hash to its name`,
      artifact,
    );
  }
  return bytes;
}

function artifactWithRole(
  outputs: readonly OutputSnapshot[],
  role: string,
): RecordArtifact | undefined {
  for (const output of outputs) {
    const found = output.artifacts.find((artifact) => artifact.role === role);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

interface RecordBodies {
  /** The document, or a route handler's body. */
  readonly primary: RecordArtifact | undefined;
  /** The state a resume needs, when there is anything to resume. */
  readonly postponed: RecordArtifact | undefined;
}

function recordBodies(outputs: readonly OutputSnapshot[]): RecordBodies {
  const postponed = artifactWithRole(outputs, ROLE_POSTPONED);
  return {
    primary: artifactWithRole(outputs, ROLE_HTML) ?? artifactWithRole(outputs, ROLE_ROUTE_BODY),
    // An empty state resumes nothing, as Next.js reads an empty one. A record says there is none
    // with no digest and no length; the digest of no bytes beside no length is one its reader
    // refuses as corrupt (`decodeGenerationPack`).
    postponed: postponed?.byteLength === 0 ? undefined : postponed,
  };
}

/** What a delivery record's header is made of, all of it known before the record is written. */
export interface PackHeaderFields {
  readonly scopeId: string;
  readonly entry: {
    readonly entryId: string;
    readonly kind: string;
    readonly route: string | null;
    readonly pathname: string | null;
  };
  readonly generation: {
    readonly generationId: string;
    readonly seq: number;
    readonly source: GenerationSourceKind;
    readonly cacheTimestamp: number | null;
    readonly producedAt: number | null;
    readonly policy: CachePolicy;
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly tags: readonly GenerationTag[];
  };
  readonly outputs: readonly OutputSnapshot[];
}

/** What of a header an invalidation rewrites once it is written. */
interface PackHeaderState {
  readonly revision: number;
  readonly condemned: InvalidationState | null;
}

/**
 * That part at its widest: the revision an invalidation moves the record to, and the state it
 * condemns the generation with, every number printed as wide as one can be.
 */
const WIDEST_STATE: PackHeaderState = {
  revision: WIDEST_NUMBER,
  condemned: { revision: WIDEST_NUMBER, staleAt: WIDEST_NUMBER, hardExpireAt: WIDEST_NUMBER },
};

/** The header a delivery decision reads, measuring the bodies laid out after it. */
function packHeaderOf(
  fields: PackHeaderFields,
  state: PackHeaderState,
  digests: PackBodyDigests,
): GenerationPackHeader {
  const { entry, generation } = fields;
  return {
    schemaVersion: PACK_SCHEMA_VERSION,
    scopeId: fields.scopeId,
    entryId: entry.entryId,
    generationId: generation.generationId,
    seq: generation.seq,
    source: generation.source,
    kind: routeEntryKindSchema.parse(entry.kind),
    route: entry.route ?? '/',
    pathname: entry.pathname ?? '/',
    cacheTimestamp: generation.cacheTimestamp,
    producedAt: generation.producedAt,
    policy: generation.policy,
    status: generation.status,
    headers: generation.headers,
    tags: [...generation.tags],
    ...digests,
    artifacts: fields.outputs.flatMap((output) => {
      return output.artifacts.map((artifact) => {
        return {
          ...publicArtifactRef(artifact),
          representationKey: output.representationKey,
          storageRef: artifact.storageRef,
        };
      });
    }),
    revision: state.revision,
    ...(state.condemned !== null && { invalidation: state.condemned }),
  };
}

/** The header at the most it could ever be written as; a data entry's record is not a pack. */
function oversizedHeader(fields: PackHeaderFields): string | undefined {
  if (!routeEntryKindSchema.safeParse(fields.entry.kind).success) {
    return undefined;
  }
  const { primary, postponed } = recordBodies(fields.outputs);
  const bytes = packHeaderBytes(
    packHeaderOf(fields, WIDEST_STATE, {
      htmlSha256: ANY_DIGEST,
      htmlLength: primary?.byteLength ?? 0,
      postponedSha256: postponed === undefined ? null : ANY_DIGEST,
      postponedLength: postponed?.byteLength ?? 0,
    }),
  );
  const limit = MAX_PACK_HEADER_BYTES;
  return bytes > limit
    ? `a delivery record's header of ${bytes} bytes is more than the ${limit} one may hold`
    : undefined;
}

/** The most a record of `outputs` takes, by the lengths its body and its state say they are. */
function packBytesOf(outputs: readonly OutputSnapshot[]): number {
  let body = 0;
  let state = 0;
  for (const output of outputs) {
    for (const artifact of output.artifacts) {
      if (RECORD_BODY_ROLES.has(artifact.role)) {
        body = Math.max(body, artifact.byteLength);
      } else if (artifact.role === RECORD_STATE_ROLE) {
        state = Math.max(state, artifact.byteLength);
      }
    }
  }
  return packBytesAtMost(body, state);
}

/** What the entry's record says of its generation, laid out as a pack's header holds it. */
export function headerFieldsOf(
  scopeId: string,
  entry: EntryRow,
  generation: GenerationRow,
  outputs: readonly OutputSnapshot[],
): PackHeaderFields {
  const parsed = toGeneration(scopeId, generation);
  return {
    scopeId,
    entry: {
      entryId: entry.entry_id,
      kind: entry.kind,
      route: entry.route,
      pathname: entry.pathname,
    },
    generation: {
      generationId: generation.generation_id,
      seq: generation.seq,
      source: parsed.source,
      cacheTimestamp: generation.cache_timestamp,
      producedAt: generation.produced_at,
      policy: parsed.policy,
      status: generation.status,
      headers: generationHeaders(generation),
      tags: parsed.tags,
    },
    outputs,
  };
}

/**
 * How many bytes the generation's delivery record takes, told before anything of it is read: its
 * document's and its state's lengths, as their artifacts say, and its header as it would be laid
 * out, with digests as long as theirs.
 */
export function recordBytesOf(scopeId: string, entry: EntryRow, generation: GenerationRow): number {
  const outputs = generationOutputs(generation);
  const { primary, postponed } = recordBodies(outputs);
  const htmlLength = primary?.byteLength ?? 0;
  const postponedLength = postponed?.byteLength ?? 0;
  const header = packHeaderOf(
    headerFieldsOf(scopeId, entry, generation, outputs),
    { revision: entry.record_revision, condemned: condemnedOf(generation) },
    {
      htmlSha256: ANY_DIGEST,
      htmlLength,
      postponedSha256: postponed === undefined ? null : ANY_DIGEST,
      postponedLength,
    },
  );
  // What a pack takes at the most, with the header it does take in place of the widest one.
  return (
    packBytesAtMost(htmlLength, postponedLength) - MAX_PACK_HEADER_BYTES + packHeaderBytes(header)
  );
}

const PACK_MEMORY_COPIES = 3;
const INLINE_DATA_MEMORY_COPIES = 12;
const DATA_METADATA_MEMORY_COPIES = 6;

/**
 * The memory a pack of `recordBytes` holds as it is built: its source buffers, a hashing/native copy
 * and its encoded record.
 */
export function packMemoryOf(recordBytes: number): number {
  return PACK_MEMORY_COPIES * recordBytes;
}

/**
 * Reserve memory before reading any blobs. A pack needs its source buffers, a hashing/native
 * copy and its encoded record; inline data also makes base64 and JSON strings (potentially UTF-16).
 * A referenced data value is never read into memory by projection.
 */
export function projectionMemoryOf(
  scopeId: string,
  entry: EntryRow,
  generation: GenerationRow,
): number {
  if (!entry.kind.startsWith('data:')) {
    return packMemoryOf(recordBytesOf(scopeId, entry, generation));
  }
  const artifact = generationOutputs(generation)[0]?.artifacts[0];
  if (artifact === undefined) {
    throw new Error(`data generation ${generation.generation_id} has no value`);
  }
  const inline = artifact.byteLength <= MAX_INLINE_DATA_VALUE_BYTES;
  const value: DataRecord['value'] = inline
    ? { kind: 'inline', base64: '' }
    : {
        kind: 'ref',
        artifactId: artifact.artifactId,
        storageRef: artifact.storageRef,
        byteLength: artifact.byteLength,
      };
  return (
    (inline ? INLINE_DATA_MEMORY_COPIES * artifact.byteLength : 0) +
    DATA_METADATA_MEMORY_COPIES *
      JSON.stringify(dataRecordOf(scopeId, entry, generation, value)).length
  );
}

/**
 * Why no delivery record of this generation could ever be written, if none could.
 *
 * The record is one KV value, and it holds the document and the postponed state together behind
 * a header with a ceiling of its own. Each artifact is bounded on its own at upload, which lets two
 * that each fit make a record that does not; and the header is made of what the generation's
 * producer chose — its headers, every output's key and artifacts, the route and the pathname —
 * which nothing bounds on the way in. Published, either would be a generation the authority calls
 * current and no projection can ever write: the edge left on the old one, the write retried
 * forever, and every other entry of the scope waiting behind enough of them.
 */
export function unwritableRecord(
  fields: PackHeaderFields,
  maxRecordBytes: number,
): string | undefined {
  const bytes = packBytesOf(fields.outputs);
  return bytes > maxRecordBytes
    ? `a delivery record of ${bytes} bytes is more than the ${maxRecordBytes} one may hold`
    : oversizedHeader(fields);
}

/** The delivery record: the header a decision needs, the document, the state a resume needs. */
export async function generationRecordBytes(
  deps: RecordDeps,
  entry: EntryRow,
  generation: GenerationRow,
): Promise<Uint8Array> {
  const outputs = generationOutputs(generation);
  const { primary, postponed } = recordBodies(outputs);
  const readingHtml = primary === undefined ? EMPTY : verifiedBytes(deps.blobs, primary);
  const readingState = postponed === undefined ? undefined : verifiedBytes(deps.blobs, postponed);
  try {
    const [html, state] = await Promise.all([readingHtml, readingState]);
    const header = packHeaderOf(
      headerFieldsOf(deps.scopeId, entry, generation, outputs),
      { revision: entry.record_revision, condemned: condemnedOf(generation) },
      await packBodyDigests(html, state),
    );
    return encodeGenerationPack(header, html, state);
  } catch (error) {
    // The caller holds room for both reads until this ends, including the one that did not fail.
    await Promise.allSettled([readingHtml, readingState]);
    throw error;
  }
}

function seconds(duration: Duration): number {
  switch (duration.kind) {
    case 'finite': {
      return duration.seconds;
    }
    case 'unbounded': {
      return NEXT_ONE_YEAR_SECONDS;
    }
    case 'unknown': {
      return 0;
    }
  }
}

function dataMetadata(entry: EntryRow, generation: GenerationRow): DataEntryMetadata {
  const parsed = toGeneration(entry.entry_id, generation);
  return dataEntryMetadataSchema.parse({
    kind: entry.kind,
    ...(entry.handler !== null && { handler: entry.handler }),
    tags: parsed.tags.map((tag) => tag.value),
    stale: seconds(parsed.policy.clientStale),
    timestamp: generation.cache_timestamp ?? generation.committed_at,
    expire: seconds(parsed.policy.expireAfter),
    revalidate: seconds(parsed.policy.revalidateAfter),
    dependencyCoverage: parsed.dependencyCoverage,
  });
}

function dataRecordOf(
  scopeId: string,
  entry: EntryRow,
  generation: GenerationRow,
  value: DataRecord['value'],
): DataRecord {
  const condemned = condemnedOf(generation);
  return {
    schemaVersion: DATA_RECORD_SCHEMA_VERSION,
    scopeId,
    entryId: entry.entry_id,
    generationId: generation.generation_id,
    revision: entry.record_revision,
    dependencyRevision: generation.dependency_revision,
    entry: dataMetadata(entry, generation),
    value,
    ...(condemned !== null && { invalidation: condemned }),
  };
}

/**
 * The data-cache record with its value by reference, whatever its size: nothing read from storage,
 * the bytes the reader's to read as a large value's are.
 */
export function dataRecordByReference(
  scopeId: string,
  entry: EntryRow,
  generation: GenerationRow,
): DataRecord {
  const artifact = generationOutputs(generation)[0]?.artifacts[0];
  if (artifact === undefined) {
    throw new Error(`data generation ${generation.generation_id} has no value`);
  }
  return dataRecordOf(scopeId, entry, generation, {
    kind: 'ref',
    artifactId: artifact.artifactId,
    storageRef: artifact.storageRef,
    byteLength: artifact.byteLength,
  });
}

/**
 * A small data value's bytes: those its write handed over, where they are the ones the artifact
 * names, and what storage holds otherwise, checked against the name (`verifiedBytes`). Not hashed
 * again: the gateway named them by hashing these very bytes, in the request that stored them.
 */
async function inlineBytes(
  blobs: BlobStore,
  artifact: RecordArtifact,
  carried: CarriedValue | undefined,
): Promise<Uint8Array> {
  return carried?.sha256 === artifact.sha256 && carried.bytes.byteLength === artifact.byteLength
    ? carried.bytes
    : verifiedBytes(blobs, artifact);
}

/** The data-cache record as KV holds it (`dataRecordFor`), serialized. */
export async function dataRecordJson(
  deps: RecordDeps,
  entry: EntryRow,
  generation: GenerationRow,
  carried?: CarriedValue,
): Promise<string> {
  return JSON.stringify(await dataRecordFor(deps, entry, generation, carried));
}

/**
 * The data-cache record: a small value travels inside it, a large one by reference. A small value's
 * bytes are those `carried` where they are its, and read from storage otherwise.
 */
export async function dataRecordFor(
  deps: RecordDeps,
  entry: EntryRow,
  generation: GenerationRow,
  carried?: CarriedValue,
): Promise<DataRecord> {
  const artifact = generationOutputs(generation)[0]?.artifacts[0];
  if (artifact === undefined) {
    throw new Error(`data generation ${generation.generation_id} has no value`);
  }
  const value: DataRecord['value'] =
    artifact.byteLength <= MAX_INLINE_DATA_VALUE_BYTES
      ? { kind: 'inline', base64: toBase64(await inlineBytes(deps.blobs, artifact, carried)) }
      : {
          kind: 'ref',
          artifactId: artifact.artifactId,
          storageRef: artifact.storageRef,
          byteLength: artifact.byteLength,
        };
  return dataRecordOf(deps.scopeId, entry, generation, value);
}
