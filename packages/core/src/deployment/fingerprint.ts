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

const DATA_DPL_ID_PATTERN = /<html[^>]*\sdata-dpl-id="([^"]+)"/u;
/**
 * What ends a `/_next/static/` reference in a document.
 *
 * Quotes and whitespace end an attribute; a backslash ends one written inside the flight data,
 * where the same URLs appear again as `\"/_next/static/…\"`; angle brackets end an unquoted one.
 * None of them can occur in a URL unescaped, and a reference read one character too far is a path
 * that exists nowhere: `URL` turns a trailing backslash into a slash, so asset validation would ask
 * both sides for a directory and fail a healthy candidate on a 404 they agree about.
 */
const DPL_QUERY_PATTERN = /\/_next\/static\/[^"'\s)\\<>]*\?dpl=([\w-]+)/u;
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
    DATA_DPL_ID_PATTERN.exec(html)?.[1] ??
    DPL_QUERY_PATTERN.exec(html)?.[1] ??
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
