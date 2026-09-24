import { z } from 'zod';

import { sha256HexSchema } from '../artifact/artifact.ts';
import { sha256Hex } from '../artifact/hash.ts';
import { concatBytes, decodeUtf8, encodeUtf8 } from '../util/bytes.ts';
import { publicArtifactRefSchema } from './artifacts.ts';
import { invalidationStateSchema } from './freshness.ts';
import { generationTagSchema, MAX_TAGS_PER_ENTRY, routeEntryKindSchema } from './keys.ts';
import { cachePolicySchema } from './timing.ts';

/** Whether a generation came out of a build or out of a regeneration at runtime. */
export const generationSourceKindSchema = z.enum(['build', 'runtime']);
export type GenerationSourceKind = z.infer<typeof generationSourceKindSchema>;

/**
 * The delivery record of an entry's current generation: what the edge reads, in one read.
 *
 * One KV value holds the small metadata a delivery decision needs, the document shell and the
 * postponed state the resume needs, so the shell's first byte never waits on a second lookup and
 * a shell is never paired with another generation's state. The layout is a fixed prefix — a magic,
 * a version, the header's length — then the header as JSON, then the two byte ranges the header
 * measures. A version this code does not know is `unsupported`, never a record to serve.
 */

export const PACK_SCHEMA_VERSION = 1;
const MAGIC = encodeUtf8('PPRG');
const MAGIC_LENGTH = MAGIC.byteLength;
const VERSION_LENGTH = 1;
const HEADER_LENGTH_FIELD = 4;
const PREFIX_LENGTH = MAGIC_LENGTH + VERSION_LENGTH + HEADER_LENGTH_FIELD;
const KIB = 1024;
const HEADER_LIMIT_KIB = 256;
/**
 * The most a header may take. Most of it is the generation's producer's to choose — the headers a
 * render replays, every output's key and artifacts, the route and the pathname — and nothing bounds
 * those on their way in, so the host measures a header (`packHeaderBytes`) before it
 * publishes the generation it would describe: a record that could not be laid out is one no
 * projection would ever write. A reader takes a longer one for corrupt.
 */
export const MAX_PACK_HEADER_BYTES = HEADER_LIMIT_KIB * KIB;
const PACK_LIMIT_MIB = 25;
/** A record is one KV value, and this is as large as one may be. */
export const MAX_PACK_BYTES = PACK_LIMIT_MIB * KIB * KIB;

/**
 * What a record of these two bodies would come to at most, asked before either is read.
 *
 * The header is allowed its whole ceiling rather than measured — whether it fits that is asked of
 * the header itself — so a commit that would make a record no KV value can hold is refused before
 * it is published: a record that cannot be written is one the edge never moves off the old
 * generation for, and every attempt to write it fails again.
 */
export function packBytesAtMost(htmlLength: number, postponedLength: number): number {
  return PREFIX_LENGTH + MAX_PACK_HEADER_BYTES + htmlLength + postponedLength;
}

/** An artifact as a record names it: the reference, and which of the generation's outputs it is. */
export const packArtifactRefSchema = publicArtifactRefSchema.extend({
  representationKey: z.string().min(1),
});
export type PackArtifactRef = z.infer<typeof packArtifactRefSchema>;

export const generationPackHeaderSchema = z.object({
  schemaVersion: z.literal(PACK_SCHEMA_VERSION),
  scopeId: z.string().min(1),
  entryId: z.string().min(1),
  generationId: z.string().min(1),
  seq: z.number().int().positive(),
  source: generationSourceKindSchema,
  kind: routeEntryKindSchema,
  route: z.string().startsWith('/'),
  pathname: z.string().startsWith('/'),
  cacheTimestamp: z.number().int().nullable(),
  producedAt: z.number().int().nullable(),
  policy: cachePolicySchema,
  status: z.number().int(),
  /**
   * What the entry is answered with, already filtered for the kind of entry it is
   * (`generationResponseHeaders`): a page's to what an edge-served shell may replay, and a
   * redirect's to where it leads as well; a route handler's — which only its Worker serves — to
   * what a response replayed whole may.
   */
  headers: z.record(z.string(), z.string()),
  /** Lifted from the render's own `x-next-cache-tags` before that header was filtered away. */
  tags: z.array(generationTagSchema).max(MAX_TAGS_PER_ENTRY),
  htmlSha256: sha256HexSchema,
  htmlLength: z.number().int().nonnegative(),
  /** `null` and a length of zero for a page complete at render time: nothing resumes it. */
  postponedSha256: sha256HexSchema.nullable(),
  postponedLength: z.number().int().nonnegative(),
  /**
   * The generation's other outputs (a page's data, the RSC payload, each prefetched segment);
   * read through the host, not from here. Each carries the key of the output it belongs to,
   * which is what a request for one of them names — the role alone cannot tell two segments apart.
   */
  artifacts: z.array(packArtifactRefSchema),
  /** The scope revision this record was written at. */
  revision: z.number().int().nonnegative(),
  invalidation: invalidationStateSchema.optional(),
});
export type GenerationPackHeader = z.infer<typeof generationPackHeaderSchema>;

export interface DecodedGenerationPack {
  readonly header: GenerationPackHeader;
  readonly html: Uint8Array;
  /** `undefined` when the header says there is none. */
  readonly postponed: Uint8Array | undefined;
}

