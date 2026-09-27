/* eslint-disable @typescript-eslint/no-magic-numbers -- the signatures are the formats' own first bytes; the literals are the table. */
import { decodeUtf8 } from '../util/bytes.ts';

/**
 * What kind of image a source is, from its first bytes — never from a `content-type` header,
 * which a source may get wrong. The same table Next.js's optimizer reads (`detectContentType`),
 * and behind it the same allowance for an SVG that does not open with its root element: a byte
 * order mark, whitespace, a comment or a doctype ahead of `<svg …>` in the first kilobyte.
 */

export const JPEG = 'image/jpeg';
export const PNG = 'image/png';
export const GIF = 'image/gif';
export const WEBP = 'image/webp';
export const AVIF = 'image/avif';
export const SVG = 'image/svg+xml';
const ICO = 'image/x-icon';
const ICNS = 'image/x-icns';
const TIFF = 'image/tiff';
const BMP = 'image/bmp';
const JXL = 'image/jxl';
const HEIC = 'image/heic';

/** Bytes to read of a source before its type is known: what the SVG allowance looks through. */
export const IMAGE_SIGNATURE_BYTES = 1024;
/** Where the root element can begin, and what has to follow for its name to be `svg` and no longer. */
const SVG_TAG_START = '<svg';
const SVG_NAME_END = /\s/u;

/**
 * Whether the start tag whose attributes begin at `from` is closed within what was read.
 *
 * A quoted attribute value may hold the `>` that would otherwise end the tag, so a quote is followed
 * to its pair and the first `>` outside one closes it.
 */
function closesStartTag(text: string, from: number): boolean {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '>') {
      return true;
    } else if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return false;
}

/**
 * `<svg …>` anywhere in what was read, as Next.js's fallback detector finds it.
 *
 * Walked rather than matched. One pattern saying all of this is attempted again from every `<svg ` in
 * its subject, and on a subject of any size that is quadratic — `js/polynomial-redos`, which is what
 * a regular expression here would be reported for.
 *
 * This is quadratic too, and may be: the subject has a size. `detectImageType` reads
 * `IMAGE_SIGNATURE_BYTES` of a source and no further, and nothing else calls this, so the work is
 * bounded by that window whatever was fetched — a kilobyte, against the whole of a response.
 *
 * What the bound buys is every candidate rather than the first, which is the pattern's own answer: a
 * `<svg ` inside a comment ahead of the root, carrying a quote it never closes, does not get to
 * decide for the root that follows it.
 */
function hasSvgRoot(text: string): boolean {
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(SVG_TAG_START, from);
    if (start === -1) {
      return false;
    }
    const afterName = start + SVG_TAG_START.length;
    if (SVG_NAME_END.test(text[afterName] ?? '') && closesStartTag(text, afterName + 1)) {
      return true;
    }
    from = start + 1;
  }
  return false;
}

/** A byte the signature names, or `null` where it names none: the length of a RIFF or ISO box. */
type Signature = readonly (number | null)[];
const ANY = null;

const SIGNATURES: readonly (readonly [Signature, string])[] = [
  [[0xff, 0xd8, 0xff], JPEG],
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], PNG],
  [[0x47, 0x49, 0x46, 0x38], GIF],
  [[0x52, 0x49, 0x46, 0x46, ANY, ANY, ANY, ANY, 0x57, 0x45, 0x42, 0x50], WEBP],
  [[0x3c, 0x3f, 0x78, 0x6d, 0x6c], SVG],
  [[0x3c, 0x73, 0x76, 0x67], SVG],
  [[ANY, ANY, ANY, ANY, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], AVIF],
  [[0x00, 0x00, 0x01, 0x00], ICO],
  [[0x69, 0x63, 0x6e, 0x73], ICNS],
  [[0x49, 0x49, 0x2a, 0x00], TIFF],
  [[0x42, 0x4d], BMP],
  [[0xff, 0x0a], JXL],
  [[0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a], JXL],
  [[ANY, ANY, ANY, ANY, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], HEIC],
];

function matches(signature: Signature, bytes: Uint8Array): boolean {
  return signature.every((expected, index) => expected === ANY || bytes[index] === expected);
}

/** The image type the bytes begin with, or `undefined` for anything else. */
export function detectImageType(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) {
    return undefined;
  }
  const signed = SIGNATURES.find(([signature]) => matches(signature, bytes))?.[1];
  if (signed !== undefined) {
    return signed;
  }
  return hasSvgRoot(decodeUtf8(bytes.subarray(0, IMAGE_SIGNATURE_BYTES))) ? SVG : undefined;
}

/** Types Next.js serves as they are, whatever the request asked for. */
export const BYPASS_IMAGE_TYPES: ReadonlySet<string> = new Set([BMP, HEIC, ICNS, ICO, JXL, SVG]);

export type OutputImageType = typeof AVIF | typeof GIF | typeof JPEG | typeof PNG | typeof WEBP;

const KEPT_UPSTREAM_TYPES: ReadonlySet<string> = new Set([GIF, JPEG, PNG]);

function isKept(type: string): type is typeof GIF | typeof JPEG | typeof PNG {
  return KEPT_UPSTREAM_TYPES.has(type);
}

/**
 * The format to encode as: what the client negotiated, else the source's own when it is one an
 * encoder produces, else JPEG — as Next.js falls back for a source it cannot keep (TIFF, or a
 * WebP/AVIF the client did not ask for).
 */
export function outputImageType(negotiated: string, upstream: string): OutputImageType {
  if (negotiated === AVIF || negotiated === WEBP) {
    return negotiated;
  }
  return isKept(upstream) ? upstream : JPEG;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  [JPEG]: 'jpeg',
  [PNG]: 'png',
  [GIF]: 'gif',
  [WEBP]: 'webp',
  [AVIF]: 'avif',
  [SVG]: 'svg',
  [ICO]: 'ico',
  [ICNS]: 'icns',
  [TIFF]: 'tiff',
  [BMP]: 'bmp',
  [JXL]: 'jxl',
  [HEIC]: 'heic',
};

/** The file extension a type is known by, for the download filename. */
export function imageExtension(contentType: string): string | undefined {
  return Object.hasOwn(EXTENSIONS, contentType) ? EXTENSIONS[contentType] : undefined;
}
