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
/** `<svg` and the whitespace that has to follow it: where the root element can begin. */
const SVG_ROOT_START = /<svg\s/u;

/**
 * `<svg …>` anywhere in what was read, as Next.js's fallback detector finds it.
 *
 * The start tag is walked rather than matched, because the pattern that matches it — attributes,
 * with a quoted value allowed to hold the `>` that would otherwise end the tag — is attempted again
 * from every `<svg ` in the source, and the source is whatever was fetched. Each character here is
 * looked at once: a quote is skipped to its pair, and the first `>` outside one ends the tag.
 *
 * Only the first `<svg ` is read, and reading one character once is what that buys. So a source
 * whose first `<svg ` opens a quote that never closes is not an image here, where the pattern would
 * have gone on to try a later `<svg `. That answer is never the less careful one: this says `<svg …>`
 * only where the pattern did, and a source it cannot name is refused rather than served
 * (`image-fallback.ts`), which is also what the `dangerouslyAllowSVG` gate behind this wants.
 */
function hasSvgRoot(text: string): boolean {
  const start = SVG_ROOT_START.exec(text);
  if (start === null) {
    return false;
  }
  let quote: string | undefined;
  for (let index = start.index + start[0].length; index < text.length; index += 1) {
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
