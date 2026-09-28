import { z } from 'zod';

import { sha256HexOfText } from '../artifact/hash.ts';
import { compareCodeUnits, decodeUtf8 } from '../util/bytes.ts';
import { scanFlightBuildId } from './flight-build-id.ts';

/**
 * Identity of the immutable Vercel deployment an artifact was captured from.
 *
 * - `dplId`: Vercel deployment id when Skew Protection exposes it (`data-dpl-id`, `?dpl=`).
 * - `buildId`: Next.js build id read from the flight data (`"b":"..."`), present in the continuation.
 * - `assetSetHash`: SHA-256 over the sorted set of `/_next/static/...` URLs referenced by the shell.
 */
export const deploymentFingerprintSchema = z.object({
  dplId: z.string().min(1).optional(),
  buildId: z.string().min(1).optional(),
  assetSetHash: z.string().min(1),
  observedAt: z.iso.datetime(),
});
export type DeploymentFingerprint = z.infer<typeof deploymentFingerprintSchema>;

const HTML_TAG_START = '<html';
const DATA_DPL_ID_PATTERN = /\sdata-dpl-id="([^"]+)"/u;
const STATIC_PATH = '/_next/static/';
const SCHEME_PATTERN = /^https?:\/\//u;
/** What ends a URL's authority: after one of these, nothing further is part of the host. */
const AUTHORITY_END_PATTERN = /[?#]/u;
const DPL_QUERY_PATTERN = /\?dpl=([\w-]+)/u;
/**
 * What ends a `/_next/static/` reference in a document.
 *
 * Quotes and whitespace end an attribute; a backslash ends one written inside the flight data,
 * where the same URLs appear again as `\"/_next/static/…\"`; angle brackets end an unquoted one.
 * None of them can occur in a URL unescaped, and a reference read one character too far is a path
 * that exists nowhere: `URL` turns a trailing backslash into a slash, so asset validation would ask
 * both sides for a directory and fail a healthy candidate on a 404 they agree about.
 */
const STATIC_ASSET_URL_PATTERN = /(?:https?:\/\/[^/"'\s\\<>]+)?\/_next\/static\/[^"'\s)\\<>]+/gu;
const KIB = 1024;
const BUILD_ID_SCAN_KIB = 64;
/**
 * UTF-8 decoding window, also used by the edge as its continuation admission byte budget.
 *
 * Full-document probes can scan subsequent windows, but the edge holds the suffix back for at
 * most this many bytes before it decides. The parser does not extend that delivery budget.
 */
export const BUILD_ID_SCAN_LIMIT = BUILD_ID_SCAN_KIB * KIB;

export interface ShellFingerprintInput {
  readonly shell: Uint8Array;
  readonly responseHeaders?: Headers | undefined;
  readonly observedAt: string;
}

/**
 * `data-dpl-id` on the document's own `<html>` tag, where Skew Protection writes it.
 *
 * Each `<html` is read only as far as the `>` that ends its tag, and the next is looked for after
 * that `>`. One pattern that found `<html` and scanned on to the attribute would instead rescan the
 * rest of the document from every `<html` in it, and a document is somebody else's to write: that
 * is quadratic in what they send. Here the regions are disjoint, so the whole document is read once.
 *
 * A tag with no `>` yet is read to the end of what there is, because a shell can be a prefix of the
 * response it came from and the attribute is the first thing on the tag.
 */
function dplIdFromHtmlTag(html: string): string | undefined {
  let from = 0;
  while (from < html.length) {
    const start = html.indexOf(HTML_TAG_START, from);
    if (start === -1) {
      return undefined;
    }
    const end = html.indexOf('>', start);
    const dplId = DATA_DPL_ID_PATTERN.exec(
      end === -1 ? html.slice(start) : html.slice(start, end),
    )?.[1];
    if (dplId !== undefined || end === -1) {
      return dplId;
    }
    from = end + 1;
  }
  return undefined;
}

/**
 * Where a reference's `/_next/static/…` path begins, or `undefined` if that text is not its path.
 *
 * `STATIC_ASSET_URL_PATTERN` reads a reference by its characters and cannot tell a path from a host
 * that merely looks like one, because `?`, `=` and `#` are all characters it allows a host: both
 * `https://host?dpl=x/_next/static/a.js` and `https://host?next=/_next/static/a.js?dpl=x` are one
 * reference to it. In neither does the deployment own that query — the first `?` ended the authority,
 * so everything after it is what the author of that text wrote, about something else.
 *
 * So the authority is where a URL says it is: from `://` to the first `/`, and only if nothing ended
 * it sooner. A reference with no scheme is a path already.
 */
function staticAssetPath(url: string): string | undefined {
  const scheme = SCHEME_PATTERN.exec(url);
  if (scheme === null) {
    return url.startsWith(STATIC_PATH) ? url : undefined;
  }
  const path = url.indexOf('/', scheme[0].length);
  if (path === -1 || AUTHORITY_END_PATTERN.test(url.slice(scheme[0].length, path))) {
    return undefined;
  }
  const rest = url.slice(path);
  return rest.startsWith(STATIC_PATH) ? rest : undefined;
}

/**
 * `?dpl=` on the first asset reference that carries one, as Skew Protection appends it.
 *
 * Read off the references already collected rather than searched for again: every `?dpl=` on an
 * asset sits inside one of them, since `STATIC_ASSET_URL_PATTERN` ends a reference on the same
 * characters, and they are held in the order the document mentions them. So this is the match a
 * second scan of the document would have found first, without the second scan.
 *
 * Read from the reference's path and no earlier, for the reason above. The first `?dpl=` in that path
 * is the one, because the first `?` is where a query begins and a second is a character inside the
 * value it opened. A reference carrying two is malformed either way, and nobody who can write one
 * into a document is short of ways to write the value.
 */
function dplIdFromAssetUrls(urls: Iterable<string>): string | undefined {
  for (const url of urls) {
    const path = staticAssetPath(url);
    const dplId = path === undefined ? undefined : DPL_QUERY_PATTERN.exec(path)?.[1];
    if (dplId !== undefined) {
      return dplId;
    }
  }
  return undefined;
}

/** Extract the deployment fingerprint that can be read from the shell bytes and headers alone. */
export async function extractShellFingerprint(
  input: ShellFingerprintInput,
): Promise<DeploymentFingerprint> {
  const html = decodeUtf8(input.shell);
  const assetUrls = new Set<string>();
  for (const match of html.matchAll(STATIC_ASSET_URL_PATTERN)) {
    assetUrls.add(match[0]);
  }
  const assetSetHash = await sha256HexOfText([...assetUrls].toSorted(compareCodeUnits).join('\n'));
  const fingerprint: DeploymentFingerprint = { assetSetHash, observedAt: input.observedAt };
  const dplId =
    dplIdFromHtmlTag(html) ??
    dplIdFromAssetUrls(assetUrls) ??
    input.responseHeaders?.get('x-nextjs-deployment-id') ??
    undefined;
  if (dplId !== undefined) {
    fingerprint.dplId = dplId;
  }
  return fingerprint;
}

/**
 * Read the Next.js build id from a continuation, or from a full document.
 *
 * The flight row zero carries a top-level `b` string, after the nested route data in Next.js 16.3.
 * It may span several escaped `self.__next_f.push` strings; in a full document it can occur
 * wherever the shell happens to end.
 * Scanning only the first window would miss it for any shell larger than that, and a server-only
 * deployment that reuses its client assets would then compare as unchanged and keep a stale shell
 * serving. Scan the whole buffer with bounded memory, preserving the string and nesting state
 * across windows and inline chunks without retaining the route tree or other application data.
 */
export function extractBuildIdFromContinuation(bytes: Uint8Array): string | undefined {
  return scanFlightBuildId(bytes, BUILD_ID_SCAN_LIMIT);
}

export type FingerprintComparison =
  | { readonly equal: true; readonly via: 'dpl' | 'buildId' | 'assetSet' }
  | { readonly equal: false; readonly via: 'dpl' | 'buildId' | 'assetSet' };

/**
 * Compare two fingerprints with precedence dpl > buildId > assetSet.
 *
 * A marker one side carries and the other does not is a difference, not a reason to look further
 * down. The asset set is the weakest evidence there is — a server-only deployment reuses every
 * client asset — so falling back to it when an expected id has gone missing would report an
 * unidentifiable response as proof that nothing changed, and activate a shell from before it.
 */
export function compareFingerprints(
  a: DeploymentFingerprint,
  b: DeploymentFingerprint,
): FingerprintComparison {
  if (a.dplId !== undefined || b.dplId !== undefined) {
    return { equal: a.dplId === b.dplId, via: 'dpl' };
  }
  if (a.buildId !== undefined || b.buildId !== undefined) {
    return { equal: a.buildId === b.buildId, via: 'buildId' };
  }
  return { equal: a.assetSetHash === b.assetSetHash, via: 'assetSet' };
}

/** Stable identity string used as a database key for a deployment. */
export function fingerprintId(fingerprint: DeploymentFingerprint): string {
  return fingerprint.dplId ?? fingerprint.buildId ?? `assets:${fingerprint.assetSetHash}`;
}
