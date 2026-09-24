import { encodeUtf8, endsWithBytesTrimmed } from './bytes.ts';

/** How every complete Next.js document ends (`createMoveSuffixStream` appends it last). */
export const CLOSE_BODY_AND_HTML = encodeUtf8('</body></html>');

/** Trailing whitespace tolerated after the closing tags; bounded so a streaming check can keep a fixed tail. */
export const MAX_TRAILING_WHITESPACE_BYTES = 50;

/** The number of trailing bytes that fully determines `documentTerminates`. */
export const TERMINATION_WINDOW_BYTES =
  CLOSE_BODY_AND_HTML.byteLength + MAX_TRAILING_WHITESPACE_BYTES;

/**
 * The one definition of "this document is complete", shared by the prover, the shadow validator
 * and the splice: the closing tags, ignoring up to `MAX_TRAILING_WHITESPACE_BYTES` of trailing
 * whitespace. The bound matters: the splice only ever sees the last `TERMINATION_WINDOW_BYTES`,
 * and a document the prover accepts must never be one the splice rejects.
 */
export function documentTerminates(body: Uint8Array): boolean {
  return endsWithBytesTrimmed(body, CLOSE_BODY_AND_HTML, MAX_TRAILING_WHITESPACE_BYTES);
}

const HTML_MEDIA_TYPE = 'text/html';

/**
 * The one definition of "this response carries an HTML document", shared by the splice and the
 * deployment monitor. The splice refuses anything else as `bad-upstream-response`, which is
 * telemetry and does not condemn the manifest — so a monitor that judged this differently would
 * keep calling a project healthy while every request for it got a recovery reload.
 */
export function isHtmlContentType(value: string | null): boolean {
  // The media type itself, not a prefix of the field: `text/htmlx` is its own type, and splicing
  // one under the shell's `text/html` would hand the browser a document it will not parse — with
  // `nosniff`, not even the recovery script that gets the visitor off it. Proof requires the same
  // exact match, so a route admitted there is one this accepts.
  const [type = ''] = (value ?? '').toLowerCase().split(';', 1);
  return type.trim() === HTML_MEDIA_TYPE;
}
