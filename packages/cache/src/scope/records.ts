import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  COMPACT_PACK_SCHEMA_VERSION,
  type Duration,
  encodeGenerationPack,
  type GenerationPackHeader,
  type InvalidationState,
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

import { DATA_RECORD_SCHEMA_VERSION, type DataRecord } from './data-record.ts';
import { condemnedOf } from './generations.ts';
import { BlobLengthError, type BlobStore, type CarriedValue } from './io.ts';
import type { PackHeaderFields } from './pack-header-fields.ts';
import {
  type EntryRow,
  generationHeaders,
  generationOutputs,
  type GenerationRow,
  toGeneration,
} from './rows.ts';
import { staticPageHeadersOf, staticPagePrivacyOf } from './static-page-privacy.ts';

export type { DataRecord } from './data-record.ts';
export type { PackHeaderFields } from './pack-header-fields.ts';

/**
 * The records the authority projects out of its tables: the delivery record of an entry (the pack
 * the edge reads, or the data record the gateway reads). Bytes are read back from storage and
 * checked against the digest the generation recorded before they are laid out.
 */

/** The roles whose bytes travel inside the record itself; the rest are read through the authority. */
const RECORD_BODY_ROLES: ReadonlySet<string> = new Set(['html', 'route-body']);
const RECORD_STATE_ROLE = 'postponed';
const ROLE_HTML = 'html';
const ROLE_ROUTE_BODY = 'route-body';
const ROLE_POSTPONED = RECORD_STATE_ROLE;
const EMPTY = new Uint8Array(0);
const SHA256_HEX_LENGTH = 64;
/** An absent body has no digest to project; any SHA-256 occupies the same JSON width. */
const ANY_DIGEST = '0'.repeat(SHA256_HEX_LENGTH);
/** No number prints wider in JSON than this one does: `-1.7976931348623157e+308`. */
const WIDEST_NUMBER = -Number.MAX_VALUE;

export interface RecordDeps {
  readonly blobs: BlobStore;
  readonly scopeId: string;
  /** Observe only actual reads and successful digest checks; carried or referenced data bypass it. */
  readonly verifying?:
    | ((
        artifact: Pick<RecordArtifact, 'sha256' | 'storageRef' | 'byteLength'>,
      ) => (() => void) | undefined)
    | undefined;
  /** Immutable scope identity, retained by the authority rather than read for each projection. */
  readonly buildId?: string | undefined;
  readonly packSchemaVersion?: 1 | 2 | undefined;
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

async function verifiedBytes(deps: RecordDeps, artifact: RecordArtifact): Promise<Uint8Array> {
  const verified = deps.verifying?.(artifact);
  let bytes: Uint8Array | undefined;
  try {
    bytes = await deps.blobs.read(artifact.storageRef, artifact.byteLength);
  } catch (error) {
    if (!(error instanceof BlobLengthError)) throw error;
    throw new InvalidArtifactError(
      `artifact ${artifact.sha256} (${artifact.role}) has ${error.byteLength} bytes, not ${artifact.byteLength}`,
      artifact,
      { cause: error },
    );
  }
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
  verified?.();
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
  const staticPagePrivacy = staticPagePrivacyOf(fields, digests);
  return {
    schemaVersion:
      fields.packSchemaVersion === COMPACT_PACK_SCHEMA_VERSION
        ? COMPACT_PACK_SCHEMA_VERSION
        : PACK_SCHEMA_VERSION,
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
    headers: staticPagePrivacy === undefined ? generation.headers : staticPageHeadersOf(fields),
    tags: [...generation.tags],
    ...digests,
    ...(staticPagePrivacy !== undefined && { staticPagePrivacy }),
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
      htmlSha256: primary?.sha256 ?? ANY_DIGEST,
      htmlLength: primary?.byteLength ?? 0,
      postponedSha256: postponed?.sha256 ?? null,
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
  {
    scopeId,
    buildId,
    packSchemaVersion,
  }: Pick<RecordDeps, 'scopeId' | 'buildId' | 'packSchemaVersion'>,
  entry: EntryRow,
  generation: GenerationRow,
  outputs: readonly OutputSnapshot[],
): PackHeaderFields {
  const parsed = toGeneration(scopeId, generation);
  return {
    scopeId,
    buildId,
    packSchemaVersion,
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
 * out, using the recorded digests to retain any digest-dependent header fields.
 */
export function recordBytesOf(
  scopeId: string,
  entry: EntryRow,
  generation: GenerationRow,
  identity: Pick<RecordDeps, 'buildId' | 'packSchemaVersion'> | string = {},
): number {
  const outputs = generationOutputs(generation);
  const { primary, postponed } = recordBodies(outputs);
  const htmlLength = primary?.byteLength ?? 0;
  const postponedLength = postponed?.byteLength ?? 0;
  const header = packHeaderOf(
    headerFieldsOf(
      { scopeId, ...(typeof identity === 'string' ? { buildId: identity } : identity) },
      entry,
      generation,
      outputs,
    ),
    { revision: entry.record_revision, condemned: condemnedOf(generation) },
    {
      htmlSha256: primary?.sha256 ?? ANY_DIGEST,
      htmlLength,
      postponedSha256: postponed?.sha256 ?? null,
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
  identity: Pick<RecordDeps, 'buildId' | 'packSchemaVersion'> | string = {},
): number {
  if (!entry.kind.startsWith('data:')) {
    return packMemoryOf(recordBytesOf(scopeId, entry, generation, identity));
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
  const readingHtml = primary === undefined ? EMPTY : verifiedBytes(deps, primary);
  const readingState = postponed === undefined ? undefined : verifiedBytes(deps, postponed);
  try {
    const [html, state] = await Promise.all([readingHtml, readingState]);
    const header = packHeaderOf(
      headerFieldsOf(deps, entry, generation, outputs),
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
  deps: RecordDeps,
  artifact: RecordArtifact,
  carried: CarriedValue | undefined,
): Promise<Uint8Array> {
  return carried?.sha256 === artifact.sha256 && carried.bytes.byteLength === artifact.byteLength
    ? carried.bytes
    : verifiedBytes(deps, artifact);
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
      ? { kind: 'inline', base64: toBase64(await inlineBytes(deps, artifact, carried)) }
      : {
          kind: 'ref',
          artifactId: artifact.artifactId,
          storageRef: artifact.storageRef,
          byteLength: artifact.byteLength,
        };
  return dataRecordOf(deps.scopeId, entry, generation, value);
}
