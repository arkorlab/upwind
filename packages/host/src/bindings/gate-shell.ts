import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';

/**
 * A gate's own shell of a document of its route (`GATE_SHELL`): the head of the page, which the
 * edge sends first, and the state the route's Function resumes from to render the rest behind it,
 * which the edge completes as it completes a generation of the route. A gate answers with one laid
 * out as a generation's record is: a magic, a version, the length of the header after them, the
 * header as JSON in UTF-8, then the two byte ranges the header measures — the shell's bytes and the
 * postponed state's.
 *
 *   `UPSH` | version (u8) | header length (u32, little-endian) | header | html | postponed
 *
 * Here rather than in the edge alone, as a host makes what its gates answer with, and reads what a
 * gate was answered with in its tests. A shell the edge cannot read whole is none: anything this
 * refuses is answered as a gate that cannot answer is, before any byte.
 */

/** What a gate's answer that is a shell says it is (`content-type`). */
export const GATE_SHELL_CONTENT_TYPE = 'application/vnd.upwind.shell';
/** The layout this reads and writes: a shell of any other version is none it can serve. */
export const GATE_SHELL_VERSION = 1;
const KIB = 1024;
const MIB = KIB * KIB;
const HEADER_LIMIT_KIB = 64;
const SHELL_LIMIT_MIB = 8;
/** The most a shell's header may take: far past the headers, the route and the token it holds. */
export const MAX_GATE_SHELL_HEADER_BYTES = HEADER_LIMIT_KIB * KIB;
/**
 * The most a shell may take, its header and both its bodies: far past a page's head and its
 * postponed state, and what the edge holds of a request while it reads one whole before its first
 * byte.
 */
export const MAX_GATE_SHELL_BYTES = SHELL_LIMIT_MIB * MIB;

const MAGIC = 'UPSH';
const MAGIC_LENGTH = MAGIC.length;
const VERSION_LENGTH = 1;
const HEADER_LENGTH_FIELD = 4;
const PREFIX_LENGTH = MAGIC_LENGTH + VERSION_LENGTH + HEADER_LENGTH_FIELD;

/** What a gate's shell says of itself, ahead of its bytes. */
export interface GateShellHeader {
  /** The status the shell's render answered with: the edge composes a document under 200 alone. */
  readonly status: number;
  /** What the document goes out with, each name lower-cased, replayed as a generation's are. */
  readonly headers: Readonly<Record<string, string>>;
  /** The route the Function resumes the state as (`/hubs/[projectId]`), not the pathname asked. */
  readonly route: string;
  readonly htmlLength: number;
  /** Never none: a shell is completed by its resume, and a page complete in itself is no shell. */
  readonly postponedLength: number;
  /**
   * What the gate hands the resume beside its request (`GATE_RESUME_HEADER`), as it wrote it:
   * printable ASCII with no space at either end, which a header carries as it is. None, absent.
   */
  readonly resume?: string | undefined;
  /** Which of the gate's shells of the route this is, counting from one, named on the document. */
  readonly seq: number;
  /** What the gate knows the shell's content by. */
  readonly id: string;
}

/** A gate's shell, read: what it says of itself, and its two bodies. */
export interface GateShell {
  readonly header: GateShellHeader;
  readonly html: Uint8Array;
  readonly postponed: Uint8Array;
}

export type DecodedGateShell =
  | { readonly kind: 'ok'; readonly shell: GateShell }
  | { readonly kind: 'malformed'; readonly reason: string };

/** What a shell's header says of it beside the lengths its bodies are measured at as it is laid out. */
export type GateShellFields = Omit<GateShellHeader, 'htmlLength' | 'postponedLength'>;

/** A field name as a shell names it: an RFC 9110 token, lower-cased. */
const HEADER_NAME = /^[\d!#$%&'*+.^_`a-z|~-]+$/u;
/** A field value `Headers` takes as it is: bytes, with no NUL and no line break among them. */
const HEADER_VALUE = /^[\t\u{20}-\u{7E}\u{80}-\u{FF}]*$/u;
/** What a header carries as it is written: visible ASCII and spaces. */
const PRINTABLE = /^[\u{20}-\u{7E}]+$/u;
/** A surrogate standing alone: what no well-formed text holds, and a URL takes for another. */
const LONE_SURROGATE = /\p{Cs}/u;

type Fields = Readonly<Record<string, unknown>>;

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A safe integer, which is also a finite number. */
function isInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isInteger(value) && value > 0;
}

/** A route as a header names it to the Function: a path, which escapes as a whole (`pathHeaders`). */
function isRoute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !LONE_SURROGATE.test(value);
}

/**
 * A token a header carries as the gate wrote it: printable, and with no space at either end, which
 * a header would lose.
 */
function isResumeToken(value: unknown): value is string {
  return typeof value === 'string' && PRINTABLE.test(value) && value.trim() === value;
}

/** The shell's headers, every name and value one a document can go out with; else `undefined`. */
function headersOf(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const headers: [string, string][] = [];
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== 'string' || !HEADER_NAME.test(name) || !HEADER_VALUE.test(field)) {
      return undefined;
    }
    headers.push([name, field]);
  }
  return Object.fromEntries(headers);
}

/**
 * The header a shell holds, checked field by field and handed back with the fields it names alone;
 * `undefined` for one that lacks one, or holds one no shell can. What is checked is JSON as a reader
 * parses it, so an absent `resume` is one the header does not name.
 */