export type DecodeGenerationPackResult =
  | { readonly kind: 'ok'; readonly pack: DecodedGenerationPack }
  | { readonly kind: 'unsupported'; readonly version: number }
  | { readonly kind: 'corrupt'; readonly reason: string };

function startsWithMagic(bytes: Uint8Array): boolean {
  for (let index = 0; index < MAGIC_LENGTH; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      return false;
    }
  }
  return true;
}

/** The header as a record lays it out. */
function encodePackHeader(header: GenerationPackHeader): Uint8Array {
  return encodeUtf8(JSON.stringify(header));
}

/** How many bytes a record lays this header out in: what `MAX_PACK_HEADER_BYTES` bounds. */
export function packHeaderBytes(header: GenerationPackHeader): number {
  return encodePackHeader(header).byteLength;
}

/**
 * Lay the record out. The header must measure the bytes it is stored with; a mismatch is a
 * programming error, and is thrown rather than written.
 */
export function encodeGenerationPack(
  header: GenerationPackHeader,
  html: Uint8Array,
  postponed: Uint8Array | undefined,
): Uint8Array {
  const postponedLength = postponed?.byteLength ?? 0;
  if (header.htmlLength !== html.byteLength || header.postponedLength !== postponedLength) {
    throw new Error('generation pack header does not measure its bytes');
  }
  const headerBytes = encodePackHeader(header);
  if (headerBytes.byteLength > MAX_PACK_HEADER_BYTES) {
    throw new Error('generation pack header too large');
  }
  const prefix = new Uint8Array(PREFIX_LENGTH);
  prefix.set(MAGIC, 0);
  prefix[MAGIC_LENGTH] = PACK_SCHEMA_VERSION;
  new DataView(prefix.buffer).setUint32(
    MAGIC_LENGTH + VERSION_LENGTH,
    headerBytes.byteLength,
    true,
  );
  return concatBytes([prefix, headerBytes, html, ...(postponed === undefined ? [] : [postponed])]);
}

type ParsedHeader =
  | { readonly ok: true; readonly header: GenerationPackHeader }
  | { readonly ok: false; readonly reason: string };

function parseHeader(bytes: Uint8Array): ParsedHeader {
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch {
    return { ok: false, reason: 'header is not JSON' };
  }
  const parsed = generationPackHeaderSchema.safeParse(json);
  return parsed.success
    ? { ok: true, header: parsed.data }
    : { ok: false, reason: 'header does not match its schema' };
}

export function decodeGenerationPack(bytes: Uint8Array): DecodeGenerationPackResult {
  if (bytes.byteLength < PREFIX_LENGTH || !startsWithMagic(bytes)) {
    return { kind: 'corrupt', reason: 'not a generation pack' };
  }
  const version = bytes[MAGIC_LENGTH] ?? 0;
  if (version !== PACK_SCHEMA_VERSION) {
    return { kind: 'unsupported', version };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC_LENGTH + VERSION_LENGTH, true);
  if (headerLength > MAX_PACK_HEADER_BYTES || PREFIX_LENGTH + headerLength > bytes.byteLength) {
    return { kind: 'corrupt', reason: 'header length exceeds the record' };
  }
  const headerEnd = PREFIX_LENGTH + headerLength;
  const parsed = parseHeader(bytes.subarray(PREFIX_LENGTH, headerEnd));
  if (!parsed.ok) {
    return { kind: 'corrupt', reason: parsed.reason };
  }
  const { header } = parsed;
  const htmlEnd = headerEnd + header.htmlLength;
  const postponedEnd = htmlEnd + header.postponedLength;
  if (postponedEnd !== bytes.byteLength) {
    return { kind: 'corrupt', reason: 'body lengths do not add up to the record' };
  }
  if ((header.postponedSha256 === null) !== (header.postponedLength === 0)) {
    return { kind: 'corrupt', reason: 'postponed state and its hash disagree' };
  }
  return {
    kind: 'ok',
    pack: {
      header,
      html: bytes.subarray(headerEnd, htmlEnd),
      postponed: header.postponedLength === 0 ? undefined : bytes.subarray(htmlEnd, postponedEnd),
    },
  };
}

/** Whether the bytes are the ones the header names. Run on a read from storage, not on a memory hit. */
export async function verifyGenerationPack(pack: DecodedGenerationPack): Promise<boolean> {
  if ((await sha256Hex(pack.html)) !== pack.header.htmlSha256) {
    return false;
  }
  if (pack.postponed === undefined) {
    return pack.header.postponedSha256 === null;
  }
  return (await sha256Hex(pack.postponed)) === pack.header.postponedSha256;
}

export interface PackBodyDigests {
  readonly htmlSha256: string;
  readonly htmlLength: number;
  readonly postponedSha256: string | null;
  readonly postponedLength: number;
}

/** The measurements a header must carry for these bytes. */
export async function packBodyDigests(
  html: Uint8Array,
  postponed: Uint8Array | undefined,
): Promise<PackBodyDigests> {
  return {
    htmlSha256: await sha256Hex(html),
    htmlLength: html.byteLength,
    postponedSha256: postponed === undefined ? null : await sha256Hex(postponed),
    postponedLength: postponed?.byteLength ?? 0,
  };
}