function headerOf(value: unknown): GateShellHeader | undefined {
  if (!isFields(value)) {
    return undefined;
  }
  const { status, headers: named, route, htmlLength, postponedLength, resume, seq, id } = value;
  const headers = headersOf(named);
  if (headers === undefined || typeof id !== 'string' || id === '') {
    return undefined;
  }
  if (
    !isInteger(status) ||
    !isRoute(route) ||
    !isCount(htmlLength) ||
    !isPositive(postponedLength) ||
    !isPositive(seq) ||
    (resume !== undefined && !isResumeToken(resume))
  ) {
    return undefined;
  }
  return {
    status,
    headers,
    route,
    htmlLength,
    postponedLength,
    ...(resume !== undefined && { resume }),
    seq,
    id,
  };
}

type ParsedHeader =
  | { readonly ok: true; readonly header: GateShellHeader }
  | { readonly ok: false; readonly reason: string };

function parseHeader(bytes: Uint8Array): ParsedHeader {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, reason: 'header is not JSON' };
  }
  const header = headerOf(json);
  return header === undefined
    ? { ok: false, reason: 'header holds no shell' }
    : { ok: true, header };
}

/** What a gate's answer names that a host's fetch leaves it as it was written in (`reachesUncoded`). */
const UNDONE_CODINGS: ReadonlySet<string> = new Set(['', 'br', 'gzip', 'identity']);

/**
 * Whether a gate's answer reaches its host as it was written, whatever coding its `headers` name: a
 * host's `fetch` undoes gzip and br as it reads one and keeps the header, as workerd's does; no host
 * undoes any other coding of a shell, which a gate answers in none.
 */
export function reachesUncoded(headers: Headers): boolean {
  return UNDONE_CODINGS.has((headers.get('content-encoding') ?? '').trim().toLowerCase());
}

function startsWithMagic(bytes: Uint8Array): boolean {
  for (let index = 0; index < MAGIC_LENGTH; index += 1) {
    if (bytes[index] !== MAGIC.codePointAt(index)) {
      return false;
    }
  }
  return true;
}

function malformed(reason: string): DecodedGateShell {
  return { kind: 'malformed', reason };
}

/**
 * The shell a gate's answer holds, its bodies views of `bytes`; or why it holds none: no magic, a
 * version this does not read, a header past its bound or not one, bodies that do not add up to what
 * is there, or more than a shell may take.
 */
export function decodeGateShell(bytes: Uint8Array): DecodedGateShell {
  if (bytes.byteLength > MAX_GATE_SHELL_BYTES) {
    return malformed('larger than a shell may be');
  }
  if (bytes.byteLength < PREFIX_LENGTH || !startsWithMagic(bytes)) {
    return malformed('not a gate shell');
  }
  const version = bytes[MAGIC_LENGTH];
  if (version !== GATE_SHELL_VERSION) {
    return malformed(`version ${String(version)} is not one this reads`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC_LENGTH + VERSION_LENGTH, true);
  if (headerLength > MAX_GATE_SHELL_HEADER_BYTES) {
    return malformed('header larger than a header may be');
  }
  const headerEnd = PREFIX_LENGTH + headerLength;
  if (headerEnd > bytes.byteLength) {
    return malformed('header length exceeds the shell');
  }
  const parsed = parseHeader(bytes.subarray(PREFIX_LENGTH, headerEnd));
  if (!parsed.ok) {
    return malformed(parsed.reason);
  }
  const { header } = parsed;
  const htmlEnd = headerEnd + header.htmlLength;
  if (htmlEnd + header.postponedLength !== bytes.byteLength) {
    return malformed('body lengths do not add up to the shell');
  }
  return {
    kind: 'ok',
    shell: {
      header,
      html: bytes.subarray(headerEnd, htmlEnd),
      postponed: bytes.subarray(htmlEnd),
    },
  };
}

/**
 * Lay a shell out, its header measuring the two bodies it is written with. One a reader would
 * refuse — a field no shell holds, no postponed state, a header or a whole past its bound — is a
 * programming error, and is thrown rather than written.
 */
export function encodeGateShell(
  fields: GateShellFields,
  html: Uint8Array,
  postponed: Uint8Array,
): Uint8Array {
  const header = headerOf({
    ...fields,
    htmlLength: html.byteLength,
    postponedLength: postponed.byteLength,
  });
  if (header === undefined) {
    throw new Error('a gate shell holds every field in the form a reader takes, and a resume');
  }
  const headerBytes = encodeUtf8(JSON.stringify(header));
  if (headerBytes.byteLength > MAX_GATE_SHELL_HEADER_BYTES) {
    throw new Error('gate shell header too large');
  }
  const prefix = new Uint8Array(PREFIX_LENGTH);
  prefix.set(encodeUtf8(MAGIC), 0);
  prefix[MAGIC_LENGTH] = GATE_SHELL_VERSION;
  new DataView(prefix.buffer).setUint32(
    MAGIC_LENGTH + VERSION_LENGTH,
    headerBytes.byteLength,
    true,
  );
  // Refused before a byte of it is copied: a pack past the most it may take is never made.
  const size = prefix.byteLength + headerBytes.byteLength + html.byteLength + postponed.byteLength;
  if (size > MAX_GATE_SHELL_BYTES) {
    throw new Error('gate shell too large');
  }
  return concatBytes([prefix, headerBytes, html, postponed]);
}

/** Whether an answer's `content-type` says it is a gate's shell, whatever parameters it names. */
export function isGateShellType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === GATE_SHELL_CONTENT_TYPE;
}
